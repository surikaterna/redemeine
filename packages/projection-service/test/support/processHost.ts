import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VerifiedArtifact } from '../../src/artifact';
import { parseConfig } from '../../src/config';
import { ProjectionHost } from '../../src/host';
import type { HostResource } from '../../src/hostAttempt';
import { Observations } from '../../src/observability';
import { acquireAtRoot, OwnershipError } from '../../src/ownership';
import { referenceResource } from '../../src/reference/hostResource';
import { createReferenceRuntime, waitForModelTurn } from '../../src/reference/runtime';
import { firstSource, modelCommit } from '../../src/reference/scenario';
import type { SessionFence } from '../../src/sessionFence';
import { selectExternalInfrastructure } from '../../src/infrastructure/external';
import { createProcessSignalSource } from '../../src/processSignals';

const root = process.argv[2];
const scenario = process.argv[3] ?? 'reference';
if (!root) throw new Error('test_root_required');
const controller = new AbortController();
const acquire = (signal: AbortSignal) => acquireAtRoot(root, signal, { ancestorBoundary: tmpdir() });
const never = () => new Promise<void>(() => {});

async function lockOnly(): Promise<void> {
  try {
    const lock = await acquire(controller.signal);
    const interval = setInterval(() => {}, 1000);
    process.once('SIGTERM', () => {
      clearInterval(interval);
      void lock.close().catch(() => { process.exitCode = 1; });
    });
    // Readiness permits the parent to signal immediately.
    process.stdout.write('locked\n');
  } catch (error) { process.exitCode = error instanceof OwnershipError ? error.exitCode : 1; }
}

async function service(): Promise<void> {
  const artifact = await VerifiedArtifact.read(resolve(dirname(fileURLToPath(import.meta.url)), '../../dist'));
  const config = parseConfig({ SHUTDOWN_TIMEOUT_MS: '500', CONNECT_TIMEOUT_MS: '1000',
    ...(scenario === 'external' ? { PROJECTION_MODE: 'external', MONGODB_URI: 'mongodb://invalid.example',
      MONGODB_DATABASE: 'fixture', MONGODB_COMMITS_COLLECTION: 'commits', RABBITMQ_URI: 'amqp://invalid.example/%2F',
      RABBITMQ_VHOST: '/', RABBITMQ_EXCHANGE: 'commits', PROJECTION_PARTITION_ID: 'partition',
      RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:15672', RABBITMQ_MANAGEMENT_USERNAME: 'fixture',
      RABBITMQ_MANAGEMENT_PASSWORD: 'fixture' } : { PROJECTION_MODE: 'reference' }) }, []);
  let host: ProjectionHost | undefined;
  const observations = new Observations((line) => {
    process.stdout.write(`${JSON.stringify({ ...JSON.parse(line), healthPort: host?.healthPort })}\n`);
  }, config.mode);
  const connect = async (_signal: AbortSignal, fence: SessionFence): Promise<HostResource> => {
    if (scenario === 'external') return selectExternalInfrastructure(config, artifact, {
      mongo: () => { throw new Error('forbidden_client_construction'); },
      rabbit: async () => { throw new Error('forbidden_client_construction'); }
    }).connect(_signal, fence);
    if (scenario === 'connect') await never();
    if (scenario === 'poison') throw new Error('secret-canary URI payload source-id');
    const resource = referenceResource(artifact, config, fence, observations);
    if (scenario === 'start') return { ...resource, start: never };
    if (scenario === 'close') return { ...resource, close: never };
    if (scenario === 'channel-close') return blockedChannelClose(artifact, config, fence);
    if (scenario === 'live' || scenario === 'recovery') return blockedTurn(artifact, config, fence);
    return resource;
  };
  host = new ProjectionHost({ ...config, healthPort: 0 }, { acquire, connect, observations,
    signals: createProcessSignalSource(process), forceExit: (code) => process.exit(code) });
  process.exitCode = await host.start();
}

async function contendOnce(): Promise<void> {
  const requested = new Promise<void>((resolve) => { process.stdin.once('data', () => resolve()); });
  // Bootstrap completes before the parent starts the holder's shutdown deadline.
  process.stdout.write('contender-ready\n');
  await requested;
  try {
    const lock = await acquire(controller.signal);
    await lock.close();
  } catch (error) { process.exitCode = error instanceof OwnershipError ? error.exitCode : 1; }
}

function blockedChannelClose(artifact: VerifiedArtifact, config: ReturnType<typeof parseConfig>, fence: SessionFence): HostResource {
  const runtime = createReferenceRuntime(artifact, { ...config, shutdownTimeoutMs: 25 }, [modelCommit(42)], {
    wrapEvidence: (port) => fence.wrap(port), result: () => {}
  });
  runtime.channel.close = never;
  return { worker: runtime.worker, close: () => runtime.channel.close(), async start() {
    await runtime.worker.start(runtime.channel);
    runtime.channel.deliver();
    await waitForModelTurn(runtime.worker);
  } };
}

function blockedTurn(artifact: VerifiedArtifact, config: ReturnType<typeof parseConfig>, fence: SessionFence): HostResource {
  const runtime = createReferenceRuntime(artifact, { ...config, shutdownTimeoutMs: 25 }, [modelCommit(42), modelCommit(43), modelCommit(44)], {
    wrapEvidence: (port) => fence.wrap(port), result: () => {}
  });
  const save = runtime.store.commitProjectionSourceCommit.bind(runtime.store);
  const read = runtime.reader.readCompleteRange.bind(runtime.reader);
  runtime.store.commitProjectionSourceCommit = async (request) => { if (scenario === 'live') await never(); return save(request); };
  runtime.reader.readCompleteRange = async (request) => { if (request.throughSequence === 43) await never(); return read(request); };
  return { worker: runtime.worker, close: () => runtime.channel.close(), async start() {
    await runtime.worker.start(runtime.channel);
    runtime.channel.deliver();
    if (scenario === 'live') { process.stdout.write('blocked:live\n'); await waitForModelTurn(runtime.worker); return; }
    await waitForModelTurn(runtime.worker);
    const floor = await runtime.sourceOrder.load(firstSource, runtime.start.epoch);
    if (!floor) throw new Error('missing_test_floor');
    process.stdout.write('blocked:recovery\n');
    await runtime.coordinator.process(modelCommit(44), floor, () => { if (!fence.current()) throw new Error('stopped'); });
  } };
}

if (scenario === 'lock') await lockOnly();
else if (scenario === 'contender') await contendOnce();
else await service();
