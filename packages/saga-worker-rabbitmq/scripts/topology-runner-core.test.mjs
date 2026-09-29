import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupOwned, createCommandRunner, RABBIT_IMAGE, requireCleanHead, scenarioReport } from './topology-runner-core.mjs';

test('offline preflight requires clean exact SHA and immutable Rabbit digest', async () => {
  const sha = 'a'.repeat(40);
  const clean = async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? sha : '' });
  assert.equal(await requireCleanHead(clean), sha);
  assert.match(RABBIT_IMAGE, /^rabbitmq:4\.1\.4-management-alpine@sha256:[0-9a-f]{64}$/);
  const dirty = async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? sha : ' M source.ts' });
  await assert.rejects(requireCleanHead(dirty), /clean/);
});

test('offline cleanup deletes only owned names and fails if any object remains', async () => {
  const names = { container: 'topology-ours', volume: 'topology-ours-data', network: 'topology-ours-net' };
  const calls = [];
  const docker = async (args) => { calls.push(args); return { code: args.includes('inspect') ? 1 : 0 }; };
  assert.equal((await cleanupOwned(docker, names)).absent, true);
  assert.deepEqual(calls, [
    ['rm', '-f', names.container], ['volume', 'rm', names.volume], ['network', 'rm', names.network],
    ['container', 'inspect', names.container], ['volume', 'inspect', names.volume], ['network', 'inspect', names.network]
  ]);
  const remaining = async (args) => ({ code: args.includes('inspect') && args[0] === 'volume' ? 0 : 1 });
  assert.equal((await cleanupOwned(remaining, names)).absent, false);
});

test('offline receipt reports names, durations, failures and scenario counts', () => {
  assert.deepEqual(scenarioReport({ testResults: [{ assertionResults: [
    { ancestorTitles: ['topology'], title: 'ACK', status: 'passed', duration: 12, failureMessages: [] },
    { ancestorTitles: ['topology'], title: 'NACK', status: 'failed', duration: 15, failureMessages: ['failure'] }
  ] }] }), {
    scenarios: [
      { name: 'topology > ACK', status: 'passed', durationMs: 12, failures: [] },
      { name: 'topology > NACK', status: 'failed', durationMs: 15, failures: ['failure'] }
    ], counts: { passed: 1, failed: 1, total: 2 }
  });
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
