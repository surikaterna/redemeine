import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProjection, MAX_JOIN_TURN_BYTES, MAX_JOIN_TURN_KEYS,
  type ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { coordinator, fixtureCoverage, fixtureOptions, orderId, snapshot, type State, turn } from './joinMembershipFixture';

const board = { aggregateType: 'Board', pure: { eventProjectors: {} } };
const order = { aggregateType: 'Order', pure: { eventProjectors: {
  chosen: (_state: unknown, _event: { payload: { repeat: number; large?: boolean; extraByte?: boolean } }) => {}
} } };
const large = 'é'.repeat(512);
const definition = createProjection('boards', (id): State => ({ id, visits: [] }))
  .from(board, {})
  .join(order, { chosen(draft) { draft.visits.push('chosen'); } })
  .joinRight(order, { chosen: ({ payload }) => {
    const raw = Array<string>(payload.repeat).fill(payload.large ? large : 'short');
    if (payload.extraByte) raw.push('x');
    return raw;
  } }).deduplication({ strategy: 'own_record' }).build();

export async function runJoinSelectorRawBudget(raw: ProjectionSourceCommitStorePort<State>) {
  let writes = 0;
  let viewLoads = 0;
  const options = fixtureOptions({
    joinMembershipCapability: raw.joinMembershipCapability, projectionChangesCapability: raw.projectionChangesCapability,
    sourceCommitSnapshotCapability: raw.sourceCommitSnapshotCapability,
    async loadProjectionSourceCommitSnapshot(request) {
      if (request.targetDocumentIds.length) ++viewLoads;
      return raw.loadProjectionSourceCommitSnapshot(request);
    },
    async commitProjectionSourceCommit(request, observed) {
      ++writes;
      return raw.commitProjectionSourceCommit(request, observed);
    }
  });
  const runtime = coordinator({ ...options, definitions: [{ ...options.definitions[0]!, definition }] });
  for (const over of [true, false]) {
    for (const byteBound of [false, true]) {
      const repeat = (byteBound ? MAX_JOIN_TURN_BYTES / 1024 : MAX_JOIN_TURN_KEYS) / 2;
      const input = turn(randomUUID(), 0, orderId, [['chosen', { repeat, large: byteBound }],
        ['chosen', { repeat, large: byteBound, extraByte: over }]]);
      writes = 0;
      viewLoads = 0;
      const result = await runtime.process(input);
      assert.equal(result.status, over ? 'terminal' : 'completed', JSON.stringify(result));
      if (result.status === 'terminal') assert.match(result.reason, /routing exceeds capacity/);
      assert.equal(writes, over ? 0 : 1);
      assert.equal(viewLoads, over ? 0 : 1);
      assert.equal(await fixtureCoverage(options, input), over ? null : 0);
      const row = await snapshot(raw, input.streamId, [byteBound ? large : 'short', 'x']);
      assert.equal(row.ownRecordSequence, over ? null : 0);
      assert.equal(row.targets[1]?.state, null);
      if (!over) assert.deepEqual(row.targets[0]?.state?.visits, ['chosen', 'chosen']);
      console.log(JSON.stringify({ scenario: 'raw-selector-budget', byteBound, over, repeat, writes, viewLoads }));
    }
  }
}
