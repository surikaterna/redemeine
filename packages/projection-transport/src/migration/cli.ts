#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import type { ProjectionSourceOrderPort } from '@redemeine/projection-runtime-core';
import {
  MongoProjectionStore,
  type ProjectionDedupeRecord,
  type ProjectionDocumentRecord,
  type ProjectionLinkRecord,
  type ProjectionMigrationReceiptRecord
} from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator } from '@redemeine/projection-worker-core';
import { type ClientSession, type Document, MongoClient } from 'mongodb';
import type { ICommit } from 'tapeworm';
import type { ProjectionTransportDocument } from '../mongoTransportStore';
import { createTapewormMongoCompleteCommitRangeReader } from '../tapewormMongoRangeReader';
import { ProjectionMigrationEngine } from './engine';
import {
  MongoProjectionMigrationActivationPort,
  MongoProjectionMigrationPreflightPort,
  MongoProjectionMigrationSnapshotPort,
  MongoProjectionMigrationStatePort,
  type ProjectionActiveGenerationRecord,
  type ProjectionGenerationCollections,
  type ProjectionGenerationRecord,
  type ProjectionMigrationJournalDocument,
  type ProjectionMigrationStateDocument
} from './mongoPorts';
import { assertRuntimeMatchesManifest, parseProjectionMigrationRuntimeModule } from './runtimeIdentity';
import { PROJECTION_MIGRATION_MAX_MANIFEST_BYTES, parseProjectionMigrationManifest } from './validate';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function required(name: string): string {
  const value = option(name) ?? process.env[name.replace(/^--/, '').replaceAll('-', '_').toUpperCase()];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const manifestFile = required('--manifest');
  if ((await stat(manifestFile)).size > PROJECTION_MIGRATION_MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds the supported 8 MiB bound.');
  const manifestText = await readFile(manifestFile, 'utf8');
  const manifest = parseProjectionMigrationManifest(JSON.parse(manifestText) as unknown, Buffer.byteLength(manifestText));
  const loaded: unknown = await import(required('--runtime-module'));
  const runtime = parseProjectionMigrationRuntimeModule(loaded);
  assertRuntimeMatchesManifest(
    runtime.migrationRuntimeIdentity,
    manifest.newRegistry,
    manifest.destinationStrategies,
    required('--executable-artifact-digest')
  );
  const targetClient = new MongoClient(required('--mongo-uri'));
  const sourceClient = new MongoClient(required('--source-mongo-uri'));
  await Promise.all([targetClient.connect(), sourceClient.connect()]);
  try {
    const targetDb = targetClient.db(required('--database'));
    const sourceDb = sourceClient.db(required('--source-database'));
    const collections: ProjectionGenerationCollections = {
      documents: required('--documents'),
      links: required('--links'),
      progress: required('--progress'),
      migrationReceipts: required('--migration-receipts')
    };
    const stateCollection = targetDb.collection<ProjectionMigrationStateDocument | ProjectionMigrationJournalDocument>('projection_migration_control');
    const transportCollection = targetDb.collection<ProjectionTransportDocument>('projection_transport');
    const generationCollection = targetDb.collection<ProjectionGenerationRecord | ProjectionActiveGenerationRecord>('projection_generation_control');
    const states = new MongoProjectionMigrationStatePort(stateCollection);
    const preflight = new MongoProjectionMigrationPreflightPort(targetDb, transportCollection, generationCollection, collections);
    const reader = createTapewormMongoCompleteCommitRangeReader({
      collection: sourceDb.collection<ICommit>(required('--source-collection')),
      partitionId: required('--source-partition')
    });
    if (command === 'preflight' && process.argv.includes('--dry-run')) {
      const reasons = await preflight.inspect(manifest);
      return output({
        version: 2,
        command,
        migrationId: manifest.migrationId,
        manifestDigest: manifest.manifestDigest,
        status: reasons.length ? 'rejected' : 'ok',
        phase: null,
        revision: null,
        mutated: false,
        reasons
      });
    }
    await states.initialize();
    const store = new MongoProjectionStore({
      collection: targetDb.collection<ProjectionDocumentRecord>(collections.documents),
      linkCollection: targetDb.collection<ProjectionLinkRecord>(collections.links),
      dedupeCollection: targetDb.collection<ProjectionDedupeRecord>(collections.progress),
      migrationReceiptCollection: targetDb.collection<ProjectionMigrationReceiptRecord>(collections.migrationReceipts),
      mongoClient: projectionStoreClient(targetClient),
      onSourceCommitReconciliation: () => process.stderr.write('projection-store-reconcile-observed\n')
    });
    const coordinator = createProjectionCommitCoordinator({
      queueBindingId: manifest.newRegistry.queueId,
      manifest: manifest.newRegistry,
      definitions: runtime.migrationDefinitions,
      store,
      sourceOrder: unusedSourceOrder(),
      rangeReader: reader,
      maxCommits: 100,
      maxBytes: 8 * 1024 * 1024
    });
    const snapshot = new MongoProjectionMigrationSnapshotPort(
      targetDb.collection<Document & { _id: string }>(collections.documents),
      targetDb.collection<Document & { _id: string }>(collections.links),
      targetDb.collection<Document & { _id: string }>(collections.progress),
      targetDb.collection<Document & { _id: string }>(collections.migrationReceipts),
      manifest
    );
    const activation = new MongoProjectionMigrationActivationPort(
      targetClient,
      stateCollection,
      transportCollection,
      generationCollection,
      undefined,
      activationHooks()
    );
    const engine = new ProjectionMigrationEngine({ states, preflight, sourceReader: reader, replay: coordinator, snapshot, activation });
    const result = await execute(engine, command, manifest);
    output(result);
  } finally {
    await Promise.all([targetClient.close(), sourceClient.close()]);
  }
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

async function execute(engine: ProjectionMigrationEngine, command: string | undefined, manifest: Parameters<ProjectionMigrationEngine['preflight']>[0]) {
  if (command === 'preflight') return engine.preflight(manifest);
  if (command === 'verify-sources') return engine.verifySources(manifest);
  if (command === 'replay') return engine.replay(manifest);
  if (command === 'activate') return engine.activate(manifest);
  if (command === 'verify') return engine.verify(manifest);
  if (command === 'rollback') return engine.rollback(manifest);
  throw new Error('Expected command: preflight, verify-sources, replay, activate, verify, or rollback.');
}

function output<T extends { status: string }>(value: T): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  if (value.status !== 'ok') process.exitCode = 1;
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

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ version: 2, status: 'rejected', error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
