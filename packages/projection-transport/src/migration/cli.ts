#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectionSourceOrderPort } from '@redemeine/projection-runtime-core';
import { MongoProjectionStore, type ProjectionDedupeRecord, type ProjectionDocumentRecord, type ProjectionLinkRecord,
  type ProjectionMigrationReceiptRecord } from '@redemeine/projection-runtime-store-mongodb';
import { createProjectionCommitCoordinator, type ProjectionCommitRegistryDefinition } from '@redemeine/projection-worker-core';
import { MongoClient, type Document } from 'mongodb';
import type { ICommit } from 'tapeworm';
import { createTapewormMongoCompleteCommitRangeReader } from '../tapewormMongoRangeReader';
import type { ProjectionTransportDocument } from '../mongoTransportStore';
import { ProjectionMigrationEngine } from './engine';
import { MongoProjectionMigrationActivationPort, MongoProjectionMigrationPreflightPort, MongoProjectionMigrationSnapshotPort,
  MongoProjectionMigrationStatePort, type ProjectionActiveGenerationRecord, type ProjectionGenerationCollections,
  type ProjectionGenerationRecord, type ProjectionMigrationJournalDocument, type ProjectionMigrationStateDocument } from './mongoPorts';
import { parseProjectionMigrationManifest, PROJECTION_MIGRATION_MAX_MANIFEST_BYTES } from './validate';

function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function required(name: string): string { const value = option(name) ?? process.env[name.replace(/^--/, '').replaceAll('-', '_').toUpperCase()]; if (!value) throw new Error(`${name} is required.`); return value; }

async function runtimeDefinitions(path: string): Promise<readonly ProjectionCommitRegistryDefinition<unknown>[]> {
  const module = await import(pathToFileURL(resolve(path)).href) as { migrationDefinitions?: unknown };
  if (!Array.isArray(module.migrationDefinitions)) throw new Error('Runtime module must export migrationDefinitions.');
  return module.migrationDefinitions as readonly ProjectionCommitRegistryDefinition<unknown>[];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const manifestFile = required('--manifest');
  if ((await stat(manifestFile)).size > PROJECTION_MIGRATION_MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds the supported 8 MiB bound.');
  const manifestText = await readFile(manifestFile, 'utf8');
  const manifest = parseProjectionMigrationManifest(JSON.parse(manifestText) as unknown, Buffer.byteLength(manifestText));
  const targetClient = new MongoClient(required('--mongo-uri'));
  const sourceClient = new MongoClient(required('--source-mongo-uri'));
  await Promise.all([targetClient.connect(), sourceClient.connect()]);
  try {
    const targetDb = targetClient.db(required('--database')); const sourceDb = sourceClient.db(required('--source-database'));
    const collections: ProjectionGenerationCollections = { documents: required('--documents'), links: required('--links'),
      progress: required('--progress'), migrationReceipts: required('--migration-receipts') };
    const stateCollection = targetDb.collection<ProjectionMigrationStateDocument | ProjectionMigrationJournalDocument>('projection_migration_control');
    const transportCollection = targetDb.collection<ProjectionTransportDocument>('projection_transport');
    const generationCollection = targetDb.collection<ProjectionGenerationRecord | ProjectionActiveGenerationRecord>('projection_generation_control');
    const states = new MongoProjectionMigrationStatePort(stateCollection);
    const preflight = new MongoProjectionMigrationPreflightPort(targetDb, transportCollection, generationCollection, collections);
    const reader = createTapewormMongoCompleteCommitRangeReader({ collection: sourceDb.collection<ICommit>(required('--source-collection')),
      partitionId: required('--source-partition') });
    if (command === 'preflight' && process.argv.includes('--dry-run')) {
      const reasons = await preflight.inspect(manifest); return output({ version: 2, command, migrationId: manifest.migrationId,
        manifestDigest: manifest.manifestDigest, status: reasons.length ? 'rejected' : 'ok', phase: null, revision: null, mutated: false, reasons });
    }
    await states.initialize();
    const store = new MongoProjectionStore({ collection: targetDb.collection<ProjectionDocumentRecord>(collections.documents),
      linkCollection: targetDb.collection<ProjectionLinkRecord>(collections.links), dedupeCollection: targetDb.collection<ProjectionDedupeRecord>(collections.progress),
      migrationReceiptCollection: targetDb.collection<ProjectionMigrationReceiptRecord>(collections.migrationReceipts),
      mongoClient: targetClient });
    const definitions = await runtimeDefinitions(required('--runtime-module'));
    const runtimeStrategies = Object.fromEntries(definitions.map((entry) => [entry.definition.name, entry.definition.deduplication.strategy]));
    if (JSON.stringify(runtimeStrategies) !== JSON.stringify(manifest.destinationStrategies)) throw new Error('Runtime strategies do not match the immutable migration manifest.');
    const coordinator = createProjectionCommitCoordinator({ queueBindingId: manifest.newRegistry.queueId, manifest: manifest.newRegistry,
      definitions, store, sourceOrder: unusedSourceOrder(), rangeReader: reader, maxCommits: 100, maxBytes: 8 * 1024 * 1024 });
    const snapshot = new MongoProjectionMigrationSnapshotPort(targetDb.collection<Document & { _id: string }>(collections.documents),
      targetDb.collection<Document & { _id: string }>(collections.links), targetDb.collection<Document & { _id: string }>(collections.progress),
      targetDb.collection<Document & { _id: string }>(collections.migrationReceipts), manifest);
    const activation = new MongoProjectionMigrationActivationPort(targetClient, stateCollection, transportCollection, generationCollection);
    const engine = new ProjectionMigrationEngine({ states, preflight, sourceReader: reader, replay: coordinator, snapshot, activation });
    const result = await execute(engine, command, manifest); output(result);
  } finally { await Promise.all([targetClient.close(), sourceClient.close()]); }
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
  process.stdout.write(`${JSON.stringify(value)}\n`); if (value.status !== 'ok') process.exitCode = 1;
}

function unusedSourceOrder(): ProjectionSourceOrderPort {
  return { admitForDispatch: async () => { throw new Error('Live source ordering is not used by migration replay.'); },
    advanceCoverage: async () => { throw new Error('Live source ordering is not used by migration replay.'); } };
}

main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ version: 2, status: 'rejected', error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
