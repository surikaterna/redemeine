import { createAggregate } from '@redemeine/aggregate';
import { createSagaCommandsFor } from '@redemeine/saga';
import { serializeSagaCorrelation } from '../src/identity/canonicalCorrelation';
import { deriveSagaInstanceId, deriveSourceTriggerId, deriveTurnCommitId } from '../src/identity/deterministicIds';
import { normalizePluginIntent, type WireOrigin, type WireRegistryEntry } from '../src/intentWire';
import {
  assertLifecycleReplayOrder,
  createLifecycleTurnCommit,
  decodeLifecycleProgressEvent,
  decodeLifecycleTurnCommit,
  equivalentLifecycleCommit,
  LifecycleCommitShapeError
} from '../src/turns/lifecycleCommit';
import { assertLifecycleVersion, decodeLifecycleProgress, decodeLifecycleTurn, equivalentLifecycleTurn } from '../src/turns/lifecycleWire';

const registry: readonly WireRegistryEntry[] = [
  { plugin_key: 'mail', actions: [{ name: 'ask', interaction: 'request_response' }], commandTypes: ['invoice.pay.command', 'billing.charge.command'] }
];
const correlation = { type: 'string', value: 'order-1' } as const;
const instanceId = deriveSagaInstanceId('orders', correlation);
const source = { partitionId: 'source', streamId: 'stream', commitId: 'commit', eventIndex: 0 };
const sourceTriggerId = deriveSourceTriggerId(source);
const routeId = 'route-1';
const meta = { sagaId: instanceId, correlationId: serializeSagaCorrelation(correlation), causationId: sourceTriggerId };
const origin = (ordinal: number): WireOrigin => ({ sagaKey: 'orders', correlation, sourceId: sourceTriggerId, routeId, ordinal });
const command = (aggregate: 'invoice' | 'billing', ordinal: number) => {
  const builder = createAggregate<{ id: string }, 'invoice' | 'billing'>(aggregate, { id: 'a1' }).commands(() => ({
    pay: (_state, id: string) => ({ type: 'unused', payload: { id } })
  }));
  const built = aggregate === 'billing' ? builder.overrideCommandNames({ pay: 'billing.charge.command' }).build() : builder.build();
  return normalizePluginIntent(createSagaCommandsFor(built, 'a1', meta).pay('a1'), origin(ordinal), registry);
};
const invoice = command('invoice', 0);
const billing = command('billing', 1);
const request = normalizePluginIntent(
  {
    type: 'plugin-intent',
    plugin_key: 'mail',
    action_name: 'ask',
    interaction: 'request_response',
    execution_payload: { id: 1 },
    routing_metadata: { response_handler_key: 'ok', error_handler_key: 'error', handler_data: { secret: 3 } },
    metadata: meta
  },
  origin(2),
  registry
);
const schedule = normalizePluginIntent(
  {
    type: 'plugin-intent',
    plugin_key: 'core',
    action_name: 'schedule',
    interaction: 'fire_and_forget',
    execution_payload: { id: 't1', delay: 1000 },
    metadata: meta
  },
  origin(3),
  registry,
  '2026-09-25T00:00:00.000Z'
);
const turn = {
  schemaVersion: 1,
  kind: 'saga.lifecycle.turn',
  instanceId,
  sagaKey: 'orders',
  definitionVersion: 1,
  correlation,
  source,
  sourceTriggerId,
  routeId,
  commitId: deriveTurnCommitId({ sourceTriggerId, sagaKey: 'orders', instanceId, routeId }),
  state: { count: 1 },
  intents: [invoice, billing, request, schedule],
  timers: [{ intentId: schedule.intentId, action: 'schedule', timerId: 't1', dueAt: '2026-09-25T00:00:01.000Z' }],
  terminal: 'completed'
};

