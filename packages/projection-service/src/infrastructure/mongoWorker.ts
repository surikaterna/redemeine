import type { ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { MongoLiveSourceOrder, type LiveSourcePositionDocument } from '@redemeine/projection-transport';
import type { RuntimeRegistry } from '../runtimeRegistry';
import { createMongoClient, createMongoReader, openMongoClient, type ExternalConfig, type MongoClientFactory } from './mongoConnection';
import { createMongoRegistryStores } from './mongoRegistryStores';
import { mongoBootstrapStore } from './liveBootstrap';
import type { BootstrapRecord } from './bootstrapRecord';
import { BrokerRefusal } from './brokerSchema';
import { retainUntilClosed } from './failure';
import { observeStartup, type StartupObserver } from '../startupDiagnostics';

export function storeFacade<TState>(stores: ReturnType<typeof createMongoRegistryStores<TState>>, assertOpen: () => void): ProjectionSourceCommitStorePort<TState> {
  const select = (name: string, generation: string) => {
    assertOpen();
    const selected = stores.find((item) => item.projectionName === name && item.generation === generation);
    if (!selected) throw new BrokerRefusal('broker_definition_mismatch');
    return selected.store;
  };
  return {
    loadProjectionSourceCommitSnapshot: (request) => select(request.projectionName, request.projectionGeneration).loadProjectionSourceCommitSnapshot(request),
    commitProjectionSourceCommit: (request) => select(request.projectionName, request.projectionGeneration).commitProjectionSourceCommit(request)
  };
}

export async function openRegistryMongo<TState>(config: ExternalConfig, registry: RuntimeRegistry<TState>, signal: AbortSignal,
  factory: MongoClientFactory = createMongoClient, observe?: StartupObserver) {
  observeStartup(observe, 'mongo_connection');
  const connection = await openMongoClient(config, signal, factory);
  try {
    observeStartup(observe, 'source_reader');
    const reader = await createMongoReader(connection.client, config, connection.assertOpen);
    const db = connection.client.db(config.external.database);
    const control = mongoBootstrapStore(db.collection<BootstrapRecord>('rdm_projection_live_control'));
    return { control, reader, close: connection.close,
      async initialize(record: BootstrapRecord, assertCurrent: () => void = connection.assertOpen) {
        assertCurrent();
        connection.assertOpen();
        const stores = createMongoRegistryStores(db, connection.client, registry, config.connectTimeoutMs, record.epoch, record.generation);
        for (const entry of stores) { assertCurrent(); connection.assertOpen(); await entry.store.initializeProjectionSourceCommitStore(); }
        assertCurrent();
        connection.assertOpen();
        const sourceOrder = new MongoLiveSourceOrder(db.collection<LiveSourcePositionDocument>(`${registry.namespace(record.epoch)}_floors`));
        return { store: storeFacade(stores, connection.assertOpen), sourceOrder };
      }
    };
  } catch (error) { observeStartup(observe, 'source_reader', error); await retainUntilClosed(connection.close); throw new BrokerRefusal('broker_store_unready'); }
}
