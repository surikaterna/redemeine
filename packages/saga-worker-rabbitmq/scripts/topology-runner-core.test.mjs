import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommandRunner, RABBIT_IMAGE, recordAuditFailure, requireCleanHead, scenarioReport } from './topology-runner-core.mjs';

test('offline preflight requires clean exact SHA and immutable Rabbit digest', async () => {
  const sha = 'a'.repeat(40);
  const clean = async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? sha : '' });
  assert.equal(await requireCleanHead(clean), sha);
  assert.match(RABBIT_IMAGE, /^rabbitmq:4\.1\.4-management-alpine@sha256:[0-9a-f]{64}$/);
  const dirty = async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? sha : ' M source.ts' });
  await assert.rejects(requireCleanHead(dirty), /clean/);
});

test('offline receipt reports names, durations, failures and scenario counts', () => {
  assert.deepEqual(scenarioReport({ testResults: [{ assertionResults: [
    { ancestorTitles: ['topology'], title: 'ACK', status: 'passed', duration: 12, failureMessages: [] },
    { ancestorTitles: ['topology'], title: 'NACK', status: 'failed', duration: 15, failureMessages: ['failure'] }
  ] }] }), {
    scenarios: [
      { name: 'topology > ACK', status: 'passed', durationMs: 12, failures: [] },
      { name: 'topology > NACK', status: 'failed', durationMs: 15, failures: ['redacted-operation-failure'] }
    ], counts: { passed: 1, failed: 1, total: 2 }
  });
});

test('cleanup failure cannot mask initiating error or produce PASS', () => {
  const receipt = { failure: null, exitCode: 0 };
  recordAuditFailure(receipt, 'initiating', new Error('network preflight rejected'));
  recordAuditFailure(receipt, 'cleanup', new Error('postcheck unverified'));
  assert.deepEqual(receipt.failure, receipt.initiatingError);
  assert.equal(receipt.initiatingError.phase, 'initiating');
  assert.equal(receipt.cleanupError.phase, 'cleanup');
  assert.equal(receipt.cleanupError.summary, 'redacted-operation-failure');
  assert.equal(receipt.exitCode, 1);
});

test('offline signal interrupts and reaps an owned child group before cleanup commands', async () => {
  const runner = createCommandRunner(process.cwd());
  const child = runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  runner.interrupt();
  await assert.rejects(child, /interrupted/);
  assert.equal(runner.interrupted, true);
  const cleaned = await runner.run(process.execPath, ['-e', 'process.exit(0)'], { cleanup: true });
  assert.equal(cleaned.code, 0);
});
