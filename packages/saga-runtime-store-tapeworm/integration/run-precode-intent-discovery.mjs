import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const testPath = resolve(directory, 'precode-intent-discovery.integration.test.ts');
const image = 'mongo:8.0.14';
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
let ownedOnExit;
process.on('exit', () => {
  if (ownedOnExit) spawnSync('docker', ['rm', '-f', ownedOnExit], { stdio: 'ignore' });
});

function execute(program, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { cwd: root, env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    options.onChild?.(child);
    let output = '';
    let errorOutput = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { errorOutput += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code, output: output.trim(), error: errorOutput.trim() }));
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const port = server.address().port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

function requireSuccess(result, label) {
  if (result.code !== 0) throw new Error(`${label} failed: ${result.error || result.output}`);
  return result.output;
}

async function preflight(run, expected) {
  if (!/^[0-9a-f]{40}$/.test(expected.head ?? '') || !/^[0-9a-f]{64}$/.test(expected.testSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(expected.runnerSha256 ?? '')) {
    throw new Error('Require full REDEMEINE_EXPECTED_SHA, REDEMEINE_EXPECTED_TEST_SHA256 and REDEMEINE_EXPECTED_RUNNER_SHA256');
  }
  const dirty = requireSuccess(await run('git', ['status', '--porcelain', '--untracked-files=all']), 'git status');
  if (dirty !== '') throw new Error('Dirty worktree: refusing PRECODE experiment');
  const head = requireSuccess(await run('git', ['rev-parse', 'HEAD']), 'git head');
  if (head !== expected.head) throw new Error('HEAD mismatch: refusing PRECODE experiment');
  const testSha256 = hash(testPath);
  const runnerSha256 = hash(fileURLToPath(import.meta.url));
  if (testSha256 !== expected.testSha256 || runnerSha256 !== expected.runnerSha256) {
    throw new Error('Script hash mismatch: refusing PRECODE experiment');
  }
  return { head, testSha256, runnerSha256 };
}

async function waitPrimary(run, id, port, interrupted) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (interrupted()) throw new Error('Interrupted before primary readiness');
    const result = await run('docker', ['exec', id, 'mongosh', '--port', String(port), '--quiet',
      '--eval', 'if (!db.hello().isWritablePrimary) quit(1); print(db.adminCommand({buildInfo:1}).version)']);
    if (result.code === 0 && /^8\.0\.14$/.test(result.output)) return result.output;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error('Mongo replica-set primary not ready');
}

async function initializeReplica(run, id, port, interrupted) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (interrupted()) throw new Error('Interrupted before rs.initiate');
    const ping = await run('docker', ['exec', id, 'mongosh', '--port', String(port), '--quiet',
      '--eval', 'db.adminCommand({ping:1}).ok']);
    if (ping.code === 0 && ping.output.includes('1')) break;
    if (attempt === 59) throw new Error('Mongo did not start');
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  requireSuccess(await run('docker', ['exec', id, 'mongosh', '--port', String(port), '--quiet',
    '--eval', `rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:${port}'}]})`]), 'rs.initiate');
  return waitPrimary(run, id, port, interrupted);
}

async function invokeJest(run, port, db) {
  const env = { ...process.env, REDEMEINE_MONGO_URL: `mongodb://localhost:${port}/?replicaSet=rs0`,
    REDEMEINE_PRECODE_DB: db };
  return run('pnpm', ['exec', 'jest', '--config', 'jest.config.js', '--runInBand',
    '--runTestsByPath', 'packages/saga-runtime-store-tapeworm/integration/precode-intent-discovery.integration.test.ts'],
  { inherit: true, env });
}

export async function removeOwned(run, id) {
  if (!id) return { owned: false, absent: true };
  const removed = await run('docker', ['rm', '-f', id]);
  const remaining = await run('docker', ['ps', '-a', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}']);
  if (remaining.code !== 0 || remaining.output !== '') throw new Error(`Owned container cleanup unverified: ${id}`);
  return { owned: true, id, absent: true, removeExit: removed.code };
}

function expectedFromEnv() {
  return { head: process.env.REDEMEINE_EXPECTED_SHA, testSha256: process.env.REDEMEINE_EXPECTED_TEST_SHA256,
    runnerSha256: process.env.REDEMEINE_EXPECTED_RUNNER_SHA256 };
}

export async function runPrecode({ run = execute, port = availablePort, write = writeFileSync, expected = expectedFromEnv() } = {}) {
  const identity = await preflight(run, expected);
  const name = `vpwm-precode-${randomUUID()}`;
  const db = `vpwm_precode_${randomUUID().replaceAll('-', '')}`;
  const receiptPath = resolve('/tmp/opencode', `${name}.json`);
  if (!statSync(dirname(receiptPath)).isDirectory()) throw new Error('Receipt parent missing');
  const receipt = { issue: 'redemeine-vpwm.4.1', ...identity, database: db, image, containerName: name,
    digest: null, mongoVersion: null, jestExit: null, status: 'NOT_STARTED' };
  let id;
  let active;
  let interrupted;
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) =>
    [signal, () => { interrupted = signal; active?.kill?.(signal); }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const call = (cmd, args, options = {}) => run(cmd, args, { ...options, onChild: (child) => { active = child; } });
  try {
    receipt.digest = requireSuccess(await call('docker', ['image', 'inspect', image,
      '--format', '{{index .RepoDigests 0}}']), 'image digest');
    if (!/^mongo@sha256:[0-9a-f]{64}$/.test(receipt.digest)) throw new Error('Unverified Mongo image digest');
    const selectedPort = await port();
    receipt.port = selectedPort;
    id = requireSuccess(await call('docker', ['run', '--detach', '--rm', '--name', name,
      '--network', 'host', image, 'mongod', '--port', String(selectedPort), '--replSet', 'rs0', '--bind_ip_all']), 'docker run');
    ownedOnExit = id;
    receipt.containerId = id;
    receipt.mongoVersion = await initializeReplica(call, id, selectedPort, () => interrupted);
    if (interrupted) throw new Error(`Interrupted: ${interrupted}`);
    const result = await invokeJest(call, selectedPort, db);
    receipt.jestExit = result.code;
    if (result.code !== 0) throw new Error(`Jest exit ${result.code}`);
    receipt.status = 'PRECODE_EXPERIMENT_EXECUTED_NOT_CERTIFIED';
  } catch (error) {
    receipt.status = 'FAILED';
    receipt.failure = String(error);
  } finally {
    active = undefined;
    try { receipt.cleanup = await removeOwned(call, id); }
    catch (error) { receipt.cleanup = { verified: false, error: String(error) }; receipt.status = 'FAILED'; }
    if (receipt.cleanup.absent) ownedOnExit = undefined;
    for (const [signal, handler] of handlers) process.off(signal, handler);
    receipt.signal = interrupted ?? null;
    if (interrupted && receipt.status !== 'FAILED') receipt.status = 'INTERRUPTED';
    receipt.exit = receipt.status === 'PRECODE_EXPERIMENT_EXECUTED_NOT_CERTIFIED' ? 0 : 1;
    write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.info(`VPWM_RUNNER_RECEIPT=${receiptPath}`);
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPrecode().then((receipt) => { process.exitCode = receipt.exit; }, (error) => {
    console.error(error); process.exitCode = 1;
  });
}
