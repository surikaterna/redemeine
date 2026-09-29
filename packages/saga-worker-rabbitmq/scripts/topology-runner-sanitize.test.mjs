import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { recordAuditFailure, scenarioReport } from './topology-runner-core.mjs';
import { finalizeAuditReceipt } from './topology-runner-receipt.mjs';
import { failureCategory, safeFailure, sanitizeReceipt } from './topology-runner-sanitize.mjs';

const credentials = ['topology_restricted_password', 'amqp://user:pass@localhost:5672', 'Basic dXNlcjpwYXNz', 'Bearer private-token'];

test('structured first failure records phase, exit, category, nested cause without raw CLI credentials', () => {
  const cause = new Error(`Basic dXNlcjpwYXNz ${credentials[0]}`);
  const error = Object.assign(new Error("this command requires the 'rabbit' app to be running"), {
    operation: 'docker:exec', exitCode: 64, stderr: `add_user ${credentials[0]} ${credentials[1]}`, cause
  });
  const receipt = { failure: null, exitCode: 0 };
  recordAuditFailure(receipt, 'initiating', error);
  recordAuditFailure(receipt, 'cleanup', new Error('cleanup uncertain'));
  assert.deepEqual(receipt.initiatingError, { phase: 'initiating', operation: 'docker:exec', exitCode: 64,
    stderrCategory: 'redacted-operation-failure', summary: 'rabbit-app-not-running', causeCategory: 'redacted-operation-failure' });
  assert.equal(receipt.failure.phase, 'initiating');
  assert.equal(receipt.exitCode, 1);
  assert.ok(credentials.every((secret) => !JSON.stringify(receipt).includes(secret)));
});

test('Jest nested failures and arbitrary receipt fields cannot expose credentials or false PASS', () => {
  const report = { testResults: [{ assertionResults: [{ ancestorTitles: ['owned Rabbit'], title: 'test',
    status: 'failed', failureMessages: credentials.map((secret) => `Error: ${secret}`) }] }] };
  const receipt = { startedAt: new Date().toISOString(), sha: 'a'.repeat(40),
    cleanup: { absent: false, postCleanup: [{ error: `permission denied ${credentials[0]}` }] },
    ...scenarioReport(report), details: { nested: { url: credentials[1], auth: credentials[2], password: credentials[0] } },
    failure: null, exitCode: 0 };
  let output;
  const writer = (_path, text) => { output = text; };
  assert.equal(finalizeAuditReceipt(receipt, { complete: () => true }, 'unused', writer), 1);
  assert.equal(JSON.parse(output).cleanupError.phase, 'cleanup');
  assert.ok(credentials.every((secret) => !output.includes(secret)));
  assert.ok(output.includes('[REDACTED]'));
});

test('sanitizer bounds unexpected free text and categorizes app readiness without printing raw strings', () => {
  assert.equal(failureCategory("requires the 'rabbit' app to be running"), 'rabbit-app-not-running');
  assert.deepEqual(safeFailure(Object.assign(new Error('failed'), { operation: 'docker:exec', exitCode: 64 }), 'setup').exitCode, 64);
  const candidate = sanitizeReceipt({ failures: ['nested password=mysecret'], name: 'Basic dXNlcjpwYXNz',
    arbitrary: 'x'.repeat(999), image: 'rabbitmq:4.1.4-management-alpine@sha256:' + 'a'.repeat(64) });
  assert.equal(candidate.failures[0], 'redacted-operation-failure');
  assert.equal(candidate.name, '[REDACTED]');
  assert.equal(candidate.arbitrary, '[REDACTED]');
  assert.equal(candidate.image.startsWith('rabbitmq:'), true);
  assert.equal(sanitizeReceipt({ unexpected: 'unmarked-private-value' }).unexpected, '[REDACTED]');
});

test('active runner console output exposes only receipt location or fixed failure text', () => {
  const source = readFileSync(new URL('./run-topology-real.mjs', import.meta.url), 'utf8');
  assert.match(source, /console\.log\(`Topology audit receipt: \$\{receiptPath\}`\)/);
  assert.match(source, /console\.error\('Topology audit receipt write failed'\)/);
  assert.doesNotMatch(source, /console\.(log|error)\([^\n]*(String\(error\)|stderr|stdout|args|failureMessages)/);
});
