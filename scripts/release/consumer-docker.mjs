import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { demand } from './consumer-schema.mjs';
import { hash } from './workspace.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
export const tools = JSON.parse(await readFile(new URL('./consumer-tools.json', import.meta.url), 'utf8'));
const label = 'org.redemeine.consumer-run';
const cancellation = new AsyncLocalStorage();
let dockerConfig;

function privateDockerConfig() {
  if (dockerConfig) return dockerConfig;
  const directory = mkdtempSync(resolve(tmpdir(), 'redemeine-docker-'));
  // Keep CLI state through resource cleanup and final inspections. SIGKILL cannot run exit handlers.
  process.once('exit', (code) => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      console.error(`Docker CLI config cleanup failed: ${error.message}`);
      process.exitCode = code || Number(process.exitCode) || 1;
    }
  });
  chmodSync(directory, 0o700);
  const stat = statSync(directory);
  demand(stat.isDirectory() && (stat.mode & 0o777) === 0o700 && stat.uid === process.geteuid(), 'Unsafe Docker CLI config directory');
  dockerConfig = directory;
  return directory;
}

export const withDockerSignal = (signal, action) => cancellation.run(signal, action);

export async function docker(args, timeout = 120000) {
  const env = { PATH: process.env.PATH, HOME: '/nonexistent', DOCKER_CONFIG: privateDockerConfig() };
  const { stdout } = await execute('docker', args, { env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, signal: cancellation.getStore() });
  return stdout.trim();
}

export function dockerRun(output, report) {
  return { id: `consumer-${randomUUID()}`, output, report, containers: [], networks: [], imageTags: [], label };
}

export async function network(state, internal) {
  const id = await docker([
    'network',
    'create',
    '--label',
    `${label}=${state.id}`,
    ...(internal ? ['--internal'] : []),
    `${state.id}-${state.networks.length}`
  ]);
  state.networks.push(id);
  return id;
}

export async function createContainer(state, image, networkId, args = [], command = []) {
  const id = await docker([
    'create',
    '--platform',
    tools.platform,
    '--label',
    `${label}=${state.id}`,
    '--network',
    networkId,
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    ...args,
    image,
    ...command
  ]);
  state.containers.push(id);
  return id;
}

export async function inspectOwned(state, id, expectedNetwork, expectedImage, registry = false) {
  const [item] = JSON.parse(await docker(['inspect', id]));
  demand(item.Config.Labels[label] === state.id && item.Image === expectedImage, 'Container identity mismatch');
  const mountsSafe = registry
    ? item.Mounts.length === 1 && item.Mounts[0].Type === 'volume' && item.Mounts[0].Destination === '/verdaccio/storage'
    : item.Mounts.length === 0;
  demand(mountsSafe && !item.HostConfig.Privileged && item.HostConfig.NetworkMode !== 'host', 'Unsafe container mounts/privileges');
  const networks = Object.values(item.NetworkSettings.Networks);
  demand(
    item.HostConfig.NetworkMode === expectedNetwork &&
      networks.length === 1 &&
      (networks[0].NetworkID === expectedNetwork || (!item.State.Running && networks[0].NetworkID === '')),
    'Unexpected container network'
  );
  demand(
    Object.values(item.NetworkSettings.Ports || {}).every((ports) => ports === null),
    'Unexpected exposed host port'
  );
  return { id, image: item.Image, network: expectedNetwork, mounts: item.Mounts, labels: item.Config.Labels };
}

export async function provision(state) {
  const context = resolve(state.output, 'image-context');
  const files = ['scripts/release/test/Consumer.Dockerfile', 'scripts/release/consumer-tools.json', 'scripts/release/consumer-runtime/provision.mjs'];
  for (const file of files) {
    await mkdir(dirname(resolve(context, file)), { recursive: true, mode: 0o700 });
    await copyFile(resolve(root, file), resolve(context, file));
  }
  const images = [];
  state.report.images = images;
  for (const node of tools.nodes) {
    const tag = `${state.id}:node-${node.version}`;
    const image = { ...node, tag };
    state.imageTags.push(image);
    images.push(image);
    const log = await docker(
      ['build', '--platform', tools.platform, '--build-arg', `BASE=${node.image}`, '-t', tag, '-f', resolve(context, files[0]), context],
      240000
    );
    const id = JSON.parse(await docker(['image', 'inspect', tag]))[0].Id;
    image.id = id;
    const versions = await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--platform',
      tools.platform,
      id,
      'node',
      '-e',
      'console.log(JSON.stringify({node:process.versions.node,npm:require("/usr/local/lib/node_modules/npm/package.json").version,typescript:require("/opt/consumer-tools/node_modules/typescript/package.json").version}))'
    ]);
    const actual = JSON.parse(versions);
    demand(actual.node === node.version && actual.npm === tools.npm.version && actual.typescript === tools.typescript, 'Consumer tool version mismatch');
    await writeFile(resolve(state.output, `provision-${node.version}.log`), log, { mode: 0o600 });
    Object.assign(image, { actual, logSha256: hash(log) });
  }
  return images;
}

export const cleanup = (state) => withDockerSignal(undefined, () => cleanupOwned(state));

async function cleanupOwned(state) {
  const failures = [];
  state.report.resourceOutcomes = [];
  // A cancelled Docker create may have succeeded in the daemon before its ID reached the client.
  const filter = `label=${label}=${state.id}`;
  const containers = (await docker(['ps', '-aq', '--filter', filter])).split('\n').filter(Boolean);
  const networks = (await docker(['network', 'ls', '-q', '--filter', filter])).split('\n').filter(Boolean);
  state.containers = containers;
  state.networks = networks;
  for (const id of state.containers.reverse()) {
    try {
      const [item] = JSON.parse(await docker(['inspect', id]));
      demand(item.Config.Labels[label] === state.id, 'Refusing cleanup of foreign container');
      state.report.resourceOutcomes.push({ id: item.Id, running: item.State.Running, oomKilled: item.State.OOMKilled, exitCode: item.State.ExitCode });
      await docker(['rm', '-fv', id]);
    } catch {
      failures.push({ resource: id, operation: 'container cleanup' });
    }
  }
  for (const id of state.networks.reverse()) {
    try {
      const [item] = JSON.parse(await docker(['network', 'inspect', id]));
      demand(item.Labels[label] === state.id, 'Refusing cleanup of foreign network');
      await docker(['network', 'rm', id]);
    } catch {
      failures.push({ resource: id, operation: 'network cleanup' });
    }
  }
  await cleanupImages(state, failures);
  state.report.cleanup = { complete: failures.length === 0, failures };
  return failures.length === 0;
}

async function cleanupImages(state, failures) {
  state.report.imageCleanup = [];
  for (const image of state.imageTags) {
    try {
      demand(
        tools.nodes.some((node) => image.tag === `${state.id}:node-${node.version}`),
        'Refusing cleanup of foreign image tag'
      );
      const found = await docker(['image', 'ls', '-q', '--no-trunc', '--filter', `reference=${image.tag}`]);
      if (!found) continue;
      demand(!image.id || found === image.id, 'Image tag identity changed');
      // Tags can share cached layers or another run's image ID: never force-remove by ID or prune.
      await docker(['image', 'rm', image.tag]);
      state.report.imageCleanup.push({ tag: image.tag, id: found, removed: true });
    } catch {
      failures.push({ resource: image.tag, operation: 'image tag cleanup' });
    }
  }
}
