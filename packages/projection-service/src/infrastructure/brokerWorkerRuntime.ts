import { randomUUID } from 'node:crypto';
import type { RuntimeIdentity, RuntimeRegistry } from '../runtimeRegistry';
import { composeWorkerRuntime } from '../composeWorkerRuntime';
import type { HostResource } from '../hostAttempt';
import type { Observations } from '../observability';
import type { SessionFence } from '../sessionFence';
import { brokerStart } from './bootstrapRecord';
import { BrokerEvidence } from './brokerEvidence';
import { BrokerTopology } from './brokerTopology';
import { establishBinding, claimBootstrapRun, finishBootstrapRun } from './liveBootstrap';
import { createBrokerManagement, type BrokerManagement } from './management';
import { openRegistryMongo } from './mongoWorker';
import { openBrokerRabbit } from './rabbitBroker';
import { createMongoClient, type ExternalConfig, type MongoClientFactory } from './mongoConnection';
import { connectRabbit, type RabbitConnector } from './rabbit';
import { assertActive, closeOnce, closeResources, retainUntilClosed } from './failure';
import { BrokerRefusal } from './brokerSchema';
import { TransientConnectionError } from '../reconnect';
import { observeStartup, type StartupStage } from '../startupDiagnostics';

export interface BrokerFactories {
  readonly mongo: MongoClientFactory;
  readonly rabbit: RabbitConnector;
  readonly management?: (config: ExternalConfig, signal: AbortSignal) => BrokerManagement;
}

export function registryResourceFactory<TState>(config: ExternalConfig, artifact: RuntimeIdentity, registry: RuntimeRegistry<TState>, observations: Observations,
  factories: BrokerFactories = { mongo: createMongoClient, rabbit: connectRabbit }) {
  if (registry.registryDigest !== artifact.registryDigest) throw new BrokerRefusal('broker_definition_mismatch'); const runId = randomUUID();
  return async (signal: AbortSignal, fence: SessionFence): Promise<HostResource> => {
    let stage: StartupStage = 'mongo_connection'; let diagnosed = false;
    const observe = (next: StartupStage, error?: unknown) => {
      stage = next; diagnosed = error !== undefined; observeStartup((stage, error) => observations.startup(stage, error), next, error);
    };
    let mongo: Awaited<ReturnType<typeof openRegistryMongo<TState>>>;
    try { mongo = await openRegistryMongo(config, registry, signal, factories.mongo, observe); }
    catch (error) { if (stage === 'mongo_connection') observe(stage, error); throw error; }
    let rabbit: Awaited<ReturnType<typeof openBrokerRabbit>> | undefined;
    let evidence: BrokerEvidence | undefined;
    const close = closeOnce(() => closeResources([async () => { await evidence?.close(); },
      async () => { await rabbit?.close(); }, mongo.close]));
    const assertStartup = () => { assertActive(signal); if (fence.halted) throw new BrokerRefusal('broker_startup_cancelled'); };
    try {
      assertStartup();
      observe('rabbit_connection');
      rabbit = await openBrokerRabbit(config, signal, factories.rabbit, observe);
      const management = factories.management ? factories.management(config, signal)
        : createBrokerManagement(config, signal, (route, status, json) => observations.http(route, status, json));
      const topology = new BrokerTopology(config, management, (facts) => observations.consumer(facts));
      const assertCurrent = () => { assertStartup(); rabbit?.assertOpen(); };
      observe('binding');
      const record = await establishBinding(config, artifact, mongo.control, topology, rabbit, assertCurrent);
      observe('store_initialization');
      const stores = await mongo.initialize(record, assertCurrent);
      assertCurrent();
      observe('run_claim');
      const active = await claimBootstrapRun(mongo.control, record, runId);
      assertCurrent();
      observe('runtime_composition');
      const start = brokerStart(active, config);
      const brokerEvidence = new BrokerEvidence(start, rabbit.channel, topology, undefined, observe);
      evidence = brokerEvidence;
      const runtime = composeWorkerRuntime(artifact, registry, start, { sourceScopeDigest: start.sourceScopeDigest,
        collection: config.external.collection, partitionId: config.external.partitionId,
        ...(config.external.tenant ? { tenant: config.external.tenant } : {}) }, config,
      { ...stores, reader: mongo.reader, evidence: fence.wrap(brokerEvidence), brokerSessionCurrent: () => brokerEvidence.assertCurrent(),
        observe: (result, ms) => observations.result(result, ms) });
      return ownedResource(runtime.worker, rabbit.channel, close, () => finishBootstrapRun(mongo.control, active), evidence, rabbit.close, mongo.close, observations);
    } catch (error) {
      if (!diagnosed) observe(stage, error);
      await retainUntilClosed(close);
      throw error instanceof BrokerRefusal || error instanceof TransientConnectionError ? error : new BrokerRefusal('broker_startup_refused');
    }
  };
}

function ownedResource(worker: ReturnType<typeof composeWorkerRuntime>['worker'], channel: Parameters<typeof worker.start>[0],
  cleanup: () => Promise<void>, markClean: () => Promise<void>, evidence: BrokerEvidence,
  closeRabbit: () => Promise<void>, closeMongo: () => Promise<void>, observations: Observations): HostResource {
  let activated = false;
  let clean = false;
  return { worker: { getStatus: () => evidence.hasObservedFault()
    ? { ...worker.getStatus(), accepting: false, reason: 'broker_topology_invalid' } : worker.getStatus(), async stop() {
    const status = worker.getStatus();
    const healthy = status.accepting && status.activeDeliveries === 0;
    const result = await worker.stop();
    clean = activated && healthy && result.drained;
    return result;
  } },
   async start() {
     observeStartup((stage, error) => observations.startup(stage, error), 'consumer_start');
     try { await worker.start(channel); activated = true; }
      catch (error) {
        observeStartup((stage, error) => observations.startup(stage, error), 'consumer_start', evidence.startupFailure() ?? error);
        throw error;
      }
   },
  close: closeOnce(async () => {
    if (!clean || !evidence.permitsCleanRestart()) { await cleanup(); return; }
    await evidence.close();
    await closeRabbit();
    if (evidence.permitsCleanRestart()) await markClean();
    await closeMongo();
  }) };
}
