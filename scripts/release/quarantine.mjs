import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContainer, docker, inspectOwned, network, tools } from './consumer-docker.mjs';
import { artifactKey } from './consumer-graph.mjs';
import { demand } from './consumer-schema.mjs';
import { hash } from './workspace.mjs';

export function registryConfig(owned, proxy) {
  const packages = {};
  for (const name of owned.names) packages[name] = { access: '$all', publish: '$authenticated' };
  for (const scope of owned.scopes) packages[`${scope}/*`] = { access: '$all', publish: '$authenticated' };
  packages['**'] = { access: '$all', publish: '$authenticated', ...(proxy ? { proxy: 'npmjs' } : {}) };
  return {
    storage: '/verdaccio/storage/data',
    auth: { htpasswd: { file: '/verdaccio/storage/htpasswd', max_users: 1 } },
    uplinks: proxy ? { npmjs: { url: 'https://registry.npmjs.org/', cache: false } } : {},
    packages,
    log: { type: 'stdout', format: 'json', level: 'http' },
    web: { enable: false },
    security: { api: { legacy: true } },
    server: { keepAliveTimeout: 60 }
  };
}

export async function startRegistry(state, input, proxy) {
  const internal = await network(state, true);
  const config = JSON.stringify(registryConfig(input.graph.owned, proxy));
  const configPath = resolve(state.output, 'verdaccio.json');
  await writeFile(configPath, config, { mode: 0o644 });
  const name = `${state.id}-registry`;
  const id = await createContainer(state, tools.registry.image, internal, ['--name', name]);
  await docker(['cp', configPath, `${id}:/verdaccio/conf/config.yaml`]);
  const image = JSON.parse(await docker(['image', 'inspect', tools.registry.image]))[0].Id;
  await docker(['start', id]);
  const identity = await inspectOwned(state, id, internal, image, true);
  const topology = JSON.parse(await docker(['network', 'inspect', internal]))[0];
  demand(topology.Internal && topology.Labels[state.label] === state.id, 'Registry network is not run-owned internal');
  let egress;
  if (proxy) {
    egress = await network(state, false);
    await docker(['network', 'connect', egress, id]);
  }
  const registry = { id, endpoint: `http://${name}:4873/`, internal, egress, image, identity };
  state.report.registry = { ...registry, configSha256: hash(config), version: tools.registry.version, proxy: proxy || false };
  return registry;
}

async function verifyTarget(state, registry) {
  const [item] = JSON.parse(await docker(['inspect', registry.id]));
  demand(item.Config.Labels[state.label] === state.id && item.Image === registry.image && item.State.Running, 'Registry no longer run-owned/running');
  demand(registry.endpoint === `http://${item.Name.slice(1)}:4873/` && item.Name === `/${state.id}-registry`, 'Registry write target mismatch');
  const networks = Object.values(item.NetworkSettings.Networks)
    .map((entry) => entry.NetworkID)
    .sort();
  demand(JSON.stringify(networks) === JSON.stringify([registry.internal, registry.egress].filter(Boolean).sort()), 'Registry topology changed');
}

export async function stage(state, input, selection, registry, image) {
  await verifyTarget(state, registry);
  const directory = resolve(state.output, 'stage-input');
  await mkdir(directory, { mode: 0o700 });
  const artifacts = [];
  for (const [index, key] of selection.order.entries()) {
    const artifact = input.artifacts.find((entry) => artifactKey(entry) === key);
    const file = `${index}.tgz`;
    await copyFile(artifact.copy, resolve(directory, file));
    artifacts.push({
      key,
      file,
      name: artifact.manifest.name,
      version: artifact.manifest.version,
      sha256: artifact.sha256,
      integrity: artifact.integrity,
      origins: artifact.origins
    });
  }
  await writeFile(resolve(directory, 'job.json'), JSON.stringify({ endpoint: registry.endpoint, artifacts }), { mode: 0o600 });
  await copyFile(new URL('./consumer-runtime/stage.mjs', import.meta.url), resolve(directory, 'stage.mjs'));
  await copyFile(new URL('./consumer-runtime/registry-http.mjs', import.meta.url), resolve(directory, 'registry-http.mjs'));
  const stager = await createContainer(state, image.id, registry.internal, ['--entrypoint', 'node'], ['/job/stage.mjs']);
  await docker(['cp', directory, `${stager}:/job`]);
  const identity = await inspectOwned(state, stager, registry.internal, image.id);
  await docker(['start', stager]);
  await docker(['wait', stager], 240000);
  const receipt = resolve(state.output, 'staging.json');
  await docker(['cp', `${stager}:/job/result.json`, receipt]);
  const result = JSON.parse(await readFile(receipt, 'utf8'));
  state.report.staging = { ...result, identity, receiptSha256: hash(await readFile(receipt)) };
  await rm(directory, { recursive: true, force: true });
  demand(result.exitCode === 0, 'Exact-byte staging failed; see staging receipt', result.exitCode);
}
