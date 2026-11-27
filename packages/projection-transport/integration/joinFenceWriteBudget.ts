import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  JOIN_MEMBERSHIP_FENCE_CAPACITY, MAX_JOIN_TARGETS, MAX_JOIN_TURN_BYTES,
  type CommitProjectionSourceCommitRequest, type ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';
import type { CommandStartedEvent } from 'mongodb';
import { orderId, type State, turn } from './joinMembershipFixture';

type Store = ProjectionSourceCommitStorePort<State>;
const scope = { projectionName: 'boards', projectionGeneration: 'set-generation' };
export const seedIds = Array.from({ length: MAX_JOIN_TARGETS }, (_, index) => `member-${String(index).padStart(4, '0')}`);
const largeId = 'é'.repeat(MAX_JOIN_TURN_BYTES / 32);

export function fenceRequest(rows: readonly (readonly string[])[], key = 'bounded'): CommitProjectionSourceCommitRequest<State> {
  const commit = turn(randomUUID(), 0, orderId, [['ordinary']]);
  return { version: 1, mode: 'atomic-all', ...scope, commit, finalDocuments: [], stagedLinks: [],
    progress: { strategy: 'own_record', source: { sourceId: commit.streamId, expectedSequence: null, finalSequence: 0 } },
    additionalWrites: [{ kind: 'projection_changes', collection: 'join-changes', targets: [] }],
    joinMembershipFences: rows.map((targetDocumentIds, index) => ({ aggregateType: 'Order', aggregateId: `${key}-${index}`,
      expectedRevision: null, targetDocumentIds })) };
}

function load(store: Store, request: CommitProjectionSourceCommitRequest<State>, prepareSourceCommit: boolean) {
  const { commit: { streamId, commitId, commitSequence }, joinMembershipFences = [] } = request;
  return store.loadProjectionSourceCommitSnapshot({ ...scope, targetDocumentIds: [], joinMembership: 'set-v1',
    links: joinMembershipFences.map(({ aggregateType, aggregateId }) => ({ aggregateType, aggregateId })),
    progressStrategy: 'own_record', sourceId: streamId, prepareSourceCommit,
    changeIdentity: { sourceId: streamId, commitId, commitSequence, collection: 'join-changes' } });
}

export async function runFenceWriteBudget(store: Store, prepared: boolean, commands?: CommandStartedEvent[]) {
  for (const bytes of [false, true]) {
    const rows = Array.from({ length: 16 }, () => bytes ? [largeId] : seedIds);
    const over = fenceRequest([...rows, ['x']], `over-${bytes}`);
    const before = await load(store, over, prepared);
    if (commands) commands.length = 0;
    const rejection = await store.commitProjectionSourceCommit(over, prepared ? before : undefined);
    assert(rejection.status === 'rejected' && rejection.category === 'terminal');
    assert.equal(rejection.reason, JOIN_MEMBERSHIP_FENCE_CAPACITY);
    assert.equal(commands?.length ?? 0, 0, 'Store must reject before opening a transaction or writing.');
    const after = await load(store, over, false);
    assert.equal(after.ownRecordSequence, null);
    assert.equal(after.changeReceipt, 'missing');
    assert(after.joinMemberships?.every(({ revision, targetDocumentIds }) => revision === null && targetDocumentIds.length === 0));

    const exact = fenceRequest(rows, `exact-${bytes}`);
    const snapshot = await load(store, exact, prepared);
    if (commands) commands.length = 0;
    const result = await store.commitProjectionSourceCommit(exact, prepared ? snapshot : undefined);
    assert.equal(result.status, 'committed', JSON.stringify(result));
    const membershipWrites = commands?.filter(({ command }) => command.insert === 'memberships' || command.update === 'memberships').length;
    if (commands) assert.equal(membershipWrites, 1);
    const persisted = await load(store, exact, false);
    assert.equal(persisted.ownRecordSequence, 0);
    assert.equal(persisted.changeReceipt, 'committed');
    assert.deepEqual(persisted.joinMemberships?.map(({ targetDocumentIds }) => targetDocumentIds), rows);
    const clear = fenceRequest([[]], `exact-${bytes}`);
    const [first] = clear.joinMembershipFences!;
    const cleared = await store.commitProjectionSourceCommit({ ...clear, joinMembershipFences: [{ ...first!, expectedRevision: 1 }] });
    assert.equal(cleared.status, 'committed');
    assert.deepEqual((await load(store, exact, false)).joinMemberships?.map(({ targetDocumentIds }) => targetDocumentIds),
      [[], ...rows.slice(1)]);
    console.log(JSON.stringify({ scenario: 'fence-write-capacity', prepared, bytes, boundary: bytes ? MAX_JOIN_TURN_BYTES : 16 * MAX_JOIN_TARGETS,
      membershipWrites, rejectedCommands: 0 }));
  }
}
