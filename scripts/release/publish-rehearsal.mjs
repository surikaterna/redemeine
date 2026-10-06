import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { signalHandlers } from './consumer.mjs';
import { cleanup, createContainer, docker, dockerRun, inspectOwned, provision, withDockerSignal } from './consumer-docker.mjs';
import { boundedRead } from './consumer-files.mjs';
import { artifactKey } from './consumer-graph.mjs';
import { demand } from './consumer-schema.mjs';
import { toolIdentity } from './handoff.mjs';
import { loadEnvelope } from './handoff-input.mjs';
import { startRegistry } from './quarantine.mjs';
import { hash } from './workspace.mjs';

export function rehearsalArguments(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      envelope: { type: 'string' },
      'envelope-sha256': { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (values.help) return values;
  demand(values.envelope && isAbsolute(values.envelope) && values.output && isAbsolute(values.output), 'Absolute envelope and fresh output required');
  demand(/^[a-f0-9]{64}$/.test(values['envelope-sha256'] || ''), 'Expected envelope digest required');
  return values;
}

export async function preparePublisher(state, admitted) {
  const images = await provision(state);
  const registry = await startRegistry(state, admitted.input, false);
  const directory = resolve(state.output, 'publisher-input');
  await mkdir(directory, { mode: 0o700 });
  const artifacts = [];
  for (const [index, key] of admitted.selection.order.entries()) {
    const artifact = admitted.input.artifacts.find((entry) => artifactKey(entry) === key);
    const bytes = await boundedRead(artifact.copy, 32 * 1024 * 1024);
    demand(hash(bytes) === artifact.sha256, 'Private artifact copy changed before publication');
    await writeFile(resolve(directory, `${index}.tgz`), bytes, { flag: 'wx', mode: 0o600 });
    artifacts.push({
      key,
      file: `${index}.tgz`,
      name: artifact.manifest.name,
      version: artifact.manifest.version,
      sha256: artifact.sha256,
      integrity: artifact.integrity,
      candidate: artifact.origins.includes('candidate')
    });
  }
  for (const file of ['publish-rehearsal.mjs', 'registry-http.mjs']) {
    await copyFile(new URL(`./consumer-runtime/${file}`, import.meta.url), resolve(directory, file));
  }
  const worker = await createContainer(state, images[0].id, registry.internal, ['--entrypoint', 'sleep'], ['300']);
  await docker(['cp', directory, `${worker}:/job`]);
  const job = {
    envelope: admitted.sha256,
    source: admitted.plan.repository.snapshotIdentity,
    runId: state.id,
    registryId: registry.id,
    workerId: worker,
    endpoint: registry.endpoint,
    uploadTag: admitted.plan.uploadTag,
    destinationTag: admitted.plan.intent.destinationTag,
    artifacts
  };
  state.report.publisherIdentity = await inspectOwned(state, worker, registry.internal, images[0].id);
  await docker(['start', worker]);
  return { registry, worker, image: images[0].id, job, directory };
}

export async function publisherWorker(state, publisher, resumeSha256) {
  const { registry, worker, image, job, directory } = publisher;
  await inspectOwned(state, registry.id, registry.internal, registry.image, true);
  await inspectOwned(state, worker, registry.internal, image);
  demand(registry.endpoint === `http://${state.id}-registry:4873/` && registry.egress === undefined, 'Publisher target changed');
  const [network] = JSON.parse(await docker(['network', 'inspect', registry.internal]));
  demand(network.Internal && network.Labels[state.label] === state.id, 'Publisher network is not owned/internal');
  const path = resolve(directory, 'job.json');
  await writeFile(path, JSON.stringify({ ...job, ...(resumeSha256 ? { resumeSha256 } : {}) }), { mode: 0o600 });
  await docker(['cp', path, `${worker}:/job/job.json`]);
  const index = state.report.workers.length;
  let commandExit = 0;
  try {
    await docker(['exec', worker, 'node', '/job/publish-rehearsal.mjs'], 180000);
  } catch (error) {
    commandExit = Number.isInteger(error.code) ? error.code : 2;
  }
  const receipt = resolve(state.output, `worker-${index}.json`);
  await docker(['cp', `${worker}:/job/result.json`, receipt]);
  const bytes = await boundedRead(receipt, 16 * 1024 * 1024);
  const result = JSON.parse(bytes);
  demand(result.exitCode === commandExit, 'Worker command/report contradiction');
  state.report.workers.push({ ...result, receiptSha256: hash(bytes), process: index + 1 });
  if (result.ledgerSha256) {
    const path = resolve(state.output, `ledger-${index}.json`);
    await docker(['cp', `${worker}:/job/ledger.json`, path]);
    demand(hash(await readFile(path)) === result.ledgerSha256, 'Durable ledger receipt changed');
  }
  return result;
}

export async function rehearse(options) {
  await mkdir(options.output, { mode: 0o700 });
  const report = { schemaVersion: 1, livePublishing: false, envelopeSha256: options['envelope-sha256'], complete: false, exitCode: 2, workers: [] };
  const signals = signalHandlers(report);
  let state;
  try {
    const source = await toolIdentity();
    const admitted = await loadEnvelope(options.envelope, options['envelope-sha256'], resolve(options.output, 'bundle'), source.snapshotIdentity);
    state = dockerRun(options.output, report);
    report.runId = state.id;
    const result = await withDockerSignal(signals.signal, () => executeRehearsal(state, admitted));
    report.exitCode = result.exitCode;
    report.complete = result.exitCode !== 2;
  } catch (error) {
    report.exitCode = error.code === 1 ? 1 : 2;
    report.error = error.message;
  } finally {
    signals.dispose();
    try {
      if (state && !(await cleanup(state))) {
        report.exitCode = 2;
        report.complete = false;
      }
    } catch {
      report.exitCode = 2;
      report.complete = false;
      report.cleanup = { complete: false };
    }
    if (signals.signal.aborted) {
      report.exitCode = 2;
      report.complete = false;
    }
    await writeFile(resolve(options.output, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}

async function executeRehearsal(state, admitted) {
  const publisher = await preparePublisher(state, admitted);
  const first = await publisherWorker(state, publisher);
  return first.exitCode === 2 && first.ledgerSha256 ? publisherWorker(state, publisher, first.ledgerSha256) : first;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = rehearsalArguments(args);
    if (options.help) {
      console.log(
        '--envelope FILE --envelope-sha256 SHA --output FRESH; owned ephemeral LOCAL Verdaccio only, exact tgzs, no public mode/credentials. Exit 0 local scope, 1 conflict, 2 incomplete.'
      );
      return 0;
    }
    return (await rehearse(options)).exitCode;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
