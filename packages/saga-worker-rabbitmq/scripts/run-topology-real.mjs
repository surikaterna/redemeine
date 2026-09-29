import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installedPackageVersion, receiptPackageVersions } from './installed-versions.mjs';
import { createCommandRunner, RABBIT_IMAGE, recordAuditFailure, requireCleanHead, scenarioReport } from './topology-runner-core.mjs';
import { cleanupOwned, createOwned, inspectOwned, ownedResources, OWNER_LABEL, preflightOwned } from './topology-runner-ownership.mjs';
import ports from './topology-owned-ports.cjs';
import { finalizeAuditReceipt } from './topology-runner-receipt.mjs';
import { captureReadinessDiagnostics, redactDiagnostic, waitForRabbit } from './topology-runner-readiness.mjs';
import { topologyRabbitRunArgs } from './topology-real-run-args.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = `topology-${randomBytes(16).toString('hex')}`;
const names = { container: runId, volume: `${runId}-data`, network: `${runId}-net` };
const ownership = ownedResources(names, runId);
const receiptPath = `/tmp/opencode/redemeine-fyp3.4-${runId}.json`;
const reportPath = `/tmp/opencode/redemeine-fyp3.4-${runId}-jest.json`;
const runner = createCommandRunner(root);
const { run } = runner;
const docker = (args, options) => run('docker', args, options);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, runner.interrupt);

async function mappedPorts() {
  const verified = await inspectOwned(docker, ownership, 'container');
  if (!verified?.owned || verified.id !== ownership.ids.container) throw new Error('owned Rabbit identity mismatch');
  const mapping = async (port) => ports.mappedPort((await docker(['port', verified.id, `${port}/tcp`],
    { timeoutMs: 5_000, maxOutputBytes: 256 })).stdout);
  return { port: await mapping(5672), managementPort: await mapping(15672) };
}

async function setup(receipt) {
  await preflightOwned(docker, ownership);
  await docker(['pull', RABBIT_IMAGE]);
  const label = `${OWNER_LABEL}=${runId}`;
  await createOwned(docker, ownership, 'network', ['network', 'create', '--label', label, names.network]);
  await createOwned(docker, ownership, 'volume', ['volume', 'create', '--label', label, names.volume]);
  await createOwned(docker, ownership, 'container', topologyRabbitRunArgs(names, runId));
  await waitForRabbit(docker, runner, ownership, receipt);
  await docker(['exec', names.container, 'rabbitmqctl', 'add_user', 'topology_restricted', 'topology_restricted_password']);
  await docker(['exec', names.container, 'rabbitmqctl', 'set_permissions', '-p', '/', 'topology_restricted', '^$', '^$', '^$']);
  const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', RABBIT_IMAGE])).stdout;
  const containerId = (await docker(['inspect', '--format', '{{.Image}}', names.container])).stdout;
  const version = (await docker(['exec', names.container, 'rabbitmqctl', 'version'])).stdout.split('\n').at(-1);
  if (imageId !== containerId || version !== '4.1.4') throw new Error('Rabbit immutable image/version mismatch');
  return { imageId, version, ...await mappedPorts() };
}

