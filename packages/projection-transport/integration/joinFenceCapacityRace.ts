import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProjection, JOIN_MEMBERSHIP_FENCE_CAPACITY, type ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import type { CommandStartedEvent } from 'mongodb';
import { fenceRequest, seedIds } from './joinFenceWriteBudget';
import { coordinator, fixtureCoverage, fixtureOptions, snapshot, type State, turn } from './joinMembershipFixture';
import { completed } from './joinMembershipScenarios';

type Store = ProjectionSourceCommitStorePort<State>;
type Scenario = 'fresh' | 'cancel' | 'winner-after-missing' | 'none';
const order = { aggregateType: 'Order', pure: { eventProjectors: { ordinary() {} } } };
const board = { aggregateType: 'Board', pure: { eventProjectors: { attach(_state: unknown, _e: { payload: { cancel: boolean } }) {} } } };
const key = 'shared';
const initial = Array.from({ length: 16 }, () => seedIds);
const links = Array.from({ length: 17 }, (_, index) => ({ aggregateType: 'Order', aggregateId: `${key}-${index}` }));

function optionsFor(store: Store, none: boolean) {
  const strategy = none ? { strategy: 'none', reason: 'fence-capacity fixture', duplicateEffects: 'acknowledged' } as const
    : { strategy: 'own_record' } as const;
  const definition = createProjection('boards', (id): State => ({ id, visits: [] })).from(board, {
    attach(draft, event, ctx) {
      for (const source of links.slice(0, -1)) ctx.unsubscribeFrom(order, source.aggregateId);
      ctx.subscribeTo(order, links.at(-1)!.aggregateId);
      if (event.payload.cancel) ctx.unsubscribeFrom(order, links.at(-1)!.aggregateId);
      draft.visits.push('attached');
    }
  }).join(order, { ordinary() {} }).joinRight(order, {}).deduplication(strategy).build();
  const options = fixtureOptions(store, [], strategy);
  return { ...options, definitions: [{ ...options.definitions[0]!, definition }] };
}

function observe(store: Store, prepared: boolean, intervene: () => Promise<void>, commands?: CommandStartedEvent[]) {
  const counts = { attempts: 0, rejected: 0, receiptReads: 0 };
  const port: Store = {
    joinMembershipCapability: store.joinMembershipCapability, projectionChangesCapability: store.projectionChangesCapability,
    ...(prepared ? { sourceCommitSnapshotCapability: store.sourceCommitSnapshotCapability } : {}),
    async loadProjectionSourceCommitSnapshot(request) {
      const result = await store.loadProjectionSourceCommitSnapshot(request);
      if (request.changeIdentity && !request.joinMembership && ++counts.receiptReads === 1) {
        assert.equal(result.changeReceipt, 'missing');
        await intervene();
      }
      return result;
    },
    async commitProjectionSourceCommit(request, observed) {
      counts.attempts += 1;
      const before = commands?.length;
      const result = await store.commitProjectionSourceCommit(request, observed);
      if (result.status === 'rejected' && result.reason === JOIN_MEMBERSHIP_FENCE_CAPACITY) {
        ++counts.rejected;
        assert.equal(commands?.length, before, 'Reject before Mongo read/writes or transactions.');
      }
      return result;
    }
  };
  return { port, counts };
}

export async function runFenceCapacityRace(store: Store, prepared: boolean, scenario: Scenario, commands?: CommandStartedEvent[]) {
  assert.equal((await store.commitProjectionSourceCommit(fenceRequest(initial, key))).status, 'committed');
  const input = turn(randomUUID(), 0, 'new', [['attach', { cancel: scenario === 'cancel' }]], 'Board');
  const won = scenario === 'winner-after-missing';
  const { port, counts } = observe(store, prepared, async () => {
    if (!won) return;
    const remove = fenceRequest([seedIds.slice(1)], key);
    assert.equal((await store.commitProjectionSourceCommit({ ...remove, joinMembershipFences: [
      { ...remove.joinMembershipFences![0]!, expectedRevision: 1 }
    ] })).status, 'committed');
    await completed(coordinator(optionsFor(store, false)), input);
  }, commands);
  const options = optionsFor(port, scenario === 'none');
  const outcome = await coordinator(options).process(input);
  const applied = won || scenario === 'cancel';
  assert.equal(outcome.status, applied ? 'completed' : 'terminal', JSON.stringify(outcome));
  assert.equal(outcome.definitions[0]?.outcome.status, won ? 'deduplicated' : applied ? 'committed' : 'terminal');
  assert.deepEqual(counts, { attempts: scenario === 'fresh' ? 2 : 1, rejected: scenario === 'cancel' ? 0 : scenario === 'fresh' ? 2 : 1,
    receiptReads: scenario === 'fresh' ? 2 : won ? 1 : 0 });
  assert.equal(await fixtureCoverage(options, input), applied ? 0 : null);
  const state = await snapshot(store, input.streamId, ['new'], links);
  assert.equal(state.ownRecordSequence, applied ? 0 : null);
  assert.deepEqual(state.targets[0]?.state?.visits, applied ? ['attached'] : undefined);
  assert.deepEqual(state.joinMemberships?.map((row) => row.targetDocumentIds),
    [won ? seedIds.slice(1) : seedIds, ...initial.slice(1), won ? ['new'] : []]);
  console.log(JSON.stringify({ scenario: `fence-capacity-${scenario}`, prepared, ...counts }));
}
