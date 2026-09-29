import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createCommandRunner, recordAuditFailure } from './topology-runner-core.mjs';
import { finalizeAuditReceipt, writeAtomicReceipt } from './topology-runner-receipt.mjs';

function fixture() {
  const runner = createCommandRunner(process.cwd());
  const receipt = { startedAt: new Date().toISOString(), sha: 'a'.repeat(40),
    cleanup: { absent: true }, counts: { passed: 5, failed: 0, total: 5 }, exitCode: 0, failure: null };
  let persisted;
  const write = (_path, text) => { persisted = JSON.parse(text); };
  return { runner, receipt, write, persisted: () => persisted };
}

test('signal after tests before cleanup forces receipt failure despite successful cleanup', () => {
  const audit = fixture();
  audit.runner.interrupt();
  assert.equal(finalizeAuditReceipt(audit.receipt, audit.runner, 'unused', audit.write), 1);
  assert.match(audit.persisted().interruptError, /interrupted/);
  assert.equal(audit.persisted().exitCode, 1);
});

test('signal during cleanup retains initiating and cleanup evidence and never passes', async () => {
  const audit = fixture();
  recordAuditFailure(audit.receipt, 'initiating', new Error('test failed'));
  const fakeCleanup = async () => { audit.runner.interrupt(); return { absent: false }; };
  audit.receipt.cleanup = await fakeCleanup();
  assert.equal(finalizeAuditReceipt(audit.receipt, audit.runner, 'unused', audit.write), 1);
  assert.equal(audit.persisted().failure, 'test failed');
  assert.match(audit.persisted().cleanupError, /not verified absent/);
  assert.match(audit.persisted().interruptError, /interrupted/);
});

test('signal immediately before final receipt is failure; after completion cannot change PASS', () => {
  const before = fixture();
  before.runner.interrupt();
  assert.equal(finalizeAuditReceipt(before.receipt, before.runner, 'unused', before.write), 1);
  assert.equal(before.persisted().exitCode, 1);
  const after = fixture();
  const atomicWriter = (path, text) => { after.runner.interrupt(); after.write(path, text); };
  assert.equal(finalizeAuditReceipt(after.receipt, after.runner, 'unused', atomicWriter), 0);
  after.runner.interrupt();
  after.runner.interrupt();
  assert.equal(after.runner.interrupted, false);
  assert.equal(after.persisted().exitCode, 0);
});

test('atomic receipt uses private mode and renames complete bytes without leaving temporary file', () => {
  const directory = mkdtempSync('/tmp/opencode/topology-receipt-offline-');
  try {
    const path = join(directory, 'receipt.json');
    writeAtomicReceipt(path, '{"complete":true}\n');
    assert.equal(readFileSync(path, 'utf8'), '{"complete":true}\n');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => statSync(`${path}.${process.pid}.tmp`), { code: 'ENOENT' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
