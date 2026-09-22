import { MongoClient } from 'mongodb';
import type { ProjectionQueueRegistryManifest, ProjectionSha256Digest } from '@redemeine/projection-runtime-core';
import {
  MongoProjectionMigrationRegistryPort, MongoProjectionMigrationStatePort, MongoProjectionTransportStore, ProjectionMigrationEngine,
  projectionMigrationDigest, projectionMigrationManifestPayload, type ProjectionMigrationManifest, type ProjectionTransportDocument
} from '../src';

const sourceId = '01234567-89ab-4def-8123-456789abcdef';
const digest = (value: unknown): ProjectionSha256Digest => projectionMigrationDigest(value);

function registry(queueId: string, generation: string): ProjectionQueueRegistryManifest {
  return { version: 1, manifestId: digest(`${queueId}-manifest`), queueId, registryGeneration: generation,
    identity: { version: 1, normalizedDefinitionRegistryDigest: digest(`${queueId}-definitions`),
      normalizedRuntimeConfigurationDigest: digest(`${queueId}-config`), executableCodeArtifactDigest: digest(`${queueId}-code`) },
    definitions: [{ projectionName: 'accounts', generation, definitionHash: digest(`${queueId}-definition`), sourceSelectors: ['Account'] }],
    sourceStartAnchors: { [sourceId]: 0 } };
}

function migrationManifest(): ProjectionMigrationManifest {
  const ranges = [{ sourceId, firstSequence: 0, lastSequence: 0, commitCount: 1, completeCommitBoundaries: true as const,
    rangeDigest: digest([digest({ streamId: sourceId, commitSequence: 0 })]) }];
  const boundary = digest(ranges);
  const payload = { version: 1 as const, migrationId: 'real-migration', mode: 'rebuild' as const, oldRegistry: registry('old-queue', 'v1'),
    newRegistry: registry('new-queue', 'v2'), projectionName: 'accounts', oldGeneration: 'v1', newGeneration: 'v2', oldStrategy: 'none' as const,
    newStrategy: 'own_record' as const, streamIdentity: 'immutable_uuid_no_reset' as const, transportStartAnchors: { [sourceId]: 0 }, sourceCommitRanges: ranges,
    authoritativeBoundaryDigest: boundary, authoritativeSourceDigest: boundary, snapshot: null, executableCodeDigest: digest('code'),
    runtimeConfigDigest: digest('config'), retainOldArtifacts: true };
  return { ...payload, manifestDigest: digest(projectionMigrationManifestPayload(payload)) };
}

async function main(): Promise<void> {
  const uri = process.env.REDEMEINE_MONGO_URI;
  if (!uri) throw new Error('REDEMEINE_MONGO_URI is required.');
  const client = new MongoClient(uri); await client.connect();
  const databaseName = `redemeine_projection_migration_${Date.now()}`;
  try {
    const database = client.db(databaseName);
    const states = new MongoProjectionMigrationStatePort(database.collection('migration'));
    await states.initialize();
    const manifest = migrationManifest();
    const transport = new MongoProjectionTransportStore({ collection: database.collection<ProjectionTransportDocument>('transport'), mongoClient: client, manifest: manifest.newRegistry });
    const engine = new ProjectionMigrationEngine(states, new MongoProjectionMigrationRegistryPort(transport), () => '2026-09-22T01:00:00.000Z');
    const concurrent = await Promise.all([engine.preflight(manifest), engine.preflight(manifest)]);
    if (concurrent.filter((entry) => entry.mutated).length !== 1) throw new Error('Mongo preflight CAS did not choose exactly one writer.');
    const quiescePayload = { oldQueueDepth: 0 as const, oldActiveWriters: 0 as const, newActiveWriters: 0 as const, drainedAt: '2026-09-22T00:00:00.000Z' };
    await engine.quiesce(manifest, { ...quiescePayload, digest: digest(quiescePayload) });
    const replay = { replayedRangesDigest: manifest.authoritativeSourceDigest, stateDigest: digest('state'), linkDigest: digest('links'),
      completedAt: '2026-09-22T00:30:00.000Z' };
    const activated = await engine.activate(manifest, replay);
    const restarted = await engine.activate(manifest, replay);
    const verification = { ...replay, activeWriters: 1 as const, verifiedAt: '2026-09-22T02:00:00.000Z' };
    const verified = await engine.verify(manifest, verification);
    const binding = await transport.readQueueBinding(manifest.newRegistry.queueId);
    if (activated.phase !== 'activated' || restarted.mutated || verified.phase !== 'verified' || binding?.manifestId !== manifest.newRegistry.manifestId) {
      throw new Error('Mongo migration activation/restart/binding verification failed.');
    }
    process.stdout.write(`${JSON.stringify({ status: 'PASS', databaseName, concurrentCasWinnerCount: 1, phase: verified.phase,
      restartMutated: restarted.mutated, immutableBinding: binding.manifestId })}\n`);
  } finally {
    await client.db(databaseName).dropDatabase();
    await client.close();
  }
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
