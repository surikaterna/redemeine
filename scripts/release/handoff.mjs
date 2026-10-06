import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { boundedRead, containedRead } from './consumer-files.mjs';
import { parseJson } from './consumer-json.mjs';
import { demand } from './consumer-schema.mjs';
import { admitBundle, envelopeSchema, expectedArtifacts } from './handoff-input.mjs';
import { loadPlan } from './release-plan.mjs';
import { canonicalBytes } from './release-plan-schema.mjs';
import { hash, sourceIdentity } from './workspace.mjs';

export const toolRoot = fileURLToPath(new URL('../../', import.meta.url));
export const toolIdentity = () => sourceIdentity(toolRoot, { root: toolRoot, invocations: [] });

export function handoffArguments(args) {
  const names = ['plan', 'plan-sha256', 'manifest', 'manifest-sha256', 'consumer-result', 'consumer-sha256', 'global-manifest', 'global-sha256', 'output'];
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      ...Object.fromEntries(names.map((key) => [key, { type: 'string' }])),
      help: { type: 'boolean' }
    }
  });
  if (!values.help)
    for (const name of names)
      demand(values[name] && (name.endsWith('sha256') ? /^[a-f0-9]{64}$/.test(values[name]) : isAbsolute(values[name])), `Invalid --${name}`);
  return values;
}

async function retain(state, path, bytes, expected = hash(bytes)) {
  demand(hash(bytes) === expected, `Input changed before copy: ${path}`);
  demand(!state.files.some((item) => item.path === path), 'Duplicate handoff evidence path');
  state.total += bytes.length;
  demand(state.total <= 256 * 1024 * 1024, 'Handoff evidence exceeds total byte bound');
  const target = resolve(state.output, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  state.files.push({ path, size: bytes.length, sha256: expected });
  return parseJsonIfReport(path, bytes);
}

function parseJsonIfReport(path, bytes) {
  return path.endsWith('.json') ? parseJson(bytes) : undefined;
}

async function retainAudit(state, source, expected, prefix) {
  const bytes = await boundedRead(source, 16 * 1024 * 1024);
  const report = await retain(state, `${prefix}/manifest.json`, bytes, expected);
  for (const item of report.artifacts || []) {
    await retain(state, `${prefix}/${item.archive}`, await containedRead(dirname(source), item.archive, 32 * 1024 * 1024), item.sha256);
  }
  for (const item of report.registrySnapshots || []) {
    if (!item.sha256) continue;
    const path = `registry/${encodeURIComponent(item.name)}.json`;
    await retain(state, `${prefix}/${path}`, await containedRead(dirname(source), path, 16 * 1024 * 1024), item.sha256);
  }
}

async function retainConsumer(state, source, expected) {
  const report = await retain(state, 'b/result.json', await boundedRead(source, 16 * 1024 * 1024), expected);
  const files = [
    ['input-manifest.json', report.inputSha256],
    ['staging.json', report.staging?.receiptSha256],
    ['verdaccio.json', report.registry?.configSha256]
  ];
  for (const image of report.images || []) files.push([`provision-${image.version}.log`, image.logSha256]);
  for (const [index, consumer] of (report.consumers || []).entries()) {
    files.push([`consumer-${index}.json`, consumer.receiptSha256], [`consumer-${index}-lock.json`, consumer.lockSha256]);
  }
  for (const [path, digest] of files) {
    demand(/^[a-f0-9]{64}$/.test(digest || ''), `Missing B evidence digest: ${path}`);
    await retain(state, `b/${path}`, await containedRead(dirname(source), path, 32 * 1024 * 1024), digest);
  }
}

async function retainPlan(state, options) {
  const { plan, bytes } = await loadPlan(options.plan, options['plan-sha256']);
  await retain(state, 'plan/plan.json', bytes, options['plan-sha256']);
  const root = dirname(options.plan);
  await retain(state, 'plan/changesets-status.json', await containedRead(root, 'changesets-status.json', 16 * 1024 * 1024), plan.changesetsStatusSha256);
  for (const item of plan.registry) {
    if (!item.sha256) continue;
    const path = `registry/${encodeURIComponent(item.name)}.json`;
    await retain(state, `plan/${path}`, await containedRead(root, path, 16 * 1024 * 1024), item.sha256);
  }
  return plan;
}

export async function createHandoff(options) {
  await mkdir(options.output, { mode: 0o700 });
  const state = { output: options.output, files: [], total: 0 };
  const source = await toolIdentity();
  const plan = await retainPlan(state, options);
  if (plan.classification === 'repository')
    demand(!source.dirty && source.snapshotIdentity === plan.repository.snapshotIdentity, 'Clean source checkout does not match plan');
  await retainAudit(state, options.manifest, options['manifest-sha256'], 'a');
  await retainAudit(state, options['global-manifest'], options['global-sha256'], 'global');
  await retainConsumer(state, options['consumer-result'], options['consumer-sha256']);
  const expected = {
    planSha256: options['plan-sha256'],
    aSha256: options['manifest-sha256'],
    bSha256: options['consumer-sha256'],
    globalSha256: options['global-sha256']
  };
  const { input, selection } = await admitBundle(options.output, expected, resolve(options.output, 'validated-snapshot'));
  const envelope = envelopeSchema.parse({
    schemaVersion: 1,
    livePublishing: false,
    purpose: 'local-only exact-byte rehearsal',
    classification: plan.classification,
    ...expected,
    sourceSnapshot: plan.repository.snapshotIdentity,
    toolsSnapshot: source.snapshotIdentity,
    sourceSha: plan.repository.sha,
    uploadTag: plan.uploadTag,
    destinationTag: plan.intent.destinationTag,
    order: selection.order,
    artifacts: expectedArtifacts(input, selection),
    files: state.files.sort((a, b) => a.path.localeCompare(b.path))
  });
  await rm(resolve(options.output, 'validated-snapshot'), { recursive: true });
  demand((await toolIdentity()).snapshotIdentity === source.snapshotIdentity, 'Tools changed during handoff');
  const bytes = canonicalBytes(envelope);
  await writeFile(resolve(options.output, 'envelope.json'), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(options.output, 'envelope.sha256'), `${hash(bytes)}\n`, { flag: 'wx', mode: 0o600 });
  return { envelope, sha256: hash(bytes) };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = handoffArguments(args);
    if (options.help) {
      console.log(
        '--plan FILE --plan-sha256 SHA --manifest A --manifest-sha256 SHA --consumer-result B --consumer-sha256 SHA --global-manifest A_GLOBAL --global-sha256 SHA --output FRESH; nonpublishing only'
      );
      return 0;
    }
    console.log((await createHandoff(options)).sha256);
    return 0;
  } catch (error) {
    console.error(error.message);
    return error.code === 1 ? 1 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
