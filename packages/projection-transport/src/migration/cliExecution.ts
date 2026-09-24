import type { ProjectionSourceOrderPort } from '@redemeine/projection-runtime-core';
import {
  MongoProjectionStore,
  type ProjectionDedupeRecord,
  type ProjectionDocumentRecord,
  type ProjectionLinkRecord,
  type ProjectionMigrationReceiptRecord
} from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { type ClientSession, type Document, type MongoClient } from 'mongodb';
import type { ICommit } from 'tapeworm';
import type { ProjectionTransportDocument } from '../mongoTransportStore';
import { createTapewormMongoCompleteCommitRangeReader } from '../tapewormMongoRangeReader';
import { ProjectionMigrationEngine } from './engine';
import { MongoProjectionMigrationActivationPort } from './mongoActivation';
import {
  MongoProjectionMigrationPreflightPort,
  MongoProjectionMigrationSnapshotPort,
  MongoProjectionMigrationStatePort,
  type ProjectionActiveGenerationRecord,
  type ProjectionGenerationCollections,
  type ProjectionGenerationRecord,
  type ProjectionMigrationJournalDocument,
  type ProjectionMigrationStateDocument
} from './mongoPorts';
import type { ProjectionMigrationRuntimeArtifact } from './runtimeArtifact';
import type { ProjectionMigrationManifest, ProjectionMigrationReceipt } from './types';

interface CliExecutionOptions {
  command: string | undefined;
  manifest: ProjectionMigrationManifest;
  runtime: ProjectionMigrationRuntimeArtifact;
  targetClient: MongoClient;
  sourceClient: MongoClient;
  required(name: string): string;
  dryRun: boolean;
}

export async function runMigrationCliCommand(options: CliExecutionOptions): Promise<ProjectionMigrationReceipt> {
  const targetDb = options.targetClient.db(options.required('--database'));
  const sourceDb = options.sourceClient.db(options.required('--source-database'));
  const collections = collectionNames(options.required);
  const statesCollection = targetDb.collection<ProjectionMigrationStateDocument | ProjectionMigrationJournalDocument>('projection_migration_control');
  const transport = targetDb.collection<ProjectionTransportDocument>('projection_transport');
  const control = targetDb.collection<ProjectionGenerationRecord | ProjectionActiveGenerationRecord>('projection_generation_control');
  const states = new MongoProjectionMigrationStatePort(statesCollection);
  const preflight = new MongoProjectionMigrationPreflightPort(targetDb, transport, control, collections);
  if (options.command === 'preflight' && options.dryRun) return dryRunReceipt(options.manifest, await preflight.inspect(options.manifest));
  await states.initialize();
  const reader = createTapewormMongoCompleteCommitRangeReader({
    collection: sourceDb.collection<ICommit>(options.required('--source-collection')),
    partitionId: options.required('--source-partition')
  });
  const engine = createEngine(options, collections, states, preflight, reader, statesCollection, transport, control, targetDb);
  return execute(engine, options.command, options.manifest);
}

function createEngine(
  options: CliExecutionOptions,
  collections: ProjectionGenerationCollections,
  states: MongoProjectionMigrationStatePort,
  preflight: MongoProjectionMigrationPreflightPort,
  reader: ReturnType<typeof createTapewormMongoCompleteCommitRangeReader>,
  statesCollection: ConstructorParameters<typeof MongoProjectionMigrationActivationPort>[1],
  transport: ConstructorParameters<typeof MongoProjectionMigrationActivationPort>[2],
  control: ConstructorParameters<typeof MongoProjectionMigrationActivationPort>[3],
  targetDb: ReturnType<MongoClient['db']>
): ProjectionMigrationEngine {
  const store = new MongoProjectionStore({
    collection: targetDb.collection<ProjectionDocumentRecord>(collections.documents),
    linkCollection: targetDb.collection<ProjectionLinkRecord>(collections.links),
    dedupeCollection: targetDb.collection<ProjectionDedupeRecord>(collections.progress),
    migrationReceiptCollection: targetDb.collection<ProjectionMigrationReceiptRecord>(collections.migrationReceipts),
    mongoClient: projectionStoreClient(options.targetClient),
    onSourceCommitReconciliation: () => process.stderr.write('projection-store-reconcile-observed\n')
  });
  const coordinator = createProjectionCommitCoordinator({
    queueBindingId: options.manifest.newRegistry.queueId,
    manifest: options.manifest.newRegistry,
    definitions: options.runtime.module.migrationDefinitions,
    store,
    sourceOrder: unusedSourceOrder(),
    migrationReplay: true,
    rangeReader: reader,
    maxCommits: 100,
    maxBytes: 8 * 1024 * 1024
  });
  const snapshot = new MongoProjectionMigrationSnapshotPort(
    targetDb.collection<Document & { _id: string }>(collections.documents),
    targetDb.collection<Document & { _id: string }>(collections.links),
    targetDb.collection<Document & { _id: string }>(collections.progress),
    targetDb.collection<Document & { _id: string }>(collections.migrationReceipts),
    options.manifest
  );
  const activation = new MongoProjectionMigrationActivationPort(options.targetClient, statesCollection, transport, control, undefined, activationHooks());
  return new ProjectionMigrationEngine({ states, preflight, sourceReader: reader, replay: coordinator, snapshot, activation });
}

