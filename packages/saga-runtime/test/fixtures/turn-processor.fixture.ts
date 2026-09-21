import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createSaga } from '@redemeine/saga';
import {
  compileSagaRoutes,
  createStartEventBindings,
  type SagaTurnAppendRequest,
  type SagaTurnAppendResult,
  type SagaTurnRepository,
  type SagaTurnSourceEvent,
  type SagaTurnStoredCommit
} from '../../src/index';

export interface TurnState {
  count: number;
  bad?: unknown;
}

export interface DefinitionCounters {
  initial: number;
  start: number;
  handler: number;
}

interface OrderPayload {
  orderId: string;
  amount?: number;
  mode?: 'intent' | 'throw' | 'invalid';
}

export const orders = createAggregate('turn-orders', { seen: 0 })
  .events({
    placed: (state, _event: Event<OrderPayload>) => {
      state.seen += 1;
    },
    paid: (state, _event: Event<OrderPayload>) => {
      state.seen += 1;
    }
  })
  .overrideEventNames({ placed: 'turn.order-placed.v1.event', paid: 'turn.order-paid.v1.event' })
  .build();

export function createCounters(): DefinitionCounters {
  return { initial: 0, start: 0, handler: 0 };
}

export function createTurnDefinition(name: string, counters: DefinitionCounters, onCorrelation?: (event: unknown) => unknown) {
  return createSaga<TurnState>({ identity: { namespace: 'turns', name, version: 1 } })
    .initialState(() => {
      counters.initial += 1;
      return { count: 0 };
    })
    .start((state, input: { orderId: string }) => {
      counters.start += 1;
      state.count = input.orderId.length;
    })
    .correlateBy((input) => input.orderId)
    .triggeredBy({
      kind: 'domain',
      toStartInput: (event: { payload: OrderPayload }) => ({ orderId: event.payload.orderId })
    })
    .correlate(orders, onCorrelation ?? ((event) => readOrderId(event)))
    .on(orders, {
      placed: async (state, event, ctx) => runHandler(state, event.payload, ctx, counters),
      paid: async (state, event, ctx) => runHandler(state, event.payload, ctx, counters)
    })
    .build();
}

function readOrderId(event: unknown): string {
  if (typeof event !== 'object' || event === null || !('payload' in event)) throw new Error('missing payload');
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null || !('orderId' in payload) || typeof payload.orderId !== 'string') {
    throw new Error('missing orderId');
  }
  return payload.orderId;
}

async function runHandler(
  state: { count: number; bad?: unknown },
  payload: OrderPayload,
  ctx: { schedule(id: string, delay: number): unknown },
  counters: DefinitionCounters
): Promise<void> {
  counters.handler += 1;
  if (payload.mode === 'throw') throw new Error('handler exploded');
  if (payload.mode === 'intent') ctx.schedule('later', 1);
  state.count += payload.amount ?? 1;
  if (payload.mode === 'invalid') state.bad = () => 'not-json';
}

export function createTurnTable(name: string, counters: DefinitionCounters) {
  const definition = createTurnDefinition(name, counters);
  return compileSagaRoutes(
    [definition],
    createStartEventBindings({ definition, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] })
  );
}

export function createStartOnlyTable(name: string, counters: DefinitionCounters) {
  const definition = createSaga<TurnState>({ identity: { namespace: 'turns', name, version: 1 } })
    .initialState(() => {
      counters.initial += 1;
      return { count: 0 };
    })
    .start(() => {
      counters.start += 1;
    })
    .correlateBy((input: { orderId: string }) => input.orderId)
    .triggeredBy({ kind: 'domain', toStartInput: (event: { payload: OrderPayload }) => ({ orderId: event.payload.orderId }) })
    .build();
  return compileSagaRoutes(
    [definition],
    createStartEventBindings({ definition, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] })
  );
}

