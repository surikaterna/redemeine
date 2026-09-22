import type { ProjectionQueueRegistryBinding, ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import type { ClientSession, Collection, Document, MongoClient } from 'mongodb';
import type { ProjectionTransportDocument } from '../mongoTransportStore';
import { projectionMigrationDigest } from './digest';
import type {
  ProjectionActiveGenerationRecord,
  ProjectionGenerationRecord,
  ProjectionMigrationJournalDocument,
  ProjectionMigrationStateDocument
} from './mongoPorts';
import type { ProjectionMigrationActivationPort, ProjectionMigrationManifest, ProjectionMigrationState } from './types';

export interface ProjectionMigrationActivationHooks {
  afterTransactionCommitted?(): void;
  reconciliationObserved?(): void;
}
interface ActivationPostState {
  state: ProjectionMigrationStateDocument;
  binding: ProjectionTransportDocument;
  active: ProjectionActiveGenerationRecord;
}

const stateId = (migrationId: string): string => `state:${migrationId}`;
const generationId = (projection: string, generation: string): string => `generation:${projection}:${generation}`;
const activeId = (projection: string): string => `active:${projection}`;

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
    const [active, binding] = await Promise.all([
      this.control.findOne({ _id: activeId(manifest.projectionName), kind: 'active' }),
      this.transport.findOne({ _id: `binding:${manifest.newRegistry.queueId}`, kind: 'binding' })
    ]);
    const expected = {
      _id: activeId(manifest.projectionName),
      kind: 'active',
      projectionName: manifest.projectionName,
      generation: manifest.newGeneration,
      queueId: manifest.newRegistry.queueId,
      manifestDigest: manifest.newRegistry.manifestId,
      revision: 1
    };
    return canonicalEqual(active, expected) && bindingMatches(binding, manifest.newRegistry);
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

function isGeneration(value: unknown): value is ProjectionGenerationRecord {
  return typeof value === 'object' && value !== null && (value as Document).kind === 'generation';
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
  if (row.kind !== 'binding' || typeof row.binding.boundAt !== 'string') return false;
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
