import type {
  ProjectionQueueRegistryBindResult,
  ProjectionQueueRegistryBinding,
  ProjectionQueueRegistryBindingPort,
  ProjectionQueueRegistryManifest,
  ProjectionSourceCommit,
  ProjectionSourceCoverage,
  ProjectionSourceCoverageAdvance,
  ProjectionSourceDispatchAdmission,
  ProjectionSourceOrderPort
} from '@redemeine/projection-runtime-core';
import {
  hasMatchingProjectionRegistryIdentity,
  validateProjectionQueueRegistryManifest,
  validateProjectionSourceCommit
} from '@redemeine/projection-runtime-core';
import type { ClientSession, Collection, Document } from 'mongodb';
import { assertAcceptedBaseline, probeAcceptedTail, type AcceptedBaseline } from './acceptedBaseline';
import type { TapewormMongoRangeReader } from './tapewormMongoRangeReader';
import { collectionNamespace, validateApproval, verifyInitialLinks, type JoinedApproval,
  type JoinedInventory } from './joinedCutover';

export interface ProjectionTransportBindingDocument extends Document {
  _id: string;
  kind: 'binding';
  queueBindingId: string;
  manifest: ProjectionQueueRegistryManifest;
  binding: ProjectionQueueRegistryBinding;
}

export interface ProjectionTransportCoverageDocument extends Document {
  _id: string;
  kind: 'coverage';
  queueBindingId: string;
  sourceId: string;
  startAnchor: number;
  sequence: number | null;
}

export interface ProjectionTransportBaselineDocument extends Document {
  _id: string;
  kind: 'baseline';
  record: AcceptedBaseline;
}

export interface ProjectionTransportProbeDocument extends Document {
  _id: string;
  kind: 'source_probe';
  queueBindingId: string;
  manifestId: string;
  sourceId: string;
  observedHighWatermark: number;
  observedAt: string;
  queueTopology: 'durable_queue_and_dlx_asserted' | 'not_checked';
  indexName: string;
}

export interface ProjectionTransportJoinedAdoptionDocument extends Document {
  _id: string;
  kind: 'joined_adoption';
  queueBindingId: string;
  manifestId: string;
  registryGeneration: string;
  approvalDigest: string;
  transportNamespace: string;
}

export interface AcceptedBaselineReadiness {
  readonly reader: TapewormMongoRangeReader;
}

export interface MongoProjectionTransportStoreOptions {
  readonly collection: Collection<ProjectionTransportDocument>;
  readonly mongoClient: { startSession(): ClientSession };
  readonly manifest: ProjectionQueueRegistryManifest;
  readonly now?: () => string;
  readonly cutoverReadiness?: AcceptedBaselineReadiness;
  readonly joinedInventories?: readonly JoinedInventory[];
  /** Provisioned with operator-only write rights; workers only read this separate collection. */
  readonly joinedApprovals?: Collection<JoinedApproval>;
}

export type ProjectionTransportDocument = ProjectionTransportBindingDocument | ProjectionTransportCoverageDocument
  | ProjectionTransportBaselineDocument | ProjectionTransportProbeDocument | ProjectionTransportJoinedAdoptionDocument;

const BINDING_INDEX = 'projection_transport_queue_binding_unique';
const COVERAGE_INDEX = 'projection_transport_queue_source_unique';
const BASELINE_INDEX = 'projection_transport_baseline_queue_source_unique';

