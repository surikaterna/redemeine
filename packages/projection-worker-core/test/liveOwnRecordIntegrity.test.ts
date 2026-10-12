import { expect, jest, test } from '@jest/globals';
import { assertLiveSnapshot } from '../src/liveExecutionGuard';
import { executeProjectionDefinition } from '../src/projectionDefinitionExecutor';
import { createProjectionLaneScheduler } from '../src/targetLaneScheduler';
import { liveCommit, liveDefinition, LiveCounterStore } from './liveFixtures';

test.each([null, 0, 42, Number.MAX_SAFE_INTEGER])('live own_record accepts valid snapshot progress %p', (sequence) => {
  expect(() => assertLiveSnapshot({ coveredDuplicate: false, assertCurrent: () => {} }, liveDefinition('counter', 'own_record'),
    liveCommit(42), { targets: [], links: [], ownRecordSequence: sequence })).not.toThrow();
});

test.each([1, 2, 3])('undefined snapshot progress is refused at load %i (initial, attempt, conflict retry)', async (invalidLoad) => {
  const store = new LiveCounterStore();
  const load = store.loadProjectionSourceCommitSnapshot.bind(store);
  let loads = 0;
  jest.spyOn(store, 'loadProjectionSourceCommitSnapshot').mockImplementation(async (request) => {
    const snapshot = await load(request);
    loads += 1;
    if (loads === invalidLoad) Reflect.set(snapshot, 'ownRecordSequence', undefined);
    return snapshot;
  });
  // Exercise the executor retry branch with a typed conflict result rather than a successful write.
  const port = { loadProjectionSourceCommitSnapshot: store.loadProjectionSourceCommitSnapshot.bind(store),
    commitProjectionSourceCommit: jest.fn(async () => ({ version: 1 as const, status: 'rejected' as const,
      category: 'conflict' as const, retryable: true as const, reason: 'injected conflict' })) };
  const result = await executeProjectionDefinition({ definition: liveDefinition('counter', 'own_record'), generation: 'generation',
    store: port, lanes: createProjectionLaneScheduler(), maxConflictRetries: 1,
    liveProfile: { coveredDuplicate: false, assertCurrent: () => {} } }, liveCommit(42));
  expect(result).toMatchObject({ reason: 'marker_lifetime_violation' });
  expect(loads).toBe(invalidLoad);
  expect(port.commitProjectionSourceCommit).toHaveBeenCalledTimes(invalidLoad === 3 ? 1 : 0);
  expect(store.writes).toEqual([]);
});
