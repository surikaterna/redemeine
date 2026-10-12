import { spawn } from 'node:child_process';
import { mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { imagePlan, root, sha256 } from './main-image-plan.mjs';
import { checkPayload, tarEntries, payloadValidationReason } from './main-image-tar.mjs';
import { superviseChild, noSpawnResult, armFailureExit } from './main-image-child.mjs';
import { ImageResourceLedger } from './main-image-ledger.mjs';
import { assertDaemonCapabilities, assertContainerCapabilities, assertImageCapabilities, imageCapabilityFacts, imageValidationReason } from './main-image-capabilities.mjs';
import { persistBuildDiagnostics } from './main-image-diagnostics.mjs';

const run = process.argv[3] ?? randomBytes(8).toString('hex');
const receipt = { issue: 'redemeine-hpq1.2', commands: [], failures: [], cleanup: [], uncertainty: [], status: 'not_run' };
const interruption = new AbortController();
let cleanupDeadline = Infinity;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => interruption.abort());

async function command(plan, args, milliseconds = plan.deadlines.command, cleanup = false, limit = 1024 * 1024) {
  if (interruption.signal.aborted && !cleanup) throw Object.assign(new Error('packaging_interrupted'), { result: { ...noSpawnResult(), reason: 'packaging_interrupted' } });
  if (cleanup) { assert.ok(performance.now() < cleanupDeadline - 2000, 'cleanup_deadline'); milliseconds = Math.min(milliseconds, cleanupDeadline - performance.now() - 2000); }
  let result;
  let child;
  const started = performance.now(); const deadline = started + milliseconds;
  try {
    child = spawn('docker', [...plan.dockerPrefix, ...args], { cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_BUILDKIT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { result = noSpawnResult(); }
  if (child) result = await superviseChild(child, { milliseconds, deadline, started, limit, ...(cleanup ? {} : { signal: interruption.signal }) });
  const { stdout, stderr, ...status } = result;
  receipt.commands.push({ args: args.map((arg) => arg.includes('=') && args.includes('--env') ? arg.split('=')[0] + '=<redacted>' : arg),
    ...status, stdoutHash: sha256(stdout), stderrHash: sha256(stderr) });
  if (args[0] === 'build') {
    try { receipt.buildDiagnostics = await persistBuildDiagnostics(plan.directory, result, plan.buildContextClosure); }
    catch { receipt.uncertainty.push({ operation: 'build', reason: 'diagnostic_persistence_failed' }); }
  }
  if (result.reason) {
    const failure = { operation: args[0], reason: result.reason, cliJoined: result.cliJoined, nativeNoSpawn: result.nativeNoSpawn };
    receipt.failures.push(failure); if (!result.nativeNoSpawn) receipt.uncertainty.push(failure);
    throw Object.assign(new Error(result.reason), { result });
  }
  return result;
}

async function required(plan, args, milliseconds, cleanup = false, limit) {
  const result = await command(plan, args, milliseconds, cleanup, limit);
  if (result.code !== 0) throw Object.assign(new Error('docker_command_failed'), { result, code: 'docker_command_failed' });
  return result.stdout;
}
async function inspect(plan, type, name, cleanup = false) {
  const result = await command(plan, [type, 'inspect', name], undefined, cleanup);
  if (result.code !== 0) {
    if (result.code === 1 && /No such (object|image|container)/.test(result.stderr.toString())) return null;
    throw new Error('resource_inspection_uncertain');
  }
  const rows = JSON.parse(result.stdout); assert.equal(rows.length, 1); return rows[0];
}

async function payload(plan, id) {
  const archive = await required(plan, ['cp', `${id}:/app/.`, '-'], undefined, false, 8 * 1024 * 1024);
  receipt.payloadValidation = { phase: 'app_tar_validation', id, expectedWorkerDigest: plan.workerDigest, facts: {} };
  receipt.payload = checkPayload(archive, receipt.payloadValidation.facts);
  // Docker_worker_differs_from_reviewed_offline_seal is never adopted as a new identity.
  if (receipt.payload.artifact !== plan.workerDigest) throw Object.assign(new Error('image_worker_digest_mismatch'), { code: 'image_worker_digest_mismatch' });
  const state = tarEntries(await required(plan, ['cp', `${id}:/var/lib/redemeine-projection`, '-']));
  assert.ok(state.some((row) => row.type === '5' && row.uid === 10001 && row.mode === 0o700));
  for (const path of ['/usr/bin/tini', '/usr/bin/flock', '/etc/ssl/certs/ca-certificates.crt']) {
    const rows = tarEntries(await required(plan, ['cp', `${id}:${path}`, '-']));
    assert.ok(rows.some((row) => row.bytes.length > 0 && (path.endsWith('.crt') || (row.mode & 1) !== 0)));
  }
  // Exact absence checks, not a broad image export or host filesystem extraction.
  for (const path of ['/usr/local/bin/npm', '/usr/local/bin/npx', '/usr/local/bin/yarn', '/usr/local/bin/pnpm', '/usr/local/bin/corepack', '/usr/bin/socat']) {
    const result = await command(plan, ['cp', `${id}:${path}`, '-']);
    assert.ok(result.code === 1 && /Could not find|No such file/.test(result.stderr.toString()), 'unexpected_runtime_tool_or_uncertainty');
  }
}

async function smoke(plan, container, imageId, ledger) {
  const intent = ledger.intent('container', container.name); let id;
  try { id = (await required(plan, container.create)).toString().trim(); assert.match(id, /^[a-f0-9]{64}$/); intent.id = id; }
  catch (error) { ledger.failed(intent, error.result); throw error; }
  const before = await inspect(plan, 'container', container.name); assert.equal(ledger.identify(intent, before), id);
  assertContainerCapabilities(before, container, plan, imageId);
  const result = await command(plan, ['start', '--attach', id], plan.deadlines.smoke);
  const after = await inspect(plan, 'container', container.name); ledger.identify(intent, after);
  assertContainerCapabilities(after, container, plan, imageId);
  assert.equal(after.State.Running, false); assert.equal(after.State.ExitCode, 78); assert.ok([0, 78].includes(result.code));
  assert.equal(result.stderr.length, 0); assert.deepEqual(JSON.parse(result.stdout.toString().trim()), container.expectedDiagnostic);
  receipt[container.kind] = { id, exitCode: after.State.ExitCode, diagnostic: container.expectedDiagnostic };
  if (container.kind === 'missing') await payload(plan, id);
}

async function cleanup(plan, ledger) {
  cleanupDeadline = performance.now() + plan.deadlines.cleanup;
  await ledger.cleanup((type, name) => inspect(plan, type, name, true),
    (entry, id) => required(plan, entry.type === 'container' ? ['rm', '--force', id] : ['image', 'rm', entry.name], undefined, true),
    (row) => receipt.cleanup.push(row), (row) => receipt.uncertainty.push(row),
    () => assert.ok(performance.now() < cleanupDeadline - 2000, 'cleanup_deadline'));
}

async function build(plan, ledger) {
  const intent = ledger.intent('image', plan.image);
  try { await required(plan, plan.build, plan.deadlines.build); }
  catch (error) { ledger.failed(intent, error.result); throw error; }
  // Remember the ID before any unrelated validation can fail and enter cleanup.
  const image = await inspect(plan, 'image', plan.image); const id = ledger.identify(intent, image);
  const sourcePlanMatches = (await imagePlan(run)).reviewDigest === plan.reviewDigest;
  receipt.imageValidation = { phase: 'post_build_image_validation', id, sourcePlanMatches, facts: imageCapabilityFacts(image) };
  if (!sourcePlanMatches) throw Object.assign(new Error('image_source_plan_mismatch'), { code: 'image_source_plan_mismatch' });
  assertImageCapabilities(image); receipt.image = { id, labels: { ...plan.labels,
    'org.opencontainers.image.revision': 'uncommitted-source-snapshot', 'org.opencontainers.image.version': '0.1.0-rc.1' } }; return id;
}

async function execute(plan) {
  assert.equal(process.platform, 'linux'); assert.equal(await realpath('/tmp/opencode'), '/tmp/opencode');
  await mkdir(plan.directory, { mode: 0o700 });
  await writeFile(`${plan.directory}/invalid.mjs`, 'export const registrations = [];\n', { flag: 'wx', mode: 0o444 });
  assert.ok((await lstat(`${plan.directory}/invalid.mjs`)).isFile());
  assert.equal(await realpath(`${plan.directory}/invalid.mjs`), `${plan.directory}/invalid.mjs`);
  const ledger = new ImageResourceLedger(plan);
  receipt.status = 'running'; receipt.startedAt = new Date().toISOString(); receipt.hostNodeVersion = process.versions.node;
  await writeFile(`${plan.directory}/plan.json`, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    const capabilities = JSON.parse((await required(plan, ['info', '--format', '{{json .}}'])).toString());
    assertDaemonCapabilities(capabilities); receipt.daemonCapabilities = Object.fromEntries(['OSType', ...plan.daemonCapabilities.slice(1)].map((key) => [key, capabilities[key]]));
    await ledger.preflight((type, name) => inspect(plan, type, name));
    const id = await build(plan, ledger);
    for (const container of plan.containers) await smoke(plan, container, id, ledger);
    receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.reason ??= error.result?.reason ?? imageValidationReason(error) ?? payloadValidationReason(error)
    ?? (error.code === 'docker_command_failed' ? error.code : 'packaging_validation_failed'); }
  finally { await cleanup(plan, ledger); if (receipt.uncertainty.length) receipt.status = 'failed_uncertain';
    receipt.intents = ledger.entries;
    receipt.finishedAt = new Date().toISOString();
    await writeFile(`${plan.directory}/receipt.json`, JSON.stringify(receipt, null, 2), { mode: 0o600 }); }
  assert.equal(receipt.status, 'passed', 'packaging_failed_or_uncertain');
}

async function main() {
  const plan = await imagePlan(run);
  if (process.argv[2] === '--plan' && process.argv.length === 4) { console.log(JSON.stringify(plan, null, 2)); return; }
  assert.ok(process.argv[2] === '--execute' && process.argv.length === 6 && process.argv[4] === '--approved-review-digest');
  assert.equal(process.argv[5], plan.reviewDigest, 'candidate_or_plan_changed');
  // Operator supplies this only after independent Auditor approval; the flag is not approval itself.
  await execute(plan);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void main().catch(() => {
  console.error('main_image_packaging_refused'); process.exitCode = 1;
  // Last-resort process cutoff if a supervised CLI could not be joined/detached.
  armFailureExit();
});
