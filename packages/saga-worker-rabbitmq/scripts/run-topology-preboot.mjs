import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCommandRunner, RABBIT_IMAGE, recordAuditFailure, requireCleanHead } from './topology-runner-core.mjs';
import { cleanupOwned, ownedResources } from './topology-runner-ownership.mjs';
import { finalizeAuditReceipt } from './topology-runner-receipt.mjs';
import { cleanupCookieHelper, createPrebootResources, helperOwnership, inspectPreboot } from './topology-preboot-core.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = `topology-${randomBytes(16).toString('hex')}`;
const main = ownedResources({ container: runId, volume: `${runId}-data`, network: `${runId}-net` }, runId);
const helper = helperOwnership(main);
const receiptPath = `/tmp/opencode/redemeine-fyp3.3-${runId}-preboot.json`;
const runner = createCommandRunner(root);
const docker = (args, options) => runner.run('docker', args, options);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, runner.interrupt);

async function cleanupAll(receipt) {
  try {
    receipt.helperCleanup = await cleanupCookieHelper(docker, helper);
    if (!receipt.helperCleanup.absent) recordAuditFailure(receipt, 'helperCleanup', new Error('preboot helper not verified absent'));
  } catch { recordAuditFailure(receipt, 'helperCleanup', new Error('preboot helper cleanup failed')); }
  try {
    receipt.cleanup = await cleanupOwned(docker, main);
    if (!receipt.cleanup.absent) recordAuditFailure(receipt, 'cleanup', new Error('preboot owned resources not verified absent'));
  } catch { recordAuditFailure(receipt, 'cleanup', new Error('preboot owned cleanup failed')); }
}

async function mainRun() {
  const receipt = { issue: 'redemeine-fyp3.3', mode: 'preboot-metadata-only-no-topology-qualification', runCount: 1,
    runId, image: RABBIT_IMAGE, startedAt: new Date().toISOString(), failure: null, exitCode: 1 };
  try {
    receipt.sha = await requireCleanHead(runner.run);
    await createPrebootResources(docker, main);
    const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', RABBIT_IMAGE])).stdout;
    const containerImageId = (await docker(['inspect', '--format', '{{.Image}}', main.ids.container])).stdout;
    if (!imageId || imageId !== containerImageId) throw new Error('preboot image mismatch');
    receipt.imageId = imageId;
    Object.assign(receipt, await inspectPreboot(docker, main, helper));
    receipt.exitCode = 0;
  } catch { recordAuditFailure(receipt, 'initiating', new Error('preboot metadata probe failed closed')); }
  finally {
    await cleanupAll(receipt);
    try {
      process.exitCode = finalizeAuditReceipt(receipt, runner, receiptPath);
      console.log(`Preboot metadata-only receipt: ${receiptPath}`);
    } catch { process.exitCode = 1; console.error('Preboot metadata receipt creation failed'); }
  }
}

await mainRun();
