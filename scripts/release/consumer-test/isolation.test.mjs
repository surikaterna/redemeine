import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { docker } from '../consumer-docker.mjs';
import { runConsumer } from '../consumer-runner.mjs';
import { registryConfig, stage } from '../quarantine.mjs';
import { manifest, packageArchive, put } from '../test/fixtures.mjs';
import { hash, sri } from '../workspace.mjs';
import { consumerHarness } from './harness.mjs';

async function proxyTo(primary, upstream) {
  await docker(['network', 'connect', upstream.registry.internal, primary.registry.id]);
  const config = registryConfig(primary.input.graph.owned, true);
  config.uplinks.npmjs.url = upstream.registry.endpoint;
  const file = resolve(primary.state.output, 'fault-proxy.json');
  await writeFile(file, JSON.stringify(config), { mode: 0o644 });
  await docker(['cp', file, `${primary.registry.id}:/verdaccio/conf/config.yaml`]);
  await docker(['restart', primary.registry.id]);
  await docker([
    'exec',
    primary.registry.id,
    'node',
    '-e',
    `(async()=>{for(let i=0;i<50;i++){try{
    if((await fetch('http://127.0.0.1:4873/-/ping')).ok)return;
    }catch{} await new Promise(r=>setTimeout(r,100));}throw Error('registry readiness');})()`
  ]);
}

async function externalFault(upstream) {
  const [item] = JSON.parse(await docker(['inspect', upstream.registry.id]));
  const ip = Object.values(item.NetworkSettings.Networks)[0].IPAddress;
  const target = `http://${ip}:4873/escape-target/-/escape-target-1.0.0.tgz`;
  const artifact = upstream.input.artifacts.find((a) => a.manifest.name === 'external-dependency');
  const pkg = { ...artifact.manifest, dependencies: { 'escape-target': target } };
  // Test-only transitive fault after VALID A preflight; never exposed as a production bypass.
  const bytes = packageArchive(pkg);
  await writeFile(artifact.copy, bytes);
  Object.assign(artifact, { manifest: pkg, sha256: hash(bytes), integrity: sri(bytes) });
  upstream.state.report.fault = { kind: 'external transitive URL', target, sha256: hash(bytes) };
  return target;
}

test('npm external-transitive tarball URL cannot escape consumer network; official outside target is reachable by proxy control', {
  timeout: 600000
}, async (t) => {
  const upstream = await consumerHarness(t, [manifest('external-dependency'), manifest('escape-target')], [], undefined, false);
  const target = await externalFault(upstream);
  await stage(upstream.state, upstream.input, upstream.selection, upstream.registry, upstream.images[0]);
  const h = await consumerHarness(t, [manifest('@fixture/root', { dependencies: { 'external-dependency': '1.0.0' } })]);
  await stage(h.state, h.input, h.selection, h.registry, h.images[0]);
  await proxyTo(h, upstream);
  try {
    const positive = await docker([
      'exec',
      h.registry.id,
      'node',
      '-e',
      `fetch(${JSON.stringify(target)},{redirect:'error'}).then(r=>{console.log(r.status);return r.arrayBuffer();})`
    ]);
    assert.equal(positive, '200');
    const before = await docker(['logs', upstream.registry.id]);
    for (const image of h.images) await assert.rejects(runConsumer(h.state, h.input, h.selection, h.registry, image, h.plans), (error) => error.code === 2);
    const requests = (await docker(['logs', upstream.registry.id])).slice(before.length);
    assert(requests.includes('external-dependency'), 'External metadata control must really be proxied');
    assert(!requests.includes('escape-target'), 'Transitive direct tarball escaped isolated network');
    assert(h.state.report.consumers.every((c) => c.commands.some((command) => command.log.includes(target))));
    h.state.report.externalUrlProof = { target, positive: 200, directRequests: 0, requestsSha256: hash(requests) };
    await writeFile(resolve(h.state.output, 'outside-requests.log'), requests);
  } finally {
    await docker(['network', 'disconnect', upstream.registry.internal, h.registry.id]);
  }
});

async function cacheTrap(h, source) {
  const root = h.fixture.root;
  const cache = resolve(root, 'warm-cache');
  await docker(['cp', `${source.identity.id}:/home/consumer/cache`, cache]);
  const packageDir = resolve(root, 'host-workspace/optional');
  await put(resolve(packageDir, 'package.json'), manifest('@fixture/optional'));
  await put(resolve(packageDir, 'dist/index.js'), "throw Error('HOST_WORKSPACE_TRAP_EXECUTED');");
  await mkdir(resolve(root, 'node_modules/@fixture'), { recursive: true });
  await symlink(packageDir, resolve(root, 'node_modules/@fixture/optional'));
  const config = resolve(root, 'poison.npmrc');
  await writeFile(config, `@fixture:registry=${h.registry.endpoint}\ncache=${cache}\n`);
  return { npm_config_cache: cache, npm_config_userconfig: config, NODE_PATH: resolve(root, 'node_modules') };
}

test('actual warm npm cache and linked host workspace cannot conceal a missing staged dependency', { timeout: 600000 }, async (t) => {
  const packages = [manifest('@fixture/root', { optionalDependencies: { '@fixture/optional': '^1.0.0' } })];
  const warm = await consumerHarness(t, packages, [manifest('@fixture/optional')]);
  await stage(warm.state, warm.input, warm.selection, warm.registry, warm.images[0]);
  await runConsumer(warm.state, warm.input, warm.selection, warm.registry, warm.images[0], warm.plans);
  assert(warm.state.report.consumers[0].cache.some((entry) => entry.name === '@fixture/optional'));
  const poison = await cacheTrap(warm, warm.state.report.consumers[0]);
  const h = await consumerHarness(t, packages, [manifest('@fixture/optional')]);
  await stage(h.state, h.input, { ...h.selection, order: ['@fixture/root@1.0.0'] }, h.registry, h.images[0]);
  const previous = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
  Object.assign(process.env, poison);
  try {
    for (const image of h.images) await assert.rejects(runConsumer(h.state, h.input, h.selection, h.registry, image, h.plans), (error) => error.code === 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert(h.state.report.consumers.every((c) => /dependency missing/.test(c.error) && c.identity.mounts.length === 0));
  assert(!JSON.stringify(h.state.report).includes('HOST_WORKSPACE_TRAP_EXECUTED'));
  h.state.report.trap = { warmCacheContainedExpectedTarball: true, linkedHostWorkspace: true, consumersStillFailedMissingDependency: true };
});
