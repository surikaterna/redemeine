import { isDeepStrictEqual as equal } from 'node:util';
import { tools } from './consumer-docker.mjs';
import { artifactKey, dependencyOrder, selectRoots } from './consumer-graph.mjs';
import { parseJson } from './consumer-json.mjs';
import { runtimeCommands } from './consumer-runtime/smoke-commands.mjs';
import { demand } from './consumer-schema.mjs';
import { smokePlan } from './consumer-smokes.mjs';
import { registryConfig } from './quarantine.mjs';
import { hash } from './workspace.mjs';

const hex = /^[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const label = 'org.redemeine.consumer-run';

export async function validateConsumerEvidence(report, input, read) {
  demand(report.schemaVersion === 1 && report.complete === true && report.exitCode === 0 && !report.error && !report.interrupted, 'B did not complete green');
  demand(report.inputSha256 === input.digest && equal(report.graph, input.graph), 'B A/graph binding mismatch');
  await read('input-manifest.json', input.digest);
  demand(
    Number.isFinite(Date.parse(report.timestamp)) &&
      Date.parse(report.timestamp) >= Date.parse(input.manifest.timestamp) &&
      Date.parse(report.finishedAt) >= Date.parse(report.timestamp),
    'B source/time ordering mismatch'
  );
  for (const key of ['repository', 'tools', 'policy', 'inputs', 'diagnostics', 'verdict']) {
    demand(equal(report.input?.[key], input.manifest[key]), `B source context mismatch: ${key}`);
  }
  const selection = selectRoots(input, []);
  demand(equal(report.selection, selection), 'B must cover EVERY selected candidate, no subsets');
  demand(equal(report.toolPins, tools) && report.platform === tools.platform, 'B tools/platform mismatch');
  demand(/^consumer-[a-f0-9-]{36}$/.test(report.runId), 'Invalid B run identity');
  await validateImages(report, read);
  validateRegistry(report, input);
  await validateStaging(report, input, selection, read);
  const pairs = tools.nodes.flatMap((node) => selection.roots.map((root) => ({ root, node: node.version })));
  demand(equal(report.requestedConsumers, pairs), 'B requested matrix mismatch');
  demand(
    equal(
      report.coverage,
      pairs.map((item) => ({ ...item, exitCode: 0, status: 'attempted' }))
    ),
    'B coverage mismatch'
  );
  demand(report.consumers?.length === pairs.length, 'B missing/extra consumer');
  for (const [index, pair] of pairs.entries()) await validateConsumer(report, input, pair, index, read);
  validateResources(report);
  return selection;
}

async function validateImages(report, read) {
  demand(report.images?.length === tools.nodes.length, 'B image matrix mismatch');
  for (const [index, pin] of tools.nodes.entries()) {
    const image = report.images[index];
    demand(image.version === pin.version && image.image === pin.image && imageId.test(image.id), 'B pinned image mismatch');
    demand(image.tag === `${report.runId}:node-${pin.version}`, 'B image ownership mismatch');
    demand(equal(image.actual, { node: pin.version, npm: tools.npm.version, typescript: tools.typescript }), 'B actual tool mismatch');
    await read(`provision-${pin.version}.log`, image.logSha256);
  }
  demand(
    equal(
      report.imageCleanup,
      report.images.map((image) => ({ tag: image.tag, id: image.id, removed: true }))
    ),
    'B image cleanup incomplete'
  );
}

function identity(report, actual, image, registry = false) {
  demand(actual && hex.test(actual.id) && actual.image === image && actual.network === report.registry.internal, 'B resource identity mismatch');
  demand(actual.labels?.[label] === report.runId, 'B foreign resource');
  demand(Array.isArray(actual.mounts), 'B mount evidence missing');
  if (!registry) demand(actual.mounts.length === 0, 'B unexpected job mounts');
  else
    demand(
      actual.mounts.length === 1 && actual.mounts[0].Type === 'volume' && actual.mounts[0].Destination === '/verdaccio/storage',
      'B registry storage mount mismatch'
    );
}

function validateRegistry(report, input) {
  const registry = report.registry;
  demand(
    registry?.endpoint === `http://${report.runId}-registry:4873/` && hex.test(registry.internal) && imageId.test(registry.image),
    'B generated registry identity missing'
  );
  demand(registry.version === tools.registry.version && [false, 'npmjs'].includes(registry.proxy), 'B registry tool/proxy mismatch');
  demand(Boolean(registry.egress) === Boolean(registry.proxy), 'B registry network mismatch');
  identity(report, registry.identity, registry.image, true);
  demand(registry.id === registry.identity.id, 'B registry container mismatch');
  demand(registry.configSha256 === hash(JSON.stringify(registryConfig(input.graph.owned, registry.proxy))), 'B registry ownership/config mismatch');
}

function validCommands(commands) {
  demand(Array.isArray(commands) && commands.length > 0, 'Missing command receipts');
  for (const command of commands) {
    demand(command.exit === 0 && typeof command.log === 'string' && hash(command.log) === command.logSha256, 'Failed/missing command log');
  }
}

async function rawReceipt(read, path, reported) {
  const bytes = await read(path, reported.receiptSha256);
  const { identity: omitted, receiptSha256: digest, ...raw } = reported;
  demand(equal(parseJson(bytes), raw), 'B raw receipt does not match report');
}

async function validateStaging(report, input, selection, read) {
  const stage = report.staging;
  demand(stage?.exitCode === 0 && !stage.error && stage.receipts?.length === selection.order.length, 'B incomplete staging');
  identity(report, stage.identity, report.images[0].id);
  await rawReceipt(read, 'staging.json', stage);
  validCommands(stage.commands);
  demand(stage.commands.length === selection.order.length, 'B stage command count mismatch');
  for (const [index, key] of selection.order.entries()) {
    const artifact = input.artifacts.find((item) => artifactKey(item) === key);
    const receipt = stage.receipts[index];
    const expected = {
      key,
      file: `${index}.tgz`,
      name: artifact.manifest.name,
      version: artifact.manifest.version,
      sha256: artifact.sha256,
      integrity: artifact.integrity,
      origins: artifact.origins,
      downloadedSha256: artifact.sha256,
      downloadedIntegrity: artifact.integrity
    };
    demand(
      Object.entries(expected).every(([field, value]) => equal(receipt?.[field], value)),
      'B staged/readback bytes/order mismatch'
    );
    demand(
      receipt.dist?.integrity === artifact.integrity &&
        new URL(receipt.dist.tarball).origin === new URL(report.registry.endpoint).origin &&
        hex.test(receipt.metadataSha256),
      'B missing dist/readback evidence'
    );
    demand(
      stage.commands[index].command === 'npm' && equal(stage.commands[index].args, stageArguments(index, report.registry.endpoint)),
      'B staging invocation mismatch'
    );
  }
  await read('verdaccio.json', report.registry.configSha256);
}

function stageArguments(index, endpoint) {
  return [
    'publish',
    `/job/${index}.tgz`,
    '--ignore-scripts',
    '--provenance=false',
    '--fetch-retries=0',
    '--registry',
    endpoint,
    '--tag',
    'local-qualification',
    '--no-audit',
    '--no-fund'
  ];
}

async function validateConsumer(report, input, pair, index, read) {
  const consumer = report.consumers[index];
  demand(
    consumer.node === pair.node && equal(consumer.root, [pair.root]) && consumer.npm === tools.npm.version && consumer.exitCode === 0,
    'B consumer matrix mismatch'
  );
  demand(!consumer.error && !consumer.failureKind && equal(consumer.notValidated, []), 'B consumer incomplete');
  for (const phase of ['install', 'ls', 'lock', 'installedGraph', 'runtime', 'types'])
    demand(consumer.phases?.[phase] === 'passed', `B missing phase ${phase}`);
  const artifact = input.artifacts.find((item) => artifactKey(item) === pair.root);
  demand(equal(consumer.smokes, [smokePlan(artifact)]), 'B unsupported smoke coverage');
  identity(report, consumer.identity, report.images.find((image) => image.version === pair.node).id);
  await rawReceipt(read, `consumer-${index}.json`, consumer);
  const lock = parseJson(await read(`consumer-${index}-lock.json`, consumer.lockSha256));
  demand(
    lock.lockfileVersion === 3 && consumer.realpaths?.boundary === '/consumer/node_modules' && consumer.realpaths.entries > 0,
    'B missing lock/realpath evidence'
  );
  demand(consumer.connectivity?.directExternalReachable === false, 'B network isolation missing');
  validCommands(consumer.commands);
  demand(
    consumer.commands.some((command) => command.program === 'npm' && equal(command.args, ['ls', '--all'])),
    'B npm ls missing'
  );
  demand(
    consumer.commands.some(
      (command) =>
        command.program === 'npm' &&
        equal(command.args, [
          'install',
          pair.root,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--save-exact',
          '--fetch-retries=0',
          '--fetch-timeout=15000',
          '--registry',
          report.registry.endpoint
        ])
    ),
    'B root install mismatch'
  );
  validateCache(consumer, input, pair.root, lock);
  validateSmokeCommands(consumer, smokePlan(artifact));
}

function validateSmokeCommands(consumer, plan) {
  const declarations = plan.surfaces.some((item) => item.modes.includes('import')) ? 2 : 0;
  const cjs = Number(plan.surfaces.some((item) => item.modes.includes('require')));
  const types = consumer.commands.filter(
    (item) => item.program === 'node' && equal(item.args, ['/opt/consumer-tools/node_modules/typescript/bin/tsc', '--project', '/consumer/tsconfig.json'])
  );
  demand(types.length === declarations + cjs, 'B strict declaration phase receipts missing/duplicate');
  const expected = runtimeCommands(plan);
  demand(
    equal(
      consumer.commands.slice(3, 3 + expected.length).map(({ program, args }) => ({ program, args })),
      expected
    ),
    'B runtime command binding differs from admitted root/surface/mode/behavior'
  );
  demand(consumer.commands.length === types.length + expected.length + 3, 'B missing/extra phase commands');
  demand(
    consumer.commands[0].program === 'npm' &&
      equal(consumer.commands[0].args, ['--version']) &&
      consumer.commands[1].args[0] === 'install' &&
      equal(consumer.commands[2].args, ['ls', '--all']),
    'B setup command order mismatch'
  );
  demand(
    consumer.commands.slice(3 + expected.length).every((item) => types.includes(item)),
    'B declaration command order mismatch'
  );
}

function validateCache(consumer, input, root, lock) {
  const expected = dependencyOrder(new Map(Object.entries(input.graph.edges)), [root]);
  demand(Array.isArray(consumer.cache) && consumer.cache.length >= expected.length, 'B missing cache/readback evidence');
  for (const key of expected) {
    const artifact = input.artifacts.find((item) => artifactKey(item) === key);
    const matches = consumer.cache.filter((entry) => `${entry.name}@${entry.version}` === key);
    demand(
      matches.length > 0 &&
        matches.every(
          (entry) =>
            entry.sha256 === artifact.sha256 &&
            entry.integrity === artifact.integrity &&
            lock.packages[entry.path]?.integrity === artifact.integrity &&
            lock.packages[entry.path]?.version === artifact.manifest.version
        ),
      'B cache/lock bytes mismatch'
    );
  }
}

function validateResources(report) {
  demand(report.cleanup?.complete === true && equal(report.cleanup.failures, []), 'B cleanup failed/missing');
  const ids = [report.registry.identity.id, report.staging.identity.id, ...report.consumers.map((item) => item.identity.id)];
  demand(new Set(ids).size === ids.length && report.resourceOutcomes?.length === ids.length, 'B resource outcomes missing/duplicate/extra');
  for (const [index, id] of ids.entries()) {
    const outcomes = report.resourceOutcomes.filter((item) => item.id === id);
    demand(outcomes.length === 1 && equal(outcomes[0], { id, running: index === 0, oomKilled: false, exitCode: 0 }), 'B unhealthy resource outcome');
  }
}
