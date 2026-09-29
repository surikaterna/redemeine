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

test('each production failure phase survives synthetic Jest JSON to receipt without leaking publisher output', () => {
  const steps = [
    ['production-health', 'broker-available'], ['production-open', 'owner-channel-open'],
    ['production-provision', 'declared-and-bound'], ['production-inspect', 'broker-inspected'],
    ['production-publisher-connect', 'publisher-connected'], ['production-publisher-publish', 'publisher-confirmed'],
    ['production-publisher-close', 'publisher-closed'], ['production-delivery', 'publisher-observed'],
    ['production-wrong-partition', 'mandatory-return'], ['production-wrong-collection', 'mandatory-return'],
    ['production-wrong-tenant', 'mandatory-return'], ['production-ready', 'queue-ready-one'],
    ['broker-restart', 'same-volume-restarted'],
    ['production-reopen', 'owner-channel-open'], ['production-retained-topology', 'retained-before-provision'],
    ['production-retained-message', 'publisher-observed'], ['production-reprovision', 'declared-and-bound'],
    ['production-held-ack', 'queue-acked-zero'], ['production-dlq', 'dead-letter-visible'],
    ['production-close', 'channel-closed']
  ];
  const failure = 'amqp://user:pass@host Basic c2VjcmV0 topology_restricted_password';
  const assertions = steps.map(([phase, invariant]) => ({ ancestorTitles: ['owned Rabbit'], title: phase, status: 'failed',
    failureMessages: [`${failure} ${marker({ phase, invariant, errorClass: 'broker-reply', code: 403,
      replyCode: 403, expected: null, actual: null, source, line: 290 })} ${failure}`] }));
  const report = scenarioReport({ testResults: [{ assertionResults: assertions }] });
  assert.deepEqual(report.counts, { passed: 0, failed: steps.length, total: steps.length });
  let output;
  finalizeAuditReceipt({ startedAt: new Date().toISOString(), sha: 'a'.repeat(40), failure: null,
    exitCode: 1, cleanup: { absent: true }, ...report }, { complete: () => true }, 'unused', (_, text) => { output = text; });
  assert.deepEqual(JSON.parse(output).scenarios.map(({ diagnostic: { phase, invariant, code } }) => [phase, invariant, code]),
    steps.map(([phase, invariant]) => [phase, invariant, 403]));
  assert.doesNotMatch(output, /user:pass|c2VjcmV0|topology_restricted_password/);
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

test('failed restart and blocked negatives share fixed allowlisted restart gate without secrets', () => {
  const evidence = { restartSubphase: 'amqp-connect', restartDocker: true, restartApp: true,
    restartAmqp: false, amqpErrorClass: 'ACCESS_REFUSED', amqpCode: 403 };
  const restart = { ...diagnostic('broker-restart', 'operation', null, null, null),
    invariant: 'same-volume-restarted', ...evidence };
  const blocked = { ...diagnostic('mismatch-setup', 'blocked_on_broker_unavailable', null, null, null),
    invariant: 'broker-available', ...evidence };
  assert.deepEqual(phaseFromJest({ failureMessages: [`Basic c2VjcmV0 ${marker(restart)}`] }), restart);
  assert.deepEqual(phaseFromJest({ failureMessages: [marker(blocked)] }), blocked);
  assert.equal(phaseFromJest({ failureMessages: [marker({ ...restart, amqpErrorClass: 'Basic c2VjcmV0' })] }).phase, 'unknown');
});

test('bounded AMQP 530/404/403 codes survive Jest JSON to private sanitized receipt', () => {
  for (const amqpCode of [530, 404, 403]) {
    const detail = { ...diagnostic('broker-restart', 'operation', null, null, null),
      invariant: 'same-volume-restarted', restartSubphase: 'amqp-connect', restartDocker: true,
      restartApp: true, restartAmqp: false, amqpErrorClass: amqpCode === 403 ? 'ACCESS_REFUSED' : 'unknown',
      amqpCode, message: 'amqp://user:pass@host Basic c2VjcmV0' };
    const report = scenarioReport({ testResults: [{ assertionResults: [{ ancestorTitles: ['owned Rabbit'],
      title: 'restart', status: 'failed', failureMessages: [`password=private ${marker(detail)}`] }] }] });
    assert.equal(report.scenarios[0].diagnostic.amqpCode, amqpCode);
    let output;
    assert.equal(finalizeAuditReceipt({ startedAt: new Date().toISOString(), sha: 'a'.repeat(40),
      failure: null, exitCode: 1, cleanup: { absent: true }, ...report },
    { complete: () => true }, 'unused', (_, result) => { output = result; }), 1);
    const received = JSON.parse(output).scenarios[0].diagnostic;
    assert.equal(received.amqpCode, amqpCode);
    assert.equal(received.phase, 'broker-restart');
    assert.equal(received.errorClass, 'operation');
    assert.doesNotMatch(output, /user:pass|c2VjcmV0|password=private/);
  }
});

test('invalid AMQP codes cannot forge a numeric restart failure in Jest JSON or receipt', () => {
  for (const invalid of [-1, 1000, 1.5, '530']) {
    const data = { ...diagnostic('broker-restart', 'operation', null, null, null),
      invariant: 'same-volume-restarted', restartSubphase: 'amqp-connect', restartDocker: true,
      restartApp: true, restartAmqp: false, amqpErrorClass: 'unknown', amqpCode: invalid };
    const report = scenarioReport({ testResults: [{ assertionResults: [{ ancestorTitles: [], title: 'restart',
      status: 'failed', failureMessages: [`Basic c2VjcmV0 ${marker(data)}`] }] }] });
    assert.equal(report.scenarios[0].diagnostic.phase, 'unknown');
    let output;
    finalizeAuditReceipt({ startedAt: new Date().toISOString(), sha: 'a'.repeat(40), failure: null,
      exitCode: 1, cleanup: { absent: true }, ...report }, { complete: () => true }, 'unused', (_, result) => { output = result; });
    assert.equal(JSON.parse(output).scenarios[0].diagnostic.amqpCode, undefined);
    assert.doesNotMatch(output, /c2VjcmV0/);
  }
  // JSON cannot represent NaN; it becomes null, never a numeric AMQP code.
  assert.equal(phaseFromJest({ failureMessages: [marker({ ...diagnostic('broker-restart', 'operation', null, null, null),
    invariant: 'same-volume-restarted', restartSubphase: 'amqp-connect', restartDocker: true,
    restartApp: true, restartAmqp: false, amqpErrorClass: 'unknown', amqpCode: Number.NaN })] }).amqpCode, null);
});
