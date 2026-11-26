import assert from 'node:assert/strict';
import { createProjection, type ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type { ClientSession, Db, MongoClient } from 'mongodb';
import { createProjectionCommitCoordinator } from '../../projection-worker-core/src/createProjectionCommitCoordinator';
import { MongoProjectionStore, type MongoProjectionChangesRecord, type ProjectionDedupeRecord,
  type ProjectionDocumentRecord, type ProjectionLinkRecord } from '../src';

type State = { value: number };
const digest = `sha256:${'a'.repeat(64)}` as const;

function noneCoordinator(store: MongoProjectionStore<State>, commit: ProjectionSourceCommit, anchor: number) {
  const definition = createProjection('none_feed', () => ({ value: 0 }))
    .from({ aggregateType: 'Order', initialState: {}, pure: { eventProjectors: {} } }, {
      Changed(state) { state.value += 1; }
    })
    .identity(() => 'one').deduplication({ strategy: 'none', duplicateEffects: 'acknowledged', reason: 'integration' })
    .buildCommitDefinition();
  let coverage: number | null = null;
  const advances: number[] = [];
  const coordinator = createProjectionCommitCoordinator({
    definitions: [{ definition, generation: 'g1', projectionChanges: 'none_views' }], queueBindingId: 'none', maxCommits: 2, maxBytes: 1024, store,
    manifest: {
      version: 1, manifestId: digest, queueId: 'none', registryGeneration: 'r1', definitions: [
        { projectionName: definition.name, generation: 'g1', definitionHash: digest, sourceSelectors: ['Order'], projectionChanges: 'none_views' }
      ], identity: { version: 1, normalizedDefinitionRegistryDigest: digest, normalizedRuntimeConfigurationDigest: digest,
        executableCodeArtifactDigest: digest }, sourceStartAnchors: { [commit.streamId]: anchor }
    },
    sourceOrder: {
      async admitForDispatch(sourceCommit, queueBindingId, proof) {
        return { dispatch: true, startAnchor: anchor, coverage: { sourceId: sourceCommit.streamId, queueBindingId, sequence: coverage },
          boundDispatchProof: proof,
          strategyScope: [{ projectionName: definition.name, generation: 'g1', strategy: 'none', stableSingleTarget: true }] };
      },
      async advanceCoverage(request) {
        coverage = request.sequence;
        advances.push(request.sequence);
        return { sourceId: request.sourceId, queueBindingId: request.queueBindingId, sequence: request.sequence };
      }
    },
    rangeReader: { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
      async readCompleteRange() { throw new Error('unexpected gap'); } }
  });
  return { coordinator, advances };
}

function createUnknownCommitInjection(client: MongoClient) {
  let pending: 'before' | 'after' | undefined;
  return {
    arm(when: 'before' | 'after') { pending = when; },
    startSession(): ClientSession {
      const session = client.startSession();
      const withTransaction: ClientSession['withTransaction'] = async (work, options) => {
        const inject = pending;
        pending = undefined;
        const unknown = Object.assign(new Error('injected unknown commit outcome'), {
          hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult'
        });
        if (inject === 'before') throw unknown;
        const result = await session.withTransaction(work, options);
        if (inject === 'after') throw unknown;
        return result;
      };
      return new Proxy(session, {
        get(target, property) {
          if (property === 'withTransaction') return withTransaction;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
}

export async function checkRealNoneProjectionChanges(db: Db, client: MongoClient, commit: ProjectionSourceCommit): Promise<void> {
  for (const anchor of [0, 1]) {
    const collection = db.collection<ProjectionDocumentRecord<State>>(`none_views_${anchor}`);
    const linkCollection = db.collection<ProjectionLinkRecord>(`none_links_${anchor}`);
    const dedupeCollection = db.collection<ProjectionDedupeRecord>(`none_dedupe_${anchor}`);
    const rows = await db.createCollection<MongoProjectionChangesRecord>(`none_feed_${anchor}`, {
      validator: { 'targets.0.revision': { $lte: 4 } }
    });
    const mongoClient = createUnknownCommitInjection(client);
    let hideReceipt = false;
    const store = new MongoProjectionStore({ collection, linkCollection, dedupeCollection, mongoClient, changeCollection: {
      findOne: (filter, options) => hideReceipt && !options?.session ? Promise.resolve(null) : rows.findOne(filter, options),
      updateOne: (filter, update, options) => rows.updateOne(filter, update, options)
    } });
    const { coordinator, advances } = noneCoordinator(store, commit, anchor);
    assert.equal((await coordinator.process(commit)).status, 'completed');
    mongoClient.arm('after');
    assert.equal((await coordinator.process(commit)).status, 'completed', 'same-invocation receipt must resolve actual commit');
    if (anchor === 0) assert.deepEqual((await coordinator.processPolled(commit)).processedSequences, []);
    assert.equal(await rows.countDocuments(), 2);
    mongoClient.arm('before');
    assert.match(JSON.stringify(await coordinator.process(commit)), /"status":"retryable".*ambiguous transaction outcome/);
    assert.equal(await rows.countDocuments(), 2, 'an earlier application is not proof of this invocation');
    mongoClient.arm('after');
    hideReceipt = true;
    assert.match(JSON.stringify(await coordinator.process(commit)), /"status":"retryable".*ambiguous transaction outcome/);
    hideReceipt = false;
    assert.deepEqual(await store.load('one'), { value: 3 });
    assert.equal((await coordinator.process(commit)).status, 'completed');
    assert.deepEqual(await store.load('one'), { value: 4 });
    const records = (await rows.find({}).toArray()).filter((row) => row.kind === 'projection_changes');
    assert.deepEqual(records.map((row) => row.targets[0]?.revision).sort(), [1, 2, 3, 4]);
    assert.equal(new Set(records.map((row) => row.applicationId)).size, 4);
    assert.deepEqual(advances, anchor === 0 ? [0] : []);
    assert.match(JSON.stringify(await coordinator.process(commit)), /"status":"terminal".*code 121/);
    assert.deepEqual(await store.load('one'), { value: 4 }, 'a rejected fifth append rolls back the projection mutation');
    assert.equal(await rows.countDocuments(), 4);
  }
}
