import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { captureProjectionSourceEvent, joinMembershipKey, sealProjectionCaptureRequest,
  type CommitProjectionSourceCommitRequest, type JoinSeedEdge } from '@redemeine/projection-runtime-core';
import type { ClientSession, CommandStartedEvent, Db, MongoClient } from 'mongodb';
import { MongoProjectionStore, type MongoProjectionStoreOptions } from '../src';

type State = { visits: number };
type Request = CommitProjectionSourceCommitRequest<State>;
const membership = { aggregateType: 'Order', aggregateId: 'order', expectedRevision: null, targetDocumentIds: ['A'] };
const key = joinMembershipKey(membership.aggregateType, membership.aggregateId);

function request(name: string): Request {
  const source = randomUUID();
  return {
    version: 1, mode: 'atomic-all', projectionName: name, projectionGeneration: 'g1',
    commit: { streamId: source, commitId: randomUUID(), commitSequence: 0, events: [{
      aggregateType: 'Order', aggregateId: 'order', eventId: randomUUID(), eventIndex: 0,
      streamVersion: 0, type: 'Assigned', timestamp: '2026-11-19T00:00:00.000Z', payload: {}
    }] },
    finalDocuments: [], stagedLinks: [], joinMembershipFences: [membership],
    progress: { strategy: 'own_record', source: { sourceId: source, expectedSequence: null, finalSequence: 0 } }
  };
}

