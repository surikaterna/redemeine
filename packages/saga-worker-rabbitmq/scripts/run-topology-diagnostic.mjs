import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCommandRunner, RABBIT_IMAGE, recordAuditFailure, requireCleanHead } from './topology-runner-core.mjs';
import { cleanupOwned, ownedResources } from './topology-runner-ownership.mjs';
import { finalizeAuditReceipt } from './topology-runner-receipt.mjs';
import { awaitDiagnosticStartup, captureDiagnosticLogs, createDiagnosticResources, diagnosticCause } from './topology-diagnostic-core.mjs';
import { cleanupCookieHelper, helperOwnership, inspectCookieMetadata } from './topology-diagnostic-cookie.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = `topology-${randomBytes(16).toString('hex')}`;
const names = { container: runId, network: `${runId}-net`, volume: `${runId}-data` };
const ownership = ownedResources(names, runId);
const helper = helperOwnership(ownership);
const rawPath = `/tmp/opencode/redemeine-fyp3.3-${runId}-startup.log`;
const receiptPath = `/tmp/opencode/redemeine-fyp3.3-${runId}-diagnostic.json`;
const runner = createCommandRunner(root);
const docker = (args, options) => runner.run('docker', args, options);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, runner.interrupt);

async function verifyImage() {
  const image = (await docker(['image', 'inspect', '--format', '{{.Id}}', RABBIT_IMAGE])).stdout;
  const running = (await docker(['inspect', '--format', '{{.Image}}', ownership.ids.container])).stdout;
  if (!image || image !== running) throw new Error('image identity mismatch');
  return image;
}

async function captureBeforeCleanup(receipt) {
  if (!ownership.attempted.has('container') || ownership.collisions.has('container')) return;
  try {
    receipt.startupLogs = await captureDiagnosticLogs(docker, ownership, rawPath);
    receipt.rawLogPath = rawPath;
  } catch (error) {
    receipt.logCapture = { status: 'failed-or-unverified', cause: diagnosticCause(String(error)) };
    recordAuditFailure(receipt, 'diagnostic', new Error('owned startup log capture failed'));
  }
}

async function captureCookieMetadata(receipt) {
  if (!ownership.attempted.has('container') || ownership.collisions.has('container')) return;
  try {
    receipt.cookieMetadata = await inspectCookieMetadata(docker, ownership, helper);
    if (receipt.cookieMetadata.status !== 'ok') recordAuditFailure(receipt, 'cookie', new Error('cookie metadata unavailable'));
  } catch {
    receipt.cookieMetadata = { status: 'owner-or-helper-unverified' };
    recordAuditFailure(receipt, 'cookie', new Error('cookie metadata inspection failed'));
  } finally {
    try {
      receipt.helperCleanup = await cleanupCookieHelper(docker, helper);
      if (!receipt.helperCleanup.absent) recordAuditFailure(receipt, 'helperCleanup', new Error('owned helper cleanup not verified'));
    } catch {
      recordAuditFailure(receipt, 'helperCleanup', new Error('owned helper cleanup failed'));
    }
  }
}

async function main() {
  const receipt = { issue: 'redemeine-fyp3.3', mode: 'diagnostic-only-no-topology-qualification', runCount: 1,
    runId, image: RABBIT_IMAGE, startedAt: new Date().toISOString(), failure: null, exitCode: 1 };
  try {
    receipt.sha = await requireCleanHead(runner.run);
    await createDiagnosticResources(docker, ownership);
    receipt.imageId = await verifyImage();
    await awaitDiagnosticStartup(docker, runner, ownership, receipt);
    if (receipt.startup.status !== 'ready') throw new Error('Rabbit did not reach diagnostic readiness');
    receipt.exitCode = 0;
  } catch (error) {
    recordAuditFailure(receipt, 'initiating', new Error(`diagnostic startup failed: ${diagnosticCause(String(error))}`));
  } finally {
    await captureBeforeCleanup(receipt);
    await captureCookieMetadata(receipt);
    try {
      receipt.cleanup = await cleanupOwned(docker, ownership);
      if (!receipt.cleanup.absent) recordAuditFailure(receipt, 'cleanup', new Error('owned cleanup not verified absent'));
    } catch {
      recordAuditFailure(receipt, 'cleanup', new Error('owned cleanup inspection failed'));
    }
    try {
      process.exitCode = finalizeAuditReceipt(receipt, runner, receiptPath);
      console.log(`Diagnostic-only receipt: ${receiptPath}`);
    } catch {
      process.exitCode = 1;
      console.error('Diagnostic-only receipt creation failed');
    }
  }
}

await main();