describe('additive private lifecycle contract (not PR111 replay)', () => {
  it('roundtrips a single consumed/state/full-intent/timer/terminal record and compares content', () => {
    const parsed = decodeLifecycleTurn(JSON.parse(JSON.stringify(turn)), registry);
    expect(parsed).toEqual(turn);
    expect(parsed.intents.slice(0, 2).map((intent) => (intent.kind === 'dispatch' ? intent.command : null))).toEqual([
      'invoice.pay.command',
      'billing.charge.command'
    ]);
    expect(equivalentLifecycleTurn(turn, JSON.parse(JSON.stringify(turn)), registry)).toBe(true);
    expect(equivalentLifecycleTurn(turn, { ...turn, state: { count: 2 } }, registry)).toBe(false);
    expect(equivalentLifecycleTurn(turn, { ...turn, state: { count: 1 }, correlation: { value: 'order-1', type: 'string' } }, registry)).toBe(true);
    const commit = createLifecycleTurnCommit(parsed, 0, registry);
    expect(decodeLifecycleTurnCommit(JSON.parse(JSON.stringify(commit)), registry)).toEqual(commit);
    expect(equivalentLifecycleCommit(commit, { ...commit, expectedNextCommitSequence: 1 }, registry)).toBe(true);
    expect(equivalentLifecycleCommit(commit, { ...commit, events: [{ ...commit.events[0], payload: { ...turn, state: { count: 2 } } }] }, registry)).toBe(
      false
    );
    expect(() => decodeLifecycleTurnCommit({ ...commit, events: [{ type: 'saga.businessStateRecorded.event', payload: turn }] }, registry)).toThrow();
    expect(() => decodeLifecycleTurnCommit({ ...commit, events: [...commit.events, ...commit.events] }, registry)).toThrow();
    expect(deriveSagaInstanceId('orders', correlation)).toBe(instanceId);
    expect(() => assertLifecycleVersion(parsed, 2)).toThrow('definition_version_migration_unsupported');
    expect(() => assertLifecycleVersion(parsed, 1)).not.toThrow();
    expect(() => assertLifecycleReplayOrder(parsed, { ...parsed, commitId: 'other' })).toThrow();
    expect(() => assertLifecycleReplayOrder({ ...parsed, terminal: undefined }, { ...parsed, commitId: 'other', definitionVersion: 2 })).toThrow();
    expect(() => assertLifecycleReplayOrder({ ...parsed, terminal: undefined }, { ...parsed, commitId: 'other' })).not.toThrow();
  });

  it('refuses malformed, legacy, unsupported and incorrectly ordered unknown records', () => {
    for (const invalid of [
      { ...turn, schemaVersion: 2 },
      { ...turn, instanceId: 'wrong' },
      { ...turn, commitId: 'wrong' },
      { ...turn, source: { ...source, eventIndex: 1 } },
      { ...turn, definitionVersion: 2, state: { count: 1 }, extra: true },
      { ...turn, intents: [billing, invoice, request, schedule] },
      { ...turn, intents: [invoice, invoice, request, schedule] },
      { ...turn, intents: [invoice, { ...billing, command: 'pay' }, request, schedule] },
      { ...turn, intents: [invoice, billing, request] },
      { ...turn, timers: [{ ...turn.timers[0], dueAt: '2026-09-25T00:00:02.000Z' }] },
      { ...turn, state: { bad: undefined } },
      { ...turn, state: 'x'.repeat(8 * 1024 * 1024) }
    ])
      expect(() => decodeLifecycleTurn(invalid, registry)).toThrow();
  });

  it('classifies malformed commit and event envelopes before accessing event fields', () => {
    const commit = createLifecycleTurnCommit(decodeLifecycleTurn(turn, registry), 0, registry);
    for (const malformed of [
      null,
      0,
      'commit',
      [],
      {},
      { ...commit, events: undefined },
      { ...commit, events: [] },
      { ...commit, events: [null] },
      { ...commit, events: [0] },
      { ...commit, events: ['event'] },
      { ...commit, events: [[]] },
      { ...commit, events: [{}] },
      { ...commit, events: [{ type: 'saga.lifecycle.turn.v1.event' }] },
      { ...commit, events: [{ payload: turn }] },
      { ...commit, events: [{ type: 'saga.lifecycle.turn.v1.event', payload: null }] },
      { ...commit, events: [{ type: 'saga.lifecycle.turn.v1.event', payload: [] }] },
      { ...commit, streamId: undefined }
    ]) {
      try {
        decodeLifecycleTurnCommit(malformed, registry);
        throw new Error('malformed commit was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(LifecycleCommitShapeError);
        expect(error).toMatchObject({ code: 'invalid_lifecycle_commit_shape' });
      }
    }
  });

  it('validates separate claim/outcome/continuation by originating intent, retaining token and handler_data', () => {
    const outcome = {
      schemaVersion: 1,
      intentId: request.intentId,
      instanceId,
      correlationId: meta.correlationId,
      result: 'error',
      token: 'error',
      handler_data: { secret: 3 },
      value: { reason: 'retry' }
    };
    const claim = {
      schemaVersion: 1,
      kind: 'saga.lifecycle.claim',
      intentId: request.intentId,
      instanceId,
      epoch: 1,
      owner: 'worker',
      expiresAt: '2026-09-25T00:00:01.000Z'
    };
    const record = { schemaVersion: 1, kind: 'saga.lifecycle.outcome', intentId: request.intentId, instanceId, outcome };
    const continuation = { ...record, kind: 'saga.lifecycle.continuation', status: 'failed' };
    expect(decodeLifecycleProgress(JSON.parse(JSON.stringify(claim)), request)).toEqual(claim);
    expect(decodeLifecycleProgress(JSON.parse(JSON.stringify(record)), request)).toEqual(record);
    expect(decodeLifecycleProgressEvent({ type: 'saga.lifecycle.progress.v1.event', payload: record }, request)).toEqual(record);
    expect(() => decodeLifecycleProgressEvent({ type: 'saga.intentLifecycleRecorded.event', payload: record }, request)).toThrow();
    expect(decodeLifecycleProgress(JSON.parse(JSON.stringify(continuation)), request)).toEqual(continuation);
    for (const invalid of [
      { ...claim, schemaVersion: 2 },
      { ...claim, epoch: 0 },
      { ...record, intentId: invoice.intentId },
      { ...record, outcome: { ...outcome, token: 'ok' } },
      { ...record, outcome: { ...outcome, handler_data: null } },
      { ...continuation, status: 'unknown' }
    ])
      expect(() => decodeLifecycleProgress(invalid, request)).toThrow();
  });
});