async function tests(receipt, { port, managementPort }) {
  const env = { ...process.env, REDEMEINE_TOPOLOGY_RUN_ID: runId, REDEMEINE_TOPOLOGY_CONTAINER: names.container,
    REDEMEINE_TOPOLOGY_CONTAINER_ID: ownership.ids.container,
    REDEMEINE_TOPOLOGY_URL: `amqp://topology_owner:topology_owner_password@127.0.0.1:${port}`,
    REDEMEINE_TOPOLOGY_MANAGEMENT_URL: `http://127.0.0.1:${managementPort}`,
    REDEMEINE_TOPOLOGY_RESTRICTED_URL: `amqp://topology_restricted:topology_restricted_password@127.0.0.1:${port}` };
  const result = await run('pnpm', ['exec', 'jest', '--config', 'jest.config.js', '--runInBand', '--json', '--outputFile', reportPath,
    '--runTestsByPath', 'packages/saga-worker-rabbitmq/integration/topology-real.integration.test.ts'],
  { env, allowed: true, timeoutMs: 240_000 });
  receipt.testExitCode = result.code;
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  Object.assign(receipt, scenarioReport(report));
  const restartReached = ['broker-restart', 'restore-topology', 'held-unack', 'ack-settlement', 'dead-letter']
    .includes(receipt.scenarios[0]?.diagnostic?.phase);
  if (receipt.scenarios[0]?.status === 'passed' || restartReached) {
    try {
      const updated = await mappedPorts();
      receipt.restartPorts = { amqpOld: port, amqpNew: updated.port, amqpChanged: port !== updated.port,
        managementOld: managementPort, managementNew: updated.managementPort,
        managementChanged: managementPort !== updated.managementPort };
    } catch {
      receipt.restartPorts = { status: 'unavailable', amqpOld: port, managementOld: managementPort };
      if (receipt.scenarios[0]?.status === 'passed') throw new Error('owned Rabbit restart ports unavailable');
    }
  }
  if (result.code !== 0 || receipt.counts.failed !== 0 || receipt.counts.total !== 6) {
    throw new Error('Real topology Jest failed or omitted a scenario; inspect receipt');
  }
}

async function main() {
  const receipt = { issue: 'redemeine-fyp3.4', runId, image: RABBIT_IMAGE, startedAt: new Date().toISOString(),
    scenarios: [], counts: { passed: 0, failed: 0, total: 0 }, failure: null, exitCode: 1 };
  try {
    receipt.sha = await requireCleanHead(run);
    receipt.versions = { ...receiptPackageVersions(), amqplib: installedPackageVersion('amqplib', '2.0.1'),
      dispatcher: installedPackageVersion('tapeworm_dispatcher_mdb_rmq', '0.2.0'), tapeworm: installedPackageVersion('tapeworm', '0.6.0') };
    const service = await setup(receipt);
    receipt.imageId = service.imageId;
    receipt.rabbitmq = service.version;
    await tests(receipt, service);
    if (runner.interrupted) throw new Error('Real topology audit interrupted');
    receipt.exitCode = 0;
  } catch (error) {
    recordAuditFailure(receipt, 'initiating', error);
    if (receipt.readiness && receipt.readiness.status !== 'ready') {
      try { receipt.readinessDiagnostics = await captureReadinessDiagnostics(docker, ownership); }
      catch (diagnosticError) {
        receipt.readinessDiagnostics = { status: 'capture-failed', details: redactDiagnostic(String(diagnosticError)) };
      }
    }
    if (receipt.scenarios.some((scenario) => scenario.diagnostic?.phase === 'broker-restart')) {
      try { receipt.restartDiagnostics = await captureReadinessDiagnostics(docker, ownership); }
      catch (diagnosticError) {
        receipt.restartDiagnostics = { status: 'capture-failed', details: redactDiagnostic(String(diagnosticError)) };
      }
      const check = {};
      if (receipt.restartDiagnostics.status === 'verified-owner') {
        try { await waitForRabbit(docker, runner, ownership, check, { deadlineMs: 5_000, probeMs: 5_000, delayMs: 100 }); }
        catch { /* A diagnostic check never changes the first scenario failure. */ }
      }
      receipt.restartFinalAppCheck = check.readiness ?? { status: 'unverified-owner' };
    }
  } finally {
    try {
      receipt.cleanup = await cleanupOwned(docker, ownership);
      if (!receipt.cleanup.absent) recordAuditFailure(receipt, 'cleanup', new Error('owned resources not verified absent after cleanup'));
    } catch (error) {
      recordAuditFailure(receipt, 'cleanup', error);
    }
    await rm(reportPath, { force: true }).catch((error) => {
      recordAuditFailure(receipt, 'reportCleanup', error);
    });
    try {
      process.exitCode = finalizeAuditReceipt(receipt, runner, receiptPath);
      console.log(`Topology audit receipt: ${receiptPath}`);
    } catch (error) {
      process.exitCode = 1;
      console.error('Topology audit receipt write failed');
    }
  }
}

await main();
