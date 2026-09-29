import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scenarioReport } from './topology-runner-core.mjs';
import { finalizeAuditReceipt } from './topology-runner-receipt.mjs';
import { MARKER, phaseFromJest } from './topology-phase-report.mjs';

const source = 'integration/topology-real.integration.test.ts';
const marker = (data) => `${MARKER}${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
const diagnostic = (phase, errorClass, code, expected, actual) => ({ phase, invariant: phase === 'held-unack' ?
  'held-unack-one' : phase === 'mismatch-reply-406' ? 'reply-code-406' : 'reply-code-403',
  errorClass, code, replyCode: code, expected, actual, source, line: 156 });

test('known Jest marker survives categorical redaction; foreign text and secrets never reach receipt', () => {
  const tests = [
    { title: 'held', status: 'failed', detail: diagnostic('held-unack', 'timeout', null, null, null) },
    { title: '406', status: 'failed', detail: diagnostic('mismatch-reply-406', 'broker-reply', 403, 406, 403) },
    { title: '403', status: 'failed', detail: diagnostic('restricted-reply-403', 'broker-reply', 406, 403, 406) }
  ];
  const assertions = tests.map(({ title, status, detail }) => ({ ancestorTitles: ['owned Rabbit'], title, status,
    failureMessages: [`secret amqp://user:pass@host Basic c2VjcmV0 ${marker(detail)} topology_restricted_password`] }));
  const report = scenarioReport({ testResults: [{ assertionResults: assertions }] });
  assert.deepEqual(report.counts, { total: 3, failed: 3, passed: 0 });
  assert.deepEqual(report.scenarios.map((entry) => entry.diagnostic), tests.map(({ detail }) => detail));
  const receipt = { startedAt: new Date().toISOString(), sha: 'a'.repeat(40), failure: null, exitCode: 1,
    cleanup: { absent: true }, ...report };
  let text;
  assert.equal(finalizeAuditReceipt(receipt, { complete: () => true }, 'unused', (_, result) => { text = result; }), 1);
  assert.deepEqual(JSON.parse(text).scenarios.map((entry) => entry.diagnostic), tests.map(({ detail }) => detail));
  assert.doesNotMatch(text, /topology_restricted_password|user:pass|Basic c2VjcmV0|\bsecret\b/);
});

test('unknown, malformed or spoofed marker remains unknown and cannot manufacture a passing scenario', () => {
  for (const failures of [['no marker password=private'], [`${MARKER}garbage`],
    [marker({ ...diagnostic('held-unack', 'timeout', null, null, null), phase: 'invented-secret' })]]) {
    const result = phaseFromJest({ failureMessages: failures });
    assert.deepEqual(result, { phase: 'unknown', invariant: 'unknown', errorClass: 'unknown', code: null,
      replyCode: null, expected: null, actual: null, source, line: 0 });
  }
  const report = scenarioReport({ testResults: [{ assertionResults: [{ ancestorTitles: [], title: 'unknown',
    status: 'failed', failureMessages: ['password=private'] }] }] });
  assert.equal(report.counts.failed, 1);
  assert.equal(report.scenarios[0].diagnostic.phase, 'unknown');
});

test('blocked negative cases retain blocked_on_broker_unavailable without claiming 403/406', () => {
  const data = { phase: 'restricted-user-setup', invariant: 'broker-available', errorClass: 'blocked_on_broker_unavailable',
    code: null, replyCode: null, expected: null, actual: null, source, line: 250 };
  const diagnostic = phaseFromJest({ failureMessages: [marker(data)] });
  assert.deepEqual(diagnostic, data);
  assert.equal(diagnostic.code, null);
});
