import type { ProjectionQueueRegistryBinding, ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { type ClientSession, type Collection, type Document, type MongoClient } from 'mongodb';
import type { ProjectionTransportDocument } from '../mongoTransportStore';
import { ProjectionMigrationStreamingDigest, projectionMigrationDigest } from './digest';
import type {
  ProjectionMigrationActivationPort,
  ProjectionMigrationManifest,
  ProjectionMigrationRangeJournal,
  ProjectionMigrationSnapshot,
  ProjectionMigrationSnapshotPort,
  ProjectionMigrationState,
  ProjectionMigrationStatePort,
  ProjectionMigrationTrustedPreflightPort
} from './types';

export interface ProjectionMigrationStateDocument extends Document, ProjectionMigrationState {
  _id: string;
  kind: 'state';
}
export interface ProjectionMigrationJournalDocument extends Document, ProjectionMigrationRangeJournal {
  _id: string;
  kind: 'journal';
}
type StringDocument = Document & { _id: string };
export interface ProjectionGenerationRecord extends Document {
  _id: string;
  kind: 'generation';
  projectionName: string;
  generation: string;
  manifest: ProjectionQueueRegistryManifest;
  collections: ProjectionGenerationCollections;
  strategies: Readonly<Record<string, 'in_document' | 'own_record' | 'none'>>;
}
export interface ProjectionActiveGenerationRecord extends Document {
  _id: string;
  kind: 'active';
  projectionName: string;
  generation: string;
  queueId: string;
  manifestDigest: string;
  revision: number;
}
export interface ProjectionGenerationCollections {
  documents: string;
  links: string;
  progress: string;
  migrationReceipts: string;
}
export interface ProjectionMigrationActivationHooks {
  afterTransactionCommitted?(): void;
  reconciliationObserved?(): void;
}

export class MongoProjectionGenerationResolver {
  constructor(private readonly control: Collection<ProjectionGenerationRecord | ProjectionActiveGenerationRecord>) {}
  async readActive(projectionName: string): Promise<ProjectionActiveGenerationRecord | null> {
    const row = await this.control.findOne({ _id: activeId(projectionName), kind: 'active' });
    return isActive(row) ? row : null;
  }
  async readGeneration(projectionName: string, generation: string): Promise<ProjectionGenerationRecord | null> {
    const row = await this.control.findOne({ _id: generationId(projectionName, generation), kind: 'generation' });
    return isGeneration(row) ? row : null;
  }
}

const journalId = (migrationId: string, rangeKey: string): string => `journal:${migrationId}:${rangeKey}`;
const stateId = (migrationId: string): string => `state:${migrationId}`;
const generationId = (projection: string, generation: string): string => `generation:${projection}:${generation}`;
const activeId = (projection: string): string => `active:${projection}`;

export class MongoProjectionMigrationStatePort implements ProjectionMigrationStatePort {
  constructor(readonly collection: Collection<ProjectionMigrationStateDocument | ProjectionMigrationJournalDocument>) {}
  async initialize(): Promise<void> {
    await this.collection.createIndex(
      { kind: 1, migrationId: 1, rangeKey: 1 },
      { name: 'projection_migration_journal_unique', unique: true, partialFilterExpression: { kind: 'journal' } }
    );
  }
  async load(migrationId: string): Promise<ProjectionMigrationState | null> {
    const row = await this.collection.findOne({ _id: stateId(migrationId), kind: 'state' });
    if (!row || row.kind !== 'state') return null;
    const { _id, kind, ...state } = row;
    return state;
  }
  async compareAndSet(expectedRevision: number | null, state: ProjectionMigrationState): Promise<boolean> {
    if (expectedRevision === null) {
      try {
        const result = await this.collection.updateOne(
          { _id: stateId(state.migrationId) },
          { $setOnInsert: { _id: stateId(state.migrationId), kind: 'state', ...state } },
          { upsert: true }
        );
        return result.upsertedCount === 1;
      } catch (error) {
        if (mongoCode(error) === 11000) return false;
        throw error;
      }
    }
    const result = await this.collection.replaceOne(
      { _id: stateId(state.migrationId), kind: 'state', revision: expectedRevision },
      { _id: stateId(state.migrationId), kind: 'state', ...state }
    );
    return result.modifiedCount === 1;
  }
  async readJournal(migrationId: string): Promise<readonly ProjectionMigrationRangeJournal[]> {
    const rows = await this.collection.find({ kind: 'journal', migrationId }).sort({ rangeKey: 1 }).batchSize(100).toArray();
    return rows.filter((row): row is ProjectionMigrationJournalDocument => row.kind === 'journal').map(({ _id, kind, ...row }) => row);
  }
  async writeJournal(row: ProjectionMigrationRangeJournal): Promise<'written' | 'matches' | 'conflict'> {
    const _id = journalId(row.migrationId, row.rangeKey);
    try {
      await this.collection.insertOne({ _id, kind: 'journal', ...row });
      return 'written';
    } catch (error) {
      if (mongoCode(error) !== 11000) throw error;
    }
    const current = await this.collection.findOne({ _id, kind: 'journal' });
    return current && current.kind === 'journal' && sameJournal(current, row) ? 'matches' : 'conflict';
  }
}

export class MongoProjectionMigrationPreflightPort implements ProjectionMigrationTrustedPreflightPort {
  constructor(
    private readonly database: { collection<T extends Document>(name: string): Collection<T> },
    private readonly transport: Collection<ProjectionTransportDocument>,
    private readonly control: Collection<ProjectionGenerationRecord | ProjectionActiveGenerationRecord>,
    private readonly collections: ProjectionGenerationCollections
  ) {}
  async inspect(manifest: ProjectionMigrationManifest, mode: 'preflight' | 'identity' = 'preflight'): Promise<readonly string[]> {
    const issues: string[] = [];
    const [oldGeneration, newGeneration, active, oldBinding, newBinding] = await Promise.all([
      this.control.findOne({ _id: generationId(manifest.projectionName, manifest.oldGeneration), kind: 'generation' }),
      this.control.findOne({ _id: generationId(manifest.projectionName, manifest.newGeneration), kind: 'generation' }),
      this.control.findOne({ _id: activeId(manifest.projectionName), kind: 'active' }),
      this.transport.findOne({ _id: `binding:${manifest.oldRegistry.queueId}`, kind: 'binding' }),
      this.transport.findOne({ _id: `binding:${manifest.newRegistry.queueId}`, kind: 'binding' })
    ]);
    if (
      !isGeneration(oldGeneration) ||
      oldGeneration._id !== generationId(manifest.projectionName, manifest.oldGeneration) ||
      oldGeneration.projectionName !== manifest.projectionName ||
      oldGeneration.generation !== manifest.oldGeneration ||
      !canonicalEqual(oldGeneration.manifest, manifest.oldRegistry)
    )
      issues.push('trustedOldGenerationMismatch');
    const expectedNewGeneration = {
      _id: generationId(manifest.projectionName, manifest.newGeneration),
      kind: 'generation',
      projectionName: manifest.projectionName,
      generation: manifest.newGeneration,
      manifest: manifest.newRegistry,
      collections: this.collections,
      strategies: manifest.destinationStrategies
    };
    if (!canonicalEqual(newGeneration, expectedNewGeneration)) issues.push('trustedNewGenerationMismatch');
    if (isGeneration(oldGeneration) && !projectionGenerationCollectionsAreIsolated(oldGeneration.collections, this.collections))
      issues.push('generationCollectionsNotIsolated');
    const expectedActive = {
      _id: activeId(manifest.projectionName),
      kind: 'active',
      projectionName: manifest.projectionName,
      generation: manifest.oldGeneration,
      queueId: manifest.oldRegistry.queueId,
      manifestDigest: manifest.oldRegistry.manifestId,
      revision: 0
    };
    const expectedActivated = {
      ...expectedActive,
      generation: manifest.newGeneration,
      queueId: manifest.newRegistry.queueId,
      manifestDigest: manifest.newRegistry.manifestId,
      revision: 1
    };
    if (!canonicalEqual(active, expectedActive) && !canonicalEqual(active, expectedActivated)) issues.push('activeGenerationMismatch');
    if (!bindingMatches(oldBinding, manifest.oldRegistry)) issues.push('trustedOldQueueBindingMismatch');
    if (newBinding && !bindingMatches(newBinding, manifest.newRegistry)) issues.push('trustedNewQueueBindingMismatch');
    if (mode === 'preflight')
      for (const name of Object.values(this.collections)) {
        if ((await this.database.collection<StringDocument>(name).findOne({})) !== null) issues.push(`freshCollectionRequired:${name}`);
      }
    return issues;
  }
}

export class MongoProjectionMigrationSnapshotPort implements ProjectionMigrationSnapshotPort {
  constructor(
    private readonly documents: Collection<StringDocument>,
    private readonly links: Collection<StringDocument>,
    private readonly progress: Collection<StringDocument>,
    private readonly receipts: Collection<StringDocument>,
    private readonly manifest: ProjectionMigrationManifest
  ) {}
  async read(): Promise<ProjectionMigrationSnapshot> {
    const prefix = `${this.manifest.projectionName}\u0000${this.manifest.newGeneration}\u0000`;
    const documents = await digestCursor(this.documents, {}, 'documents');
    const links = await digestCursor(this.links, { _id: { $gte: prefix, $lt: `${prefix}\uffff` } }, 'links');
    const liveProgress = await digestCursor(this.progress, { projectionGeneration: this.manifest.newGeneration }, 'live-progress');
    const migrationProgress = await digestCursor(
      this.receipts,
      { migrationId: this.manifest.migrationId, projectionGeneration: this.manifest.newGeneration },
      'migration-progress'
    );
    const combined = new ProjectionMigrationStreamingDigest('redemeine:migration:snapshot:progress:v2');
    combined.update(liveProgress);
    combined.update(migrationProgress);
    return { documents, links, progress: { count: liveProgress.count + migrationProgress.count, digest: combined.finish().digest } };
  }
}

export class MongoProjectionMigrationActivationPort implements ProjectionMigrationActivationPort {
  constructor(
    private readonly client: MongoClient,
    private readonly states: Collection<ProjectionMigrationStateDocument | ProjectionMigrationJournalDocument>,
    private readonly transport: Collection<ProjectionTransportDocument>,
    private readonly control: Collection<ProjectionGenerationRecord | ProjectionActiveGenerationRecord>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly hooks: ProjectionMigrationActivationHooks = {}
  ) {}
  async activate(manifest: ProjectionMigrationManifest, expected: ProjectionMigrationState): Promise<ProjectionMigrationState | null> {
    const next: ProjectionMigrationState = { ...expected, revision: expected.revision + 1, phase: 'activated', activatedAt: this.now() };
    const session = this.client.startSession();
    let post: ActivationPostState | null = null;
    try {
      await session.withTransaction(
        async () => {
          post = await this.writeActivation(manifest, expected, next, session);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
      );
      this.hooks.afterTransactionCommitted?.();
      return next;
    } catch (error) {
      if (!hasUnknownLabel(error)) return null;
      this.hooks.reconciliationObserved?.();
      return post && (await this.reconcile(post)) ? next : null;
    } finally {
      await session.endSession();
    }
  }
  async verifyActive(manifest: ProjectionMigrationManifest): Promise<boolean> {
    const active = await this.control.findOne({ _id: activeId(manifest.projectionName), kind: 'active' });
    const binding = await this.transport.findOne({ _id: `binding:${manifest.newRegistry.queueId}`, kind: 'binding' });
    const expectedActive = {
      _id: activeId(manifest.projectionName),
      kind: 'active',
      projectionName: manifest.projectionName,
      generation: manifest.newGeneration,
      queueId: manifest.newRegistry.queueId,
      manifestDigest: manifest.newRegistry.manifestId,
      revision: 1
    };
    return canonicalEqual(active, expectedActive) && bindingMatches(binding, manifest.newRegistry);
  }
  private async writeActivation(
    manifest: ProjectionMigrationManifest,
    expected: ProjectionMigrationState,
    next: ProjectionMigrationState,
    session: ClientSession
  ): Promise<ActivationPostState> {
    const generation = await this.control.findOne({ _id: generationId(manifest.projectionName, manifest.newGeneration), kind: 'generation' }, { session });
    if (!isGeneration(generation) || !canonicalEqual(generation.manifest, manifest.newRegistry)) throw new Error('immutable generation conflict');
    const binding: ProjectionQueueRegistryBinding = {
      queueId: manifest.newRegistry.queueId,
      manifestId: manifest.newRegistry.manifestId,
      registryGeneration: manifest.newRegistry.registryGeneration,
      identity: manifest.newRegistry.identity,
      boundAt: this.now()
    };
    await this.transport.updateOne(
      { _id: `binding:${manifest.newRegistry.queueId}` },
      { $setOnInsert: { kind: 'binding', queueBindingId: manifest.newRegistry.queueId, manifest: manifest.newRegistry, binding } },
      { upsert: true, session }
    );
    const storedBinding = await this.transport.findOne({ _id: `binding:${manifest.newRegistry.queueId}`, kind: 'binding' }, { session });
    if (!bindingMatches(storedBinding, manifest.newRegistry)) throw new Error('immutable binding conflict');
    const oldActive = {
      _id: activeId(manifest.projectionName),
      kind: 'active' as const,
      projectionName: manifest.projectionName,
      generation: manifest.oldGeneration,
      queueId: manifest.oldRegistry.queueId,
      manifestDigest: manifest.oldRegistry.manifestId,
      revision: 0
    };
    const active = {
      ...oldActive,
      generation: manifest.newGeneration,
      queueId: manifest.newRegistry.queueId,
      manifestDigest: manifest.newRegistry.manifestId,
      revision: 1
    };
    const pointer = await this.control.replaceOne(oldActive, active, { session });
    const state = await this.states.replaceOne(
      { _id: stateId(manifest.migrationId), kind: 'state', revision: expected.revision, manifestDigest: manifest.manifestDigest, phase: 'sources_replayed' },
      { _id: stateId(manifest.migrationId), kind: 'state', ...next },
      { session }
    );
    if (pointer.modifiedCount !== 1 || state.modifiedCount !== 1) throw new Error('activation CAS conflict');
    return { state: { _id: stateId(manifest.migrationId), kind: 'state', ...next }, binding: storedBinding, active };
  }
  private async reconcile(expected: ActivationPostState): Promise<boolean> {
    const [state, binding, active] = await Promise.all([
      this.states.findOne({ _id: expected.state._id, kind: 'state' }),
      this.transport.findOne({ _id: expected.binding._id, kind: 'binding' }),
      this.control.findOne({ _id: expected.active._id, kind: 'active' })
    ]);
    return canonicalEqual(state, expected.state) && canonicalEqual(binding, expected.binding) && canonicalEqual(active, expected.active);
  }
}

interface ActivationPostState {
  state: ProjectionMigrationStateDocument;
  binding: ProjectionTransportDocument;
  active: ProjectionActiveGenerationRecord;
}

async function digestCursor(collection: Collection<StringDocument>, filter: Document, domain: string): Promise<{ count: number; digest: `sha256:${string}` }> {
  const digest = new ProjectionMigrationStreamingDigest(`redemeine:migration:snapshot:${domain}:v2`);
  for await (const row of collection.find(filter).sort({ _id: 1 }).batchSize(100)) digest.update(row);
  const result = digest.finish();
  return { count: result.count, digest: result.digest };
}
function sameJournal(left: ProjectionMigrationJournalDocument, right: ProjectionMigrationRangeJournal): boolean {
  return (
    left.manifestDigest === right.manifestDigest &&
    left.expectedDigest === right.expectedDigest &&
    left.observedDigest === right.observedDigest &&
    left.commitCount === right.commitCount &&
    left.encodedBytes === right.encodedBytes
  );
}
function isGeneration(value: unknown): value is ProjectionGenerationRecord {
  return typeof value === 'object' && value !== null && (value as Document).kind === 'generation';
}
function isActive(value: unknown): value is ProjectionActiveGenerationRecord {
  return typeof value === 'object' && value !== null && (value as Document).kind === 'active';
}
function mongoCode(error: unknown): number | null {
  return typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : null;
}
function hasUnknownLabel(error: unknown): boolean {
  return error instanceof Error && (error as Error & { hasErrorLabel?: (label: string) => boolean }).hasErrorLabel?.('UnknownTransactionCommitResult') === true;
}
function canonicalEqual(left: unknown, right: unknown): boolean {
  return projectionMigrationDigest(left) === projectionMigrationDigest(right);
}
function bindingMatches(value: unknown, manifest: ProjectionQueueRegistryManifest): value is ProjectionTransportDocument {
  if (!value || typeof value !== 'object' || (value as Document).kind !== 'binding') return false;
  const row = value as ProjectionTransportDocument;
  if (row.kind !== 'binding') return false;
  if (typeof row.binding.boundAt !== 'string') return false;
  return canonicalEqual(row, {
    _id: `binding:${manifest.queueId}`,
    kind: 'binding',
    queueBindingId: manifest.queueId,
    manifest,
    binding: {
      queueId: manifest.queueId,
      manifestId: manifest.manifestId,
      registryGeneration: manifest.registryGeneration,
      identity: manifest.identity,
      boundAt: row.binding.boundAt
    }
  });
}
export function projectionGenerationCollectionsAreIsolated(oldCollections: ProjectionGenerationCollections, next: ProjectionGenerationCollections): boolean {
  const names = [...Object.values(oldCollections), ...Object.values(next)];
  return names.length === new Set(names).size;
}