export function injectUnknown(client: MongoClient) {
  let injection: { abort: boolean; after?: () => Promise<void> } | undefined;
  const mongoClient = { startSession(): ClientSession {
    const session = client.startSession();
    const withTransaction: ClientSession['withTransaction'] = async (work, options) => {
      const next = injection;
      if (!next) return session.withTransaction(work, options);
      injection = undefined;
      const forcedAbort = new Error('abort after the real writes');
      try {
        await session.withTransaction(async (s) => {
          const result = await work(s);
          assert.equal((result as { status?: string }).status, 'committed');
          if (next.abort) throw forcedAbort;
          return result;
        }, options);
      } catch (error) {
        if (error !== forcedAbort) throw error;
      }
      await next.after?.();
      throw Object.assign(new Error('injected UnknownTransactionCommitResult'), {
        hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult'
      });
    };
    return new Proxy(session, { get(target, prop) {
      if (prop === 'withTransaction') return withTransaction;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  return { mongoClient, arm: (value: NonNullable<typeof injection>) => { injection = value; } };
}

function prepare(db: Db, client: MongoClient, name: string) {
  const options: MongoProjectionStoreOptions<State> = {
    collection: db.collection(`${name}_views`), linkCollection: db.collection(`${name}_scalar`),
    joinMembershipCollection: db.collection(`${name}_sets`), dedupeCollection: db.collection(`${name}_progress`),
    changeCollection: db.collection(`${name}_changes`), mongoClient: client
  };
  const { mongoClient, arm } = injectUnknown(client);
  const outcomes: string[] = [];
  const suspect = new MongoProjectionStore({ ...options, mongoClient, onSourceCommitReconciliation: ({ outcome }) => outcomes.push(outcome) });
  return { suspect, rival: new MongoProjectionStore(options), arm, outcomes };
}

async function assertAborted(db: Db, client: MongoClient, rivalEffects: 'none' | 'missing' | 'different' | 'identical') {
  const plan = request(`unknown_${rivalEffects}`);
  const { suspect, rival, arm, outcomes } = prepare(db, client, plan.projectionName);
  await suspect.initializeProjectionSourceCommitStore();
  arm({ abort: true, after: async () => {
    if (rivalEffects === 'none') return;
    const fences = rivalEffects === 'missing' ? [] : rivalEffects === 'different'
      ? [{ ...membership, targetDocumentIds: ['B'] }] : [membership];
    const result = await rival.commitProjectionSourceCommit({ ...plan, joinMembershipFences: fences });
    assert.equal(result.status, 'committed');
  } });
  const result = await suspect.commitProjectionSourceCommit(plan);
  assert.deepEqual(result, { version: 1, status: 'rejected', category: 'transient', retryable: true,
    reason: 'ambiguous transaction outcome' }, `${rivalEffects} rival: ${JSON.stringify(result)}`);
  assert.deepEqual(outcomes, ['ambiguous']);
  const rows = await db.collection(`${plan.projectionName}_sets`).find().toArray();
  assert.deepEqual(rows.map((row) => row.targetDocumentIds),
    rivalEffects === 'identical' ? [['A']] : rivalEffects === 'different' ? [['B']] : []);
}

async function assertCommitted(db: Db, client: MongoClient, superseded: boolean, recorded = false) {
  const base = request(`unknown_confirm_${superseded}_${recorded}`);
  const fences = [membership, { ...membership, aggregateId: 'tombstone', targetDocumentIds: [] }];
  const plan: Request = { ...base, joinMembershipFences: fences,
    ...(recorded ? { additionalWrites: [{ kind: 'projection_changes', collection: 'views', targets: [] }] } : {
      finalDocuments: [{ targetDocumentId: 'A', expectedRevision: null, finalDocument: { visits: 1 } }]
    }) };
  const { suspect, rival, arm, outcomes } = prepare(db, client, plan.projectionName);
  await suspect.initializeProjectionSourceCommitStore();
  arm({ abort: false, after: async () => {
    if (!superseded) return;
    const result = await rival.commitProjectionSourceCommit({ ...base, progress: { strategy: 'none' },
      joinMembershipFences: [{ ...membership, expectedRevision: 1, targetDocumentIds: [] }] });
    assert.equal(result.status, 'committed');
  } });
  const result = await suspect.commitProjectionSourceCommit(plan);
  if (superseded && !recorded) {
    assert(result.status === 'rejected' && result.retryable && result.reason === 'ambiguous transaction outcome');
    assert.deepEqual(outcomes, ['ambiguous']);
    return;
  }
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.deepEqual(result.linkRevisions, { [key]: 1, [joinMembershipKey('Order', 'tombstone')]: 1 });
  assert.deepEqual(result.documentRevisions, recorded ? {} : { A: 1 });
  if (recorded) {
    assert.equal(result.emptyChangeReceipt?.kind, 'projection_changes_empty');
    assert.notEqual(result.replayed, true, 'this attempt wrote the durable receipt');
  }
  assert.deepEqual(outcomes, ['committed']);
}

async function assertRecordedRivalReplay(db: Db, client: MongoClient) {
  const plan: Request = { ...request('unknown_recorded_rival'),
    additionalWrites: [{ kind: 'projection_changes', collection: 'views', targets: [] }] };
  const { suspect, rival, arm, outcomes } = prepare(db, client, plan.projectionName);
  await suspect.initializeProjectionSourceCommitStore();
  const rivalMembership = { ...membership, aggregateId: 'rival-order' };
  arm({ abort: true, after: async () => {
    const result = await rival.commitProjectionSourceCommit({ ...plan, joinMembershipFences: [rivalMembership] });
    assert.equal(result.status, 'committed');
  } });
  const result = await suspect.commitProjectionSourceCommit(plan);
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.equal(result.replayed, true, 'only the rival wrote the durable receipt');
  assert.equal(result.emptyChangeReceipt?.kind, 'projection_changes_empty');
  assert.deepEqual(result.linkRevisions, { [joinMembershipKey('Order', 'rival-order')]: 1 });
  assert.deepEqual(outcomes, ['committed']);
}

async function assertPreparedCommit(db: Db, client: MongoClient) {
  const base = request('unknown_prepared');
  const { suspect, arm, outcomes } = prepare(db, client, base.projectionName);
  await suspect.initializeProjectionSourceCommitStore();
  const snapshot = await suspect.loadProjectionSourceCommitSnapshot({
    projectionName: base.projectionName, projectionGeneration: base.projectionGeneration, sourceId: base.commit.streamId,
    targetDocumentIds: ['A'], links: [membership], joinMembership: 'set-v1', progressStrategy: 'own_record', prepareSourceCommit: true
  });
  const capture = captureProjectionSourceEvent({ visits: 0 }, base.commit.events[0],
    (draft) => { draft.visits++; }, true, { snapshot, targetId: 'A' });
  assert(capture.transition);
  const plan = sealProjectionCaptureRequest({ ...base, finalDocuments: [{
    targetDocumentId: 'A', expectedRevision: null, finalDocument: capture.state,
    statePatch: { kind: 'ordered', transitions: [capture.transition] }
  }] });
  const viewFinds: CommandStartedEvent[] = [];
  const monitor = (event: CommandStartedEvent) => {
    if (event.commandName === 'find' && event.command.find === 'unknown_prepared_views') viewFinds.push(event);
  };
  arm({ abort: false });
  client.on('commandStarted', monitor);
  try {
    const result = await suspect.commitProjectionSourceCommit(plan, snapshot);
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual(result.linkRevisions, { [key]: 1 });
    assert.deepEqual(result.documentRevisions, { A: 1 });
    assert.deepEqual(outcomes, ['committed']);
    assert.equal(viewFinds.length, 1, 'prepared write should not reread views until proof');
  } finally {
    client.off('commandStarted', monitor);
  }
}

async function assertMembershipOnly(db: Db, client: MongoClient, strategy: 'own_record' | 'none') {
  const plan = request(`unknown_membership_only_${strategy}`);
  const { suspect, arm, outcomes } = prepare(db, client, plan.projectionName);
  await suspect.initializeProjectionSourceCommitStore();
  arm({ abort: false });
  const result = await suspect.commitProjectionSourceCommit(strategy === 'none' ? { ...plan, progress: { strategy } } : plan);
  if (strategy === 'own_record') {
    assert.equal(result.status, 'committed');
    assert.deepEqual(result.linkRevisions, { [key]: 1 });
    assert.deepEqual(outcomes, ['committed']);
  } else {
    assert(result.status === 'rejected' && result.retryable && result.reason === 'ambiguous transaction outcome');
    assert.deepEqual(outcomes, ['ambiguous']);
  }
  assert.equal(await db.collection(`${plan.projectionName}_sets`).countDocuments(), 1);
}

async function assertSeedWitness(db: Db, client: MongoClient, corrupt: boolean) {
  const base = request(`unknown_seed_witness_${corrupt}`);
  const { suspect, arm, outcomes } = prepare(db, client, base.projectionName);
  const seeds: JoinSeedEdge[] = [{ targetDocumentId: 'A', provenance: {
    aggregateType: 'Order', aggregateId: 'order', documentId: 'order', from: 'snapshot', seedName: 'Order',
    seedGeneration: 'producer-g1', position: { kind: 'throughCommit', streamId: base.commit.streamId, commitSequence: 0 }
  } }];
  const plan: Request = { ...base, joinSeedVersion: 1, joinMembershipFences: [{ ...membership, seeds }],
    finalDocuments: [{ targetDocumentId: 'A', expectedRevision: null, finalDocument: { visits: 1 } }] };
  await suspect.initializeProjectionSourceCommitStore();
  arm({ abort: false, after: async () => {
    if (!corrupt) return;
    await db.collection(`${base.projectionName}_sets`).updateOne({ aggregateId: 'order' },
      { $set: { 'seeds.0.provenance.position.commitSequence': 12 } });
  } });
  const result = await suspect.commitProjectionSourceCommit(plan);
  if (corrupt) assert(result.status === 'rejected' && result.retryable && result.reason === 'ambiguous transaction outcome');
  else {
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual(result.linkRevisions, { [key]: 1 });
    assert.deepEqual(result.documentRevisions, { A: 1 });
  }
  assert.deepEqual(outcomes, [corrupt ? 'ambiguous' : 'committed']);
}

export async function checkRealJoinUnknownCommit(db: Db, client: MongoClient): Promise<void> {
  for (const rival of ['missing', 'different', 'identical', 'none'] as const) await assertAborted(db, client, rival);
  await assertCommitted(db, client, false);
  await assertCommitted(db, client, true);
  await assertCommitted(db, client, true, true);
  await assertRecordedRivalReplay(db, client);
  await assertPreparedCommit(db, client);
  await assertMembershipOnly(db, client, 'own_record');
  await assertMembershipOnly(db, client, 'none');
  for (const corrupt of [false, true]) await assertSeedWitness(db, client, corrupt);
  const plan = request('unknown_corrupt_proof');
  const { suspect, arm, outcomes } = prepare(db, client, plan.projectionName);
  await suspect.initializeProjectionSourceCommitStore();
  arm({ abort: false, after: async () => {
    await db.collection('unknown_corrupt_proof_sets').updateOne({}, { $set: { targetDocumentIds: ['B', 'A'] } });
  } });
  assert.deepEqual(await suspect.commitProjectionSourceCommit(plan), {
    version: 1, status: 'rejected', category: 'transient', retryable: true, reason: 'ambiguous transaction outcome'
  });
  assert.deepEqual(outcomes, ['ambiguous']);
}