export function sourceEvent(overrides: Partial<SagaTurnSourceEvent> = {}): SagaTurnSourceEvent {
  return {
    type: 'turn.order-placed.v1.event',
    payload: { orderId: 'order-1' },
    partitionId: 'partition-1',
    streamId: 'orders-order-1',
    commitId: 'source-commit-1',
    eventIndex: 0,
    eventId: 'source-event-1',
    createDateTime: '2026-09-21T10:00:00.000Z',
    aggregateType: 'turn-orders',
    aggregateId: 'order-1',
    sequence: 4,
    correlationId: 'correlation-1',
    causationId: 'causation-1',
    metadata: { tenant: 'tenant-1' },
    ...overrides
  };
}

export class FakeTurnRepository implements SagaTurnRepository {
  readonly appendCalls: SagaTurnAppendRequest[] = [];
  readonly findCalls: Array<{ streamId: string; commitId: string }> = [];
  readonly loadCalls: string[] = [];
  forcedCommit: SagaTurnStoredCommit | null | undefined;
  beforeAppend?: (request: SagaTurnAppendRequest, repository: FakeTurnRepository) => SagaTurnAppendResult | null;
  private readonly eventsByStream = new Map<string, Event[]>();
  private readonly nextSequenceByStream = new Map<string, number>();
  private readonly commits = new Map<string, SagaTurnStoredCommit>();

  async load(instanceId: string) {
    this.loadCalls.push(instanceId);
    return {
      streamId: instanceId,
      nextCommitSequence: this.nextSequenceByStream.get(instanceId) ?? 0,
      events: [...(this.eventsByStream.get(instanceId) ?? [])]
    };
  }

  async findCommit(streamId: string, commitId: string): Promise<SagaTurnStoredCommit | null> {
    this.findCalls.push({ streamId, commitId });
    if (this.forcedCommit !== undefined) return this.forcedCommit;
    return this.commits.get(this.commitKey(streamId, commitId)) ?? null;
  }

  async append(request: SagaTurnAppendRequest): Promise<SagaTurnAppendResult> {
    this.appendCalls.push(request);
    const existing = this.commits.get(this.commitKey(request.streamId, request.commitId));
    if (existing) return { status: 'reconciled', commit: existing };
    const override = this.beforeAppend?.(request, this);
    if (override) return override;
    const next = this.nextSequenceByStream.get(request.streamId) ?? 0;
    if (request.expectedNextCommitSequence !== next) return { status: 'conflict' };
    return this.commit(request);
  }

  commit(request: SagaTurnAppendRequest): SagaTurnAppendResult {
    const sequence = this.nextSequenceByStream.get(request.streamId) ?? 0;
    const commit = { streamId: request.streamId, commitId: request.commitId, commitSequence: sequence, identity: request.identity };
    this.eventsByStream.set(request.streamId, [...(this.eventsByStream.get(request.streamId) ?? []), ...request.events]);
    this.nextSequenceByStream.set(request.streamId, sequence + 1);
    this.commits.set(this.commitKey(request.streamId, request.commitId), commit);
    return { status: 'committed', commitSequence: sequence };
  }

  replaceBusinessState(request: SagaTurnAppendRequest, count: number): void {
    const events = request.events.map((event) => {
      if (event.type !== 'saga.business_state_recorded.event' || typeof event.payload !== 'object' || event.payload === null) return event;
      return { ...event, payload: { ...event.payload, sourceTriggerId: 'winner-trigger', state: { count } } };
    });
    this.commit({ ...request, commitId: `${request.commitId}-winner`, identity: { ...request.identity, sourceTriggerId: 'winner-trigger' }, events });
  }

  removeBusinessState(streamId: string): void {
    const events = this.eventsByStream.get(streamId) ?? [];
    this.eventsByStream.set(streamId, events.filter((event) => event.type !== 'saga.business_state_recorded.event'));
  }

  replaceEvents(streamId: string, events: readonly Event[]): void {
    this.eventsByStream.set(streamId, [...events]);
  }

  private commitKey(streamId: string, commitId: string): string {
    return `${streamId}\u0000${commitId}`;
  }
}
