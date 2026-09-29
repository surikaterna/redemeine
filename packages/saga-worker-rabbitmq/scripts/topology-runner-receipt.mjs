import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { recordAuditFailure } from './topology-runner-core.mjs';
import { sanitizeReceipt } from './topology-runner-sanitize.mjs';

export function writeAtomicReceipt(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    // Never unlink a file that this invocation failed to create.
    if (created) rmSync(temporary, { force: true });
    throw error;
  }
}

export function finalizeAuditReceipt(receipt, runner, path, write = writeAtomicReceipt) {
  // The synchronous complete-to-rename section is the linearization point: later signals do not change the result.
  if (!runner.complete()) recordAuditFailure(receipt, 'interrupt', new Error('Real topology audit interrupted'));
  if (runner.terminationFailure) recordAuditFailure(receipt, 'termination', runner.terminationFailure);
  if (!receipt.cleanup?.absent) recordAuditFailure(receipt, 'cleanup', new Error('owned resources not verified absent after cleanup'));
  receipt.finishedAt = new Date().toISOString();
  receipt.elapsedMs = Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt);
  receipt.scenarioSha = receipt.sha ?? null;
  const sanitized = sanitizeReceipt(receipt);
  sanitized.sha256 = createHash('sha256').update(JSON.stringify(sanitized)).digest('hex');
  write(path, `${JSON.stringify(sanitized, null, 2)}\n`);
  return receipt.exitCode;
}
