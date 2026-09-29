import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runOwnedChild } from './owned-child-run.mjs';
import { crashProcessReport, crashProofComplete, crashScenarioReport, runCrashJest } from './crash-run-report.mjs';
import { assertScenarioEvidence } from './real-stack-selection.mjs';

test('deadline terminates an owned Jest-like group including its grandchild and waits for close', async () => {
  let pid = 0;
  const script = `const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log(grandchild.pid); setInterval(() => {}, 1000);`;
  const result = await runOwnedChild(process.execPath, ['-e', script], {
    capture: true, timeoutMs: 250, graceMs: 30, onSpawn: child => { pid = child.pid; }
  });
  assert.notEqual(pid, process.pid);
  assert.equal(result.timedOut, true);
  const grandchild = Number(result.stdout);
  assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0);
  const state = await readFile(`/proc/${grandchild}/stat`, 'utf8').then(text => text.split(' ')[2], () => 'gone');
  assert.ok(['gone', 'Z', 'X'].includes(state), `grandchild remained running: ${state}`);
});

test('injected credentials in both child streams cannot reach console or receipt on failure', async () => {
  const password = 'private-test-only';
  const uri = `amqp://worker:${password}@127.0.0.1:5672/vhost`;
  const logs = [];
  const priorLog = console.log;
  console.log = (...values) => { logs.push(values.join(' ')); };
  let result;
  try {
    const script = `process.stdout.write(process.env.RUN_SECRET.repeat(9000), () =>
      process.stderr.write(process.env.RUN_URI.repeat(9000), () => process.exit(2)));`;
    result = await runCrashJest(process.execPath, ['-e', script], {
      env: { ...process.env, RUN_SECRET: password, RUN_URI: uri },
      maxOutputBytes: 128, timeoutMs: 2_000
    });
    console.log('Real-stack receipt: /tmp/opencode/sanitized-test.json');
  } finally { console.log = priorLog; }
  assert.equal(result.code, 2);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(result.output, { stdoutBytes: 129, stderrBytes: 129,
    stdoutTruncated: true, stderrTruncated: true, maxBytes: 128 });
  const suite = 'saga-retry-crash-real.integration.test.ts';
  const report = { success: false, testResults: [{ name: `/workspace/integration/${suite}`,
    assertionResults: [{ status: 'failed', title: uri, duration: 4, failureMessages: [password, uri] }] }] };
  const scenarios = crashScenarioReport(report);
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].status, 'failed');
  assert.throws(() => assertScenarioEvidence(report, [suite]));
  const receipt = JSON.stringify({ issue: 'redemeine-fyp3.5.3.1', scenarios, crashProcess: crashProcessReport(result),
    failure: 'sanitized crash runner failure' });
  assert.ok(!`${logs.join(' ')}${receipt}`.includes(password));
  assert.ok(!`${logs.join(' ')}${receipt}`.includes(uri));
});

test('timeout evidence has a fixed category without secret fields or a false PASS', () => {
  const outcome = crashProcessReport({ timedOut: true, code: 1, output: { stdoutBytes: 9_000,
    stderrBytes: 9_000, stdoutTruncated: true, stderrTruncated: true } });
  assert.deepEqual(outcome, { phase: 'jest-process', source: 'owned-child-run', errorClass: 'timeout', exitCode: 1,
    stdoutBytes: 4_097, stderrBytes: 4_097, stdoutTruncated: true, stderrTruncated: true });
  assert.deepEqual(crashScenarioReport(null), []);
});

test('successful Jest JSON cannot qualify unverified app resources or an initiating failure', () => {
  const absent = { status: 'absent', reason: 'none' };
  const proof = { success: true, firstFailure: null, cleanupFailure: null, exitSignal: 'SIGKILL',
    cleanup: { ownedChildrenReaped: true, amqpClosed: true, mongoClosed: true,
      resources: { db: absent, user: absent, vhost: absent } } };
  assert.equal(crashProofComplete(proof), true);
  assert.equal(crashProofComplete({ ...proof, firstFailure: { phase: 'child-ready', errorClass: 'operation' } }), false);
  assert.equal(crashProofComplete({ ...proof, cleanup: { ...proof.cleanup,
    resources: { ...proof.cleanup.resources, user: { status: 'owner_mismatch', reason: 'owner_mismatch' } } } }), false);
});
