import { lstat, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MongoClient } from 'mongodb';
import { createProcessSignalSource } from '../src/processSignals';
import { budgets, issueId, QualificationError, assertLocalDaemon } from './plan';
import { Receipts, sanitizedLogs } from './receipts';
import { Commands, commandFailure } from './commands';
import { logLimits } from './logCapture';
import { OwnedDocker } from './docker';
import { record, one, assert, boundedJoin } from './schema';
import { assertCurrent, independentlyCleanup, within } from './cancellation';
import { createStack } from './stack';
import { runScenarios } from './scenarios';

async function collectLogs(docker: OwnedDocker, receipt: Receipts, signal: AbortSignal): Promise<void> {
  for (const resource of receipt.resources.filter((item) => item.kind === 'container' && item.id)) {
    if (!resource.id) continue;
    try {
      await docker.inspectContainer(resource.id, signal);
      const log = await docker.commands.docker('collect_owned_logs', ['container', 'logs', '--tail', String(logLimits.tailLines), resource.id], signal);
      await writeFile(join(receipt.root, `${resource.name}.log.json`), log.logs?.body ?? sanitizedLogs(log.stdout + log.stderr), { mode: 0o600 });
    } catch (error) {
      receipt.cleanupFailures.push('log_collection_failed');
      const failures = receipt.provenance.logCollectionFailures;
      receipt.provenance.logCollectionFailures = [...(Array.isArray(failures) ? failures : []), { resource: resource.name, kind: commandFailure(error) }];
    }
  }
}

async function verifyDaemon(docker: OwnedDocker, receipt: Receipts, signal: AbortSignal): Promise<void> {
  const context = await docker.commands.docker('verify_local_daemon', ['context', 'inspect'], signal);
  const value: unknown = JSON.parse(context.stdout);
  assertLocalDaemon(record(record(one(value).Endpoints).docker).Host);
  const info: unknown = JSON.parse((await docker.commands.docker('verify_daemon_caps', ['info', '--format', '{{json .}}'], signal)).stdout);
  const caps = record(info);
  assert(caps.OSType === 'linux' && caps.MemoryLimit === true && caps.SwapLimit === true && caps.CpuCfsQuota === true && caps.PidsLimit === true,
    'required_daemon_caps_unavailable');
  receipt.provenance.daemon = { serverVersion: caps.ServerVersion, memoryLimit: true, swapLimit: true, cpuQuota: true, pidsLimit: true };
}

async function cleanupOwned(docker: OwnedDocker, receipt: Receipts, clients: Set<MongoClient>): Promise<void> {
  const cleanup = new AbortController(); const timer = setTimeout(() => cleanup.abort(), budgets.cleanupMs);
  try {
    await collectLogs(docker, receipt, cleanup.signal);
    await docker.cleanup(cleanup.signal);
    if (!await boundedJoin(Promise.all([...clients].map((client) => client.close())), cleanup.signal)) {
      receipt.cleanupFailures.push('host_client_close_unjoined');
    }
  } finally { clearTimeout(timer); }
}

export async function runQualified(root: string, runId: string, digest: string): Promise<number> {
  const parent = await lstat('/tmp/opencode'); assert(parent.isDirectory() && !parent.isSymbolicLink(), 'qualification_receipt_parent_refused');
  const destination = await mkdtemp(`/tmp/opencode/hpq1-${runId}-`); const receipt = new Receipts(destination, runId);
  receipt.provenance.harnessDigest = digest;
  const controller = new AbortController(); const signals = createProcessSignalSource(process); const stop = () => controller.abort();
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  const deadline = performance.now() + 2400000; let stackTimer: ReturnType<typeof setTimeout> | undefined;
  const clients = new Set<MongoClient>(); const docker = new OwnedDocker(new Commands(root, receipt), receipt);
  const unjoined = (label: string) => { receipt.unjoinedOperations.push(label); receipt.outcome = 'fail'; };
  try {
    await independentlyCleanup(async () => {
      await verifyDaemon(docker, receipt, controller.signal);
      const stack = await createStack(root, docker, receipt, controller.signal, clients);
      assertCurrent(controller.signal, deadline);
      stackTimer = setTimeout(stop, budgets.stackMs);
      await runScenarios(stack); assertCurrent(controller.signal, deadline); receipt.outcome = 'pass';
    }, async () => {
      controller.abort(); docker.commands.beginCleanup();
      if (stackTimer) clearTimeout(stackTimer);
      await cleanupOwned(docker, receipt, clients);
    }, controller.signal, deadline, unjoined);
  } catch (error) {
    receipt.outcome = 'fail'; receipt.provenance.failureReason = error instanceof QualificationError ? error.reason : 'qualification_run_failed';
  } finally {
    controller.abort(); docker.commands.closeFence(); if (stackTimer) clearTimeout(stackTimer);
    if (receipt.cleanupFailures.length || receipt.unjoinedOperations.length || receipt.resources.some((item) => !item.removed)) receipt.outcome = 'fail';
    receipt.provenance.fullQualification = 'incomplete_fault_matrix';
    await within('final_receipt_write', () => receipt.save(), new AbortController().signal, performance.now() + budgets.commandMs, unjoined);
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
  }
  console.log(JSON.stringify({ issue: issueId, runId, outcome: receipt.outcome, receipt: destination, fullQualification: 'not_claimed' }));
  return receipt.outcome === 'pass' ? 0 : 1;
}