function collectionNames(required: CliExecutionOptions['required']): ProjectionGenerationCollections {
  return {
    documents: required('--documents'),
    links: required('--links'),
    progress: required('--progress'),
    migrationReceipts: required('--migration-receipts')
  };
}
function dryRunReceipt(manifest: ProjectionMigrationManifest, reasons: readonly string[]): ProjectionMigrationReceipt {
  return {
    version: 2,
    command: 'preflight',
    migrationId: manifest.migrationId,
    manifestDigest: manifest.manifestDigest,
    status: reasons.length ? 'rejected' : 'ok',
    phase: null,
    revision: null,
    mutated: false,
    reasons
  };
}
async function execute(
  engine: ProjectionMigrationEngine,
  command: string | undefined,
  manifest: ProjectionMigrationManifest
): Promise<ProjectionMigrationReceipt> {
  if (command === 'preflight') return engine.preflight(manifest);
  if (command === 'verify-sources') return engine.verifySources(manifest);
  if (command === 'replay') return engine.replay(manifest);
  if (command === 'activate') return engine.activate(manifest);
  if (command === 'verify') return engine.verify(manifest);
  if (command === 'rollback') return engine.rollback(manifest);
  throw new Error('Expected command: preflight, verify-sources, replay, activate, verify, or rollback.');
}

function activationHooks() {
  let injected = false;
  if (process.env.REDEMEINE_MIGRATION_TEST_UNKNOWN_AFTER_COMMIT !== '1') return {};
  return {
    afterTransactionCommitted: () => {
      if (!injected) {
        injected = true;
        throw new InjectedUnknownCommitError();
      }
    },
    reconciliationObserved: () => process.stderr.write('activation-reconcile-observed\n')
  };
}
class InjectedUnknownCommitError extends Error {
  hasErrorLabel(label: string): boolean {
    return label === 'UnknownTransactionCommitResult';
  }
}
function projectionStoreClient(client: MongoClient): Pick<MongoClient, 'startSession'> {
  if (process.env.REDEMEINE_MIGRATION_TEST_STORE_UNKNOWN_AFTER_COMMIT !== '1') return client;
  let injected = false;
  return {
    startSession: () =>
      sessionWithPostCommitUnknown(client.startSession(), () => {
        if (injected) return false;
        injected = true;
        return true;
      })
  };
}
function sessionWithPostCommitUnknown(session: ClientSession, shouldInject: () => boolean): ClientSession {
  return new Proxy(session, {
    get(target, property) {
      if (property !== 'withTransaction') {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<ClientSession['withTransaction']>) => {
        const result = await target.withTransaction(...args);
        if (isCommittedStoreResult(result) && shouldInject()) throw new InjectedUnknownCommitError();
        return result;
      };
    }
  });
}
function isCommittedStoreResult(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'committed';
}
function unusedSourceOrder(): ProjectionSourceOrderPort {
  return {
    admitForDispatch: async () => {
      throw new Error('Live source ordering is not used by migration replay.');
    },
    advanceCoverage: async () => {
      throw new Error('Live source ordering is not used by migration replay.');
    }
  };
}
