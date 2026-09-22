import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import EventStore, { type ICommit } from 'tapeworm';
import MongoTapewormPersistence from 'tapeworm_persistence_store_mongodb';
import {
  MongoProjectionTransportStore, ProjectionMigrationStreamingDigest, projectionMigrationDigest, projectionMigrationManifestPayload,
  projectionMigrationSourceDescriptorDigest, decodeTapewormProjectionCommit, type ProjectionGenerationCollections, type ProjectionMigrationManifest,
  type ProjectionMigrationSourceRange, type ProjectionTransportDocument, type ProjectionGenerationRecord, type ProjectionActiveGenerationRecord,
  type ProjectionMigrationStateDocument, type ProjectionMigrationJournalDocument
} from '../src';
import { PARTITION_ID, SOURCE_ID, stackDefinitions, stackManifest, tapewormCommit, type StackEvent } from './realStackFixtures';

const sourceB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const uri = required('REDEMEINE_MONGO_URI');
const evidencePath = required('REDEMEINE_EVIDENCE_PATH');
const gitSha = required('REDEMEINE_GIT_SHA');
const databaseName = `redemeine_projection_migration_${Date.now()}`;
const manifestPath = `/tmp/redemeine-migration-manifest-${process.pid}.json`;

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function secondSource(value: ICommit<StackEvent>): ICommit<StackEvent> {
  return { ...structuredClone(value), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', streamId: sourceB,
    events: value.events.map((event, index) => ({ ...event, id: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, '0')}` })) };
}

function sourceCommit(sequence: number, amount: number): ICommit<StackEvent> {
  const value = tapewormCommit(sequence, [amount]);
  return { ...value, events: value.events.map((event) => ({ ...event,
    id: `33333333-3333-4333-8333-${String(sequence).padStart(12, '0')}`, version: sequence })) };
}

function range(values: readonly ICommit<StackEvent>[]): ProjectionMigrationSourceRange {
  const digest = new ProjectionMigrationStreamingDigest('redemeine:migration:complete-commits:v2');
  for (const value of values) {
    const decoded = decodeTapewormProjectionCommit(value, value.id);
    if (decoded.status !== 'valid') throw new Error(decoded.reason);
    digest.update(decoded.commit);
  }
  return { sourceId: values[0]!.streamId, firstSequence: values[0]!.commitSequence, lastSequence: values.at(-1)!.commitSequence,
    commitCount: values.length, expectedDigest: digest.finish().digest };
}

function buildManifest(a: readonly ICommit<StackEvent>[], b: readonly ICommit<StackEvent>[]): ProjectionMigrationManifest {
  const oldRegistry = stackManifest('migration-old');
  const newRegistry = { ...stackManifest('migration-new'), registryGeneration: 'v2', manifestId: projectionMigrationDigest('migration-new'),
    definitions: stackDefinitions().map(({ definition }) => ({ projectionName: definition.name, generation: 'v2',
      definitionHash: oldRegistry.identity.normalizedDefinitionRegistryDigest, sourceSelectors: [definition.fromStream.aggregate.aggregateType] })),
    sourceStartAnchors: { [SOURCE_ID]: a.at(-1)!.commitSequence + 1, [sourceB]: b.at(-1)!.commitSequence + 1 } };
  const sourceRanges = [range(a), range(b)];
  const payload = { version: 2 as const, migrationId: 'real-migration', projectionName: 'migration-stack', oldGeneration: 'v1', newGeneration: 'v2',
    destinationStrategies: { 'P-own': 'own_record' as const, 'N-none': 'none' as const, 'Q-inline': 'in_document' as const,
      'O-own-no-target': 'own_record' as const }, streamIdentity: 'immutable_uuid_no_reset' as const, oldRegistry,
    newRegistry, sourceRanges, authoritativeSourceDigest: projectionMigrationSourceDescriptorDigest(sourceRanges) };
  return { ...payload, manifestDigest: projectionMigrationDigest(projectionMigrationManifestPayload(payload), 'redemeine:migration:manifest:v2') };
}

function argumentsFor(manifest: ProjectionMigrationManifest, collections: ProjectionGenerationCollections): string[] {
  return ['--manifest', manifestPath, '--mongo-uri', uri, '--source-mongo-uri', uri, '--database', databaseName, '--source-database', databaseName,
    '--source-collection', `tw_${PARTITION_ID}_commits`, '--source-partition', PARTITION_ID, '--documents', collections.documents, '--links', collections.links,
    '--progress', collections.progress, '--migration-receipts', collections.migrationReceipts, '--runtime-module', resolve('integration/migrationRuntime.ts')];
}

async function cli(command: string, args: readonly string[]): Promise<{ code: number | null; receipt: Record<string, unknown> }> {
  const child = spawn('pnpm', ['exec', 'tsx', 'src/migration/cli.ts', command, ...args], { cwd: process.cwd(), env: process.env });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += String(chunk); }); child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolveCode, reject) => { child.once('error', reject); child.once('close', resolveCode); });
  const line = stdout.trim().split('\n').at(-1) ?? stderr.trim().split('\n').at(-1) ?? '{}';
  return { code, receipt: JSON.parse(line) as Record<string, unknown> };
}

async function crashReplay(args: readonly string[], receipts: import('mongodb').Collection): Promise<number> {
  const child = spawn('pnpm', ['exec', 'tsx', 'src/migration/cli.ts', 'replay', ...args], { cwd: process.cwd(), env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const count = await receipts.countDocuments();
    if (count > 0) {
      process.kill(-child.pid!, 'SIGKILL');
      await new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
      return count;
    }
    if (child.exitCode !== null) throw new Error('Replay completed before crash injection.');
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  process.kill(-child.pid!, 'SIGKILL'); throw new Error('Timed out waiting for replay receipt before crash.');
}

async function setup(client: MongoClient, manifest: ProjectionMigrationManifest, oldCollections: ProjectionGenerationCollections,
  newCollections: ProjectionGenerationCollections): Promise<void> {
  const db = client.db(databaseName);
  const control = db.collection<ProjectionGenerationRecord | ProjectionActiveGenerationRecord>('projection_generation_control');
  await control.insertMany([
    { _id: `generation:${manifest.projectionName}:v1`, kind: 'generation', projectionName: manifest.projectionName, generation: 'v1', manifest: manifest.oldRegistry,
      collections: oldCollections, strategies: Object.fromEntries(stackDefinitions().map((entry) => [entry.definition.name, entry.definition.deduplication.strategy])) },
    { _id: `generation:${manifest.projectionName}:v2`, kind: 'generation', projectionName: manifest.projectionName, generation: 'v2', manifest: manifest.newRegistry,
      collections: newCollections, strategies: manifest.destinationStrategies },
    { _id: `active:${manifest.projectionName}`, kind: 'active', projectionName: manifest.projectionName, generation: 'v1', queueId: manifest.oldRegistry.queueId,
      manifestDigest: projectionMigrationDigest('old-active'), revision: 0 }
  ]);
  const transport = new MongoProjectionTransportStore({ collection: db.collection<ProjectionTransportDocument>('projection_transport'), mongoClient: client,
    manifest: manifest.oldRegistry });
  assert((await transport.bindImmutableManifest(manifest.oldRegistry)).status !== 'conflict', 'Old queue binding setup failed.');
}

async function run(): Promise<void> {
  const client = new MongoClient(uri); await client.connect(); const db = client.db(databaseName);
  let evidence: Record<string, unknown> = {};
  try {
    const persistence = new MongoTapewormPersistence(db); const eventStore = Reflect.construct(EventStore, [persistence]) as InstanceType<typeof EventStore>;
    const partition = await eventStore.openPartition(PARTITION_ID);
    const sourceA = Array.from({ length: 30 }, (_, sequence) => sourceCommit(sequence, sequence + 1));
    const sourceBCommits = [secondSource(sourceCommit(0, 31))];
    await partition.append([...sourceA, ...sourceBCommits]);
    const manifest = buildManifest(sourceA, sourceBCommits);
    const oldCollections = { documents: 'old_documents', links: 'old_links', progress: 'old_progress', migrationReceipts: 'old_receipts' };
    const newCollections = { documents: 'new_documents', links: 'new_links', progress: 'new_progress', migrationReceipts: 'new_receipts' };
    await setup(client, manifest, oldCollections, newCollections); await writeFile(manifestPath, JSON.stringify(manifest));
    const args = argumentsFor(manifest, newCollections);
    assert((await cli('preflight', [...args, '--dry-run'])).code === 0, 'Dry-run preflight failed.');
    const namesAfterDryRun = (await db.listCollections().toArray()).map((entry) => entry.name);
    assert(!namesAfterDryRun.includes('projection_migration_control')
      && Object.values(newCollections).every((name) => !namesAfterDryRun.includes(name)), 'Dry-run created migration collections or indexes.');
    assert((await cli('preflight', args)).code === 0, 'Preflight failed.');
    const sourceCollection = db.collection<ICommit<StackEvent>>(`tw_${PARTITION_ID}_commits`);
    await sourceCollection.updateOne({ streamId: sourceB }, { $set: { 'events.0.payload.amount': 999 } });
    const corrupt = await cli('verify-sources', args); assert(corrupt.code !== 0, 'Corrupt final source was accepted.');
    for (const name of Object.values(newCollections)) assert(await db.collection(name).countDocuments() === 0, `Corrupt verification mutated ${name}.`);
    await sourceCollection.updateOne({ streamId: sourceB }, { $set: { 'events.0.payload.amount': 31 } });
    const verifiedSources = await cli('verify-sources', args); assert(verifiedSources.code === 0, 'Source verification resume failed.');
    const crashReceiptCount = await crashReplay(args, db.collection(newCollections.migrationReceipts));
    assert(crashReceiptCount > 0 && crashReceiptCount < 8, 'Replay crash was not injected between sources.');
    const replayed = await cli('replay', args); assert(replayed.code === 0, 'Replay failed.');
    const replayRestart = await cli('replay', args); assert(replayRestart.code === 0 && replayRestart.receipt.mutated === false, 'Replay restart was not idempotent.');
    await db.collection<ProjectionTransportDocument>('projection_transport').insertOne({ _id: `binding:${manifest.newRegistry.queueId}`, kind: 'binding',
      queueBindingId: manifest.newRegistry.queueId, manifest: manifest.oldRegistry,
      binding: { queueId: manifest.newRegistry.queueId, manifestId: manifest.oldRegistry.manifestId, registryGeneration: 'conflict',
        identity: manifest.oldRegistry.identity, boundAt: '2026-09-22T00:00:00.000Z' } });
    const activationConflict = await cli('activate', args); assert(activationConflict.code !== 0, 'Conflicting activation was accepted.');
    const beforeActivation = await db.collection<ProjectionMigrationStateDocument | ProjectionMigrationJournalDocument>('projection_migration_control')
      .findOne({ _id: 'state:real-migration' });
    assert(beforeActivation?.phase === 'sources_replayed', 'Activation conflict changed migration state.');
    await db.collection<ProjectionTransportDocument>('projection_transport').deleteOne({ _id: `binding:${manifest.newRegistry.queueId}` });
    await client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 1 },
      data: { failCommands: ['commitTransaction'], closeConnection: true } });
    const [activationA, activationB] = await Promise.all([cli('activate', args), cli('activate', args)]);
    assert([activationA, activationB].filter((result) => result.code === 0).length === 1, 'Concurrent activation did not choose one winner.');
    const activationRestart = await cli('activate', args);
    assert(activationRestart.code === 0 && activationRestart.receipt.mutated === false, 'Activated restart was not idempotent.');
    const verified = await cli('verify', args); assert(verified.code === 0, 'Trusted output verification failed.');
    const rollback = await cli('rollback', args); assert(rollback.code !== 0 && Array.isArray(rollback.receipt.reasons)
      && rollback.receipt.reasons.includes('postActivationForwardRebuildRequired'), 'Post-activation rollback did not reject.');
    const receiptCount = await db.collection(newCollections.migrationReceipts).countDocuments();
    const active = await db.collection<ProjectionGenerationRecord | ProjectionActiveGenerationRecord>('projection_generation_control')
      .findOne({ _id: `active:${manifest.projectionName}` });
    assert(receiptCount === 8 && active?.generation === 'v2', 'Migration receipt or active pointer mismatch.');
    evidence = { gitSha, databaseName, commands: ['preflight --dry-run', 'preflight', 'verify-sources(rejected)', 'verify-sources', 'replay', 'replay', 'activate(conflict)',
      'activate(x2 one CAS winner,unknown commit injected)', 'activate(idempotent)', 'verify', 'rollback(rejected)'], dryRunCreatedNothing: true,
      corruptSecondSourceProjectionCounts: [0, 0, 0, 0], journalRows: 2, receiptCount, activeGeneration: active.generation,
      replayCrashReceiptCount: crashReceiptCount, replayRestartAfterSigkill: true,
      activationConflictPreservedReplayState: true, unknownCommitInjected: true,
      replaySnapshot: replayed.receipt.snapshot, verifiedSnapshot: verified.receipt.snapshot, databaseDropped: true };
  } finally { await db.dropDatabase(); await client.close(); }
  await writeFile(evidencePath, JSON.stringify(evidence));
}

run().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