function sameManifest(left: ProjectionQueueRegistryManifest, right: ProjectionQueueRegistryManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function coverageId(queueBindingId: string, sourceId: string): string {
  return `coverage:${queueBindingId}:${sourceId}`;
}

function baselineId(queueBindingId: string, sourceId: string): string {
  return `baseline:${queueBindingId}:${sourceId}`;
}

function toCoverage(row: ProjectionTransportCoverageDocument): ProjectionSourceCoverage {
  return { queueBindingId: row.queueBindingId, sourceId: row.sourceId, sequence: row.sequence };
}

export class MongoProjectionTransportStore implements ProjectionSourceOrderPort, ProjectionQueueRegistryBindingPort {
  private readiness: Promise<void> | undefined;
  private readonly now: () => string;

  constructor(private readonly options: MongoProjectionTransportStoreOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  initialize(): Promise<void> {
    this.readiness ??= this.ensureReady();
    return this.readiness;
  }

  async bindImmutableManifest(manifest: ProjectionQueueRegistryManifest): Promise<ProjectionQueueRegistryBindResult> {
    const issues = validateProjectionQueueRegistryManifest(manifest);
    if (issues.length > 0) throw new Error(`Invalid registry manifest: ${issues.join(',')}`);
    const binding: ProjectionQueueRegistryBinding = {
      queueId: manifest.queueId,
      manifestId: manifest.manifestId,
      registryGeneration: manifest.registryGeneration,
      identity: manifest.identity,
      boundAt: this.now()
    };
    const before = await this.readBindingDocument(manifest.queueId);
    if (before) return sameManifest(before.manifest, manifest)
      ? { status: 'matches', binding: before.binding }
      : { status: 'conflict', existing: before.binding, reason: 'Immutable queue registry manifest differs.' };
    await this.options.collection.updateOne(
      { _id: `binding:${manifest.queueId}` },
      { $setOnInsert: { kind: 'binding', queueBindingId: manifest.queueId, manifest, binding } },
      { upsert: true, writeConcern: { w: 'majority' } }
    );
    const existing = await this.readBindingDocument(manifest.queueId);
    if (existing && sameManifest(existing.manifest, manifest)) return { status: 'bound', binding: existing.binding };
    if (!existing) throw new Error('Queue binding insert outcome is unknown.');
    return { status: 'conflict', existing: existing.binding, reason: 'Immutable queue registry manifest differs.' };
  }

  async readQueueBinding(queueId: string): Promise<ProjectionQueueRegistryBinding | null> {
    return (await this.readBindingDocument(queueId))?.binding ?? null;
  }

  async installAcceptedBaseline(record: AcceptedBaseline): Promise<void> {
    await this.initialize();
    assertAcceptedBaseline(record, this.options.manifest);
    const reader = this.options.cutoverReadiness?.reader;
    if (!reader) throw new Error('Indexed source reader is required to install a baseline.');
    await reader.initialize();
    const highWatermark = await probeAcceptedTail(record, reader);
    const _id = baselineId(record.queueBindingId, record.sourceId);
    const prior = await this.options.collection.findOne({ _id }, { readConcern: { level: 'majority' } });
    if (!prior && await this.readCoverage(coverageId(record.queueBindingId, record.sourceId))) {
      throw new Error('Source coverage predates accepted-baseline registration.');
    }
    try {
      await this.options.collection.updateOne({ _id }, { $setOnInsert: { kind: 'baseline', record } },
        { upsert: true, writeConcern: { w: 'majority' } });
    } catch (error) {
      const row = await this.options.collection.findOne({ _id });
      if (!row || row.kind !== 'baseline' || JSON.stringify(row.record) !== JSON.stringify(record)) throw error;
    }
    const row = await this.options.collection.findOne({ _id }, { readConcern: { level: 'majority' } });
    if (!row || row.kind !== 'baseline' || JSON.stringify(row.record) !== JSON.stringify(record)) {
      throw new Error('Immutable accepted-baseline cutover conflict or unknown insert outcome.');
    }
    await this.recordSourceProbe(record, highWatermark, 'not_checked');
  }

  async probeRegisteredSource(queueId: string, sourceId: string,
    queueTopology: ProjectionTransportProbeDocument['queueTopology']): Promise<{ record: AcceptedBaseline; highWatermark: number }> {
    await this.initialize();
    const record = await this.readAcceptedBaseline(queueId, sourceId);
    const reader = this.options.cutoverReadiness?.reader;
    if (!record || !reader) throw new Error('Missing baseline or indexed source reader.');
    await reader.initialize();
    const highWatermark = await probeAcceptedTail(record, reader);
    await this.recordSourceProbe(record, highWatermark, queueTopology);
    return { record, highWatermark };
  }

  async loadCoveredThrough(queueId: string, sourceId: string): Promise<number | null> {
    const record = await this.readAcceptedBaseline(queueId, sourceId);
    if (!record) throw new Error('Unknown accepted source.');
    const row = await this.readCoverage(coverageId(queueId, sourceId));
    if (row && row.startAnchor !== record.startAnchor) throw new Error('Immutable source anchor conflict.');
    return row?.sequence ?? null;
  }

  async readAcceptedBaseline(queueId: string, sourceId: string): Promise<AcceptedBaseline | null> {
    const row = await this.options.collection.findOne({ _id: baselineId(queueId, sourceId), kind: 'baseline' },
      { readConcern: { level: 'majority' } });
    if (!row || row.kind !== 'baseline') return null;
    assertAcceptedBaseline(row.record, this.options.manifest);
    return row.record;
  }

  async verifyJoinedCutover(queueId: string, sourceId: string): Promise<void> {
    await this.initialize();
    if (queueId !== this.options.manifest.queueId) throw new Error('Joined cutover queue binding mismatch.');
    const baseline = await this.readAcceptedBaseline(queueId, sourceId);
    if (!baseline) throw new Error('Missing accepted baseline before joined cutover.');
    const binding = await this.readBindingDocument(queueId);
    if (!binding || !sameManifest(binding.manifest, this.options.manifest)) throw new Error('Joined registry binding changed.');
    const items = this.options.joinedInventories ?? [];
    if (!this.options.manifest.definitions.some((entry) => entry.joined === true)) {
      if (items.length) throw new Error('Unexpected joined resources without joined definitions.');
      return;
    }
    const transportNamespace = collectionNamespace(this.options.collection);
    const approvalNamespace = this.options.joinedApprovals ? collectionNamespace(this.options.joinedApprovals) : '';
    const approval = await this.options.joinedApprovals?.findOne({ _id: `joined_approval:${queueId}` },
      { readConcern: { level: 'majority' } }) ?? null;
    validateApproval(this.options.manifest, approval, items, transportNamespace, approvalNamespace);
    const _id = `joined_adoption:${queueId}`;
    const expected: ProjectionTransportJoinedAdoptionDocument = { _id, kind: 'joined_adoption', queueBindingId: queueId,
      manifestId: this.options.manifest.manifestId, registryGeneration: this.options.manifest.registryGeneration,
      transportNamespace, approvalDigest: approval.digest };
    const prior = await this.options.collection.findOne({ _id }, { readConcern: { level: 'majority' } });
    if (!prior) {
      await this.adoptJoinedApproval(approval, expected, items);
    }
    await this.assertJoinedAdoption(expected);
  }

  private async assertJoinedAdoption(expected: ProjectionTransportJoinedAdoptionDocument): Promise<void> {
    const adopted = await this.options.collection.findOne({ _id: expected._id }, { readConcern: { level: 'majority' } });
    if (!adopted || adopted.kind !== 'joined_adoption' || adopted.queueBindingId !== expected.queueBindingId
      || adopted.manifestId !== expected.manifestId || adopted.registryGeneration !== expected.registryGeneration
      || adopted.transportNamespace !== expected.transportNamespace || adopted.approvalDigest !== expected.approvalDigest
      || Object.keys(adopted).length !== Object.keys(expected).length) {
      throw new Error('Joined cutover adoption conflict or unknown insert outcome.');
    }
  }

  private async adoptJoinedApproval(approval: JoinedApproval, expected: ProjectionTransportJoinedAdoptionDocument,
    resources: readonly JoinedInventory[]): Promise<void> {
    const session = this.options.mongoClient.startSession();
    try {
      await session.withTransaction(async () => {
        const persisted = await this.options.joinedApprovals?.findOne({ _id: approval._id }, { session });
        if (!persisted || persisted.kind !== 'joined_approval' || JSON.stringify(persisted) !== JSON.stringify(approval)) {
          throw new Error('Joined approval changed during adoption.');
        }
        const previous = await this.options.collection.findOne({ _id: expected._id }, { session });
        if (previous) return;
        for (const [index, item] of approval.inventories.entries()) {
          const resource = resources[index];
          if (!resource) throw new Error('Missing joined collection handle.');
          await verifyInitialLinks(item, resource, session);
        }
        await this.options.collection.insertOne(expected, { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (error) {
      // A concurrent adopter can win the insert. Only its matching majority record authorizes this worker.
      let reconciled = false;
      for (let attempt = 0; attempt < 3 && !reconciled; attempt += 1) {
        try { await this.assertJoinedAdoption(expected); reconciled = true; } catch {
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!reconciled) throw error;
    } finally {
      await session.endSession();
    }
  }

  async admitForDispatch(
    commit: ProjectionSourceCommit,
    queueBindingId: string
  ): Promise<ProjectionSourceDispatchAdmission> {
    if (!validateProjectionSourceCommit(commit).valid) throw new Error('Cannot admit an invalid source commit.');
    await this.initialize();
    if (queueBindingId !== this.options.manifest.queueId) throw new Error('Queue binding does not match the manifest.');
    const baseline = await this.readAcceptedBaseline(queueBindingId, commit.streamId);
    if (!baseline) throw new Error('Missing accepted-baseline cutover or source birth record.');
    await this.verifyJoinedCutover(queueBindingId, commit.streamId);
    await this.probeRegisteredSource(queueBindingId, commit.streamId, 'not_checked');
    const startAnchor = baseline.startAnchor;
    const id = coverageId(queueBindingId, commit.streamId);
    await this.options.collection.updateOne(
      { _id: id },
      { $setOnInsert: { kind: 'coverage', queueBindingId, sourceId: commit.streamId, startAnchor, sequence: null } },
      { upsert: true }
    );
    const row = await this.readCoverage(id);
    if (!row || row.startAnchor !== startAnchor) throw new Error('Immutable source start anchor differs.');
    return { dispatch: true, coverage: toCoverage(row), startAnchor, strategyScope: baseline.strategyScope };
  }

  async advanceCoverage(request: ProjectionSourceCoverageAdvance): Promise<ProjectionSourceCoverage> {
    await this.initialize();
    const id = coverageId(request.queueBindingId, request.sourceId);
    const current = await this.readCoverage(id);
    if (!current) throw new Error('Coverage must be admitted before it can advance.');
    this.assertContiguousAdvance(current, request);
    try {
      const result = await this.options.collection.updateOne(
        { _id: id, kind: 'coverage', sequence: request.expectedSequence },
        { $set: { sequence: request.sequence } }
      );
      if (result.matchedCount === 1) return { ...toCoverage(current), sequence: request.sequence };
    } catch (error) {
      const reconciled = await this.reconcileCoverage(id, request);
      if (reconciled) return reconciled;
      throw error;
    }
    const reconciled = await this.reconcileCoverage(id, request);
    if (reconciled) return reconciled;
    throw new Error('Coverage compare-and-advance conflict.');
  }

  private async ensureReady(): Promise<void> {
    await this.options.collection.createIndex({ kind: 1, queueBindingId: 1 }, { name: BINDING_INDEX, unique: true, partialFilterExpression: { kind: 'binding' } });
    await this.options.collection.createIndex(
      { kind: 1, queueBindingId: 1, sourceId: 1 },
      { name: COVERAGE_INDEX, unique: true, partialFilterExpression: { kind: 'coverage' } }
    );
    await this.options.collection.createIndex({ kind: 1, 'record.queueBindingId': 1, 'record.sourceId': 1 },
      { name: BASELINE_INDEX, unique: true, partialFilterExpression: { kind: 'baseline' } });
    const indexes = await this.options.collection.listIndexes().toArray();
    const expectedKeys: Readonly<Record<string, readonly string[]>> = {
      [BINDING_INDEX]: ['kind', 'queueBindingId'],
      [COVERAGE_INDEX]: ['kind', 'queueBindingId', 'sourceId'],
      [BASELINE_INDEX]: ['kind', 'record.queueBindingId', 'record.sourceId']
    };
    for (const name of [BINDING_INDEX, COVERAGE_INDEX, BASELINE_INDEX]) {
      const index = indexes.find((entry) => entry.name === name);
      const keys = index?.key && typeof index.key === 'object' ? Object.keys(index.key) : [];
      if (!index || index.unique !== true || 'expireAfterSeconds' in index || keys.join(',') !== expectedKeys[name]?.join(',')) {
        throw new Error(`Required non-TTL index is not ready: ${name}`);
      }
    }
    const bound = await this.bindImmutableManifest(this.options.manifest);
    if (bound.status === 'conflict' || !hasMatchingProjectionRegistryIdentity(this.options.manifest, bound.binding)) {
      throw new Error('Immutable projection registry binding mismatch.');
    }
    const session = this.options.mongoClient.startSession();
    try {
      await session.withTransaction(() => this.options.collection.findOne({ _id: '__projection_transport_readiness__' }, { session }), {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }
      });
    } finally {
      await session.endSession();
    }
  }

  private assertContiguousAdvance(row: ProjectionTransportCoverageDocument, request: ProjectionSourceCoverageAdvance): void {
    if (row.queueBindingId !== request.queueBindingId || row.sourceId !== request.sourceId) throw new Error('Coverage scope mismatch.');
    if (request.expectedSequence !== row.sequence) throw new Error('Coverage compare-and-advance conflict.');
    const expectedNext = row.sequence === null ? row.startAnchor : row.sequence + 1;
    if (request.sequence !== expectedNext) throw new Error('Coverage advance must be contiguous from the immutable start anchor.');
  }

  private async reconcileCoverage(
    id: string,
    request: ProjectionSourceCoverageAdvance
  ): Promise<ProjectionSourceCoverage | null> {
    const row = await this.readCoverage(id);
    return row?.sequence === request.sequence ? toCoverage(row) : null;
  }

  private async readCoverage(id: string): Promise<ProjectionTransportCoverageDocument | null> {
    const row = await this.options.collection.findOne({ _id: id, kind: 'coverage' });
    return row?.kind === 'coverage' ? row : null;
  }

  private async recordSourceProbe(record: AcceptedBaseline, highWatermark: number,
    queueTopology: ProjectionTransportProbeDocument['queueTopology']): Promise<void> {
    const indexName = this.options.cutoverReadiness?.reader.getIndexName();
    if (!indexName) throw new Error('Indexed source reader was not initialized.');
    const _id = `probe:${record.queueBindingId}:${record.sourceId}`;
    const prior = await this.options.collection.findOne({ _id });
    const lastCheckedTopology = queueTopology === 'not_checked' && prior?.kind === 'source_probe'
      ? prior.queueTopology : queueTopology;
    await this.options.collection.updateOne({ _id },
      { $set: { kind: 'source_probe', queueBindingId: record.queueBindingId, manifestId: record.manifestId,
        sourceId: record.sourceId, observedHighWatermark: highWatermark, observedAt: this.now(),
        queueTopology: lastCheckedTopology, indexName } },
      { upsert: true, writeConcern: { w: 'majority' } });
  }

  private async readBindingDocument(queueId: string): Promise<ProjectionTransportBindingDocument | null> {
    const row = await this.options.collection.findOne({ _id: `binding:${queueId}`, kind: 'binding' },
      { readConcern: { level: 'majority' } });
    return row?.kind === 'binding' ? row : null;
  }
}
