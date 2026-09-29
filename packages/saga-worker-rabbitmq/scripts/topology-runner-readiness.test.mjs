import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommandRunner } from './topology-runner-core.mjs';
import { ownedResources, OWNER_LABEL } from './topology-runner-ownership.mjs';
import { captureReadinessDiagnostics, redactDiagnostic, waitForRabbit } from './topology-runner-readiness.mjs';

const runId = 'topology-0123456789abcdef0123456789abcdef';
const names = { container: runId, network: `${runId}-net`, volume: `${runId}-data` };

test('repeated nonzero ping records bounded last exit and deadline rather than signal', async () => {
  const receipt = {};
  const runner = { interrupted: false };
  const docker = async (_args, options) => {
    assert.equal(options.timeoutMs, 5);
    return { code: 69, stdout: 'RabbitMQ node down password=private', stderr: 'epmd unavailable token=private' };
  };
  await assert.rejects(waitForRabbit(docker, runner, runId, receipt, { deadlineMs: 250, probeMs: 5, delayMs: 2 }), /deadline exceeded/);
  assert.ok(receipt.readiness.attempts >= 2);
  assert.deepEqual(receipt.readiness.lastProbe, { status: 'exit', code: 69,
    stdout: { lineCount: 1, categories: ['node-unavailable'] }, stderr: { lineCount: 1, categories: ['node-unavailable'] } });
  assert.equal(receipt.readiness.status, 'deadline-exceeded');
  assert.doesNotMatch(JSON.stringify(receipt), /private/);
});

test('probe hang is individually bounded and reaped, with timeout distinguished from SIGTERM', async () => {
  const runner = createCommandRunner(process.cwd());
  const receipt = {};
  const docker = (_args, options) => runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
  await assert.rejects(waitForRabbit(docker, runner, runId, receipt, { deadlineMs: 150, probeMs: 50, delayMs: 0 }), /deadline exceeded/);
  assert.equal(receipt.readiness.lastProbe.status, 'probe-timeout');
  assert.equal(receipt.readiness.status, 'deadline-exceeded');
  const interrupted = { interrupted: false };
  const next = {};
  const externalSignal = async () => { interrupted.interrupted = true; return { code: 1, stdout: '', stderr: '' }; };
  await assert.rejects(waitForRabbit(externalSignal, interrupted, runId, next, { deadlineMs: 100 }), /external signal/);
  assert.equal(next.readiness.status, 'interrupted');
});

function diagnosticDocker(owner = runId) {
  const calls = [];
  const id = 'container-id';
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === 'container' && args[2] === runId) return { code: 0, stdout: JSON.stringify({
      Id: id, Name: `/${runId}`, Config: { Labels: { [OWNER_LABEL]: owner } }
    }) };
    if (args[0] === 'container' && args[2] === id) return { code: 0, stdout: JSON.stringify({
      Status: 'exited', Running: false, ExitCode: 70, Health: { Status: 'unhealthy' }
    }) };
    if (args[0] === 'logs') return { code: 0, stdout: 'ERROR password=private rabbitmq startup failed', stderr: 'token=secret' };
    throw new Error('unexpected docker call');
  };
  return { docker, calls };
}

test('verified exited container captures state and redacted bounded logs before cleanup', async () => {
  const mock = diagnosticDocker();
  const ownership = ownedResources(names, runId);
  ownership.ids.container = 'container-id';
  const details = await captureReadinessDiagnostics(mock.docker, ownership);
  assert.deepEqual(details.container, { id: 'container-id', status: 'exited', running: false, exitCode: 70, health: 'unhealthy' });
  assert.equal(details.status, 'verified-owner');
  assert.deepEqual(details.logs.stdout.categories, ['error']);
  assert.doesNotMatch(JSON.stringify(details), /private|secret/);
  mock.calls.push(['cleanup']);
  assert.deepEqual(mock.calls.map(([command]) => command), ['container', 'container', 'logs', 'cleanup']);
});

test('mismatched owner or ID withholds state and logs', async () => {
  for (const owner of ['foreign-owner', runId]) {
    const mock = diagnosticDocker(owner);
    const ownership = ownedResources(names, runId);
    ownership.ids.container = owner === runId ? 'different-id' : 'container-id';
    assert.deepEqual(await captureReadinessDiagnostics(mock.docker, ownership), { status: 'unverified-owner', logs: 'withheld' });
    assert.equal(mock.calls.length, 1);
  }
});

test('output redaction limits line count and never includes passwords, URLs or arbitrary log text', () => {
  const result = redactDiagnostic(Array.from({ length: 200 }, (_, index) => `ERROR amqp://user:password@host token=secret-${index}`).join('\n'));
  assert.equal(result.lineCount, 200);
  assert.equal(result.categories.length, 12);
  assert.ok(result.categories.every((category) => category === 'error'));
  assert.ok(JSON.stringify(result).length < 400);
  assert.doesNotMatch(JSON.stringify(result), /password|secret|user|amqp/);
});
