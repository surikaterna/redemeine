import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { deriveSourceTriggerId, deriveTurnCommitId } from '../../src/identity/deterministicIds';
import { createSaga } from '@redemeine/saga';
import {
  compileRegisteredSagaRoutes,
  bindSagaRegistrations,
  registerSagaDefinition,
  registerSagaTurnDefinition,
  assertEquivalentSagaCommit,
  SagaTurnIntegrityError,
  type CompiledSagaRoutingTable,
  type SagaRegistration,
  type SagaTurnAggregateEvent,
  type SagaTurnProcessorOptions,
  type SagaTurnAppendRequest,
  type SagaTurnAppendResult,
  type SagaTurnRepository,
  type SagaTurnSourceEvent,
  type SagaTurnStoredCommit
} from '../../src/index';

export interface TurnState {
  count: number;
  bad?: unknown;
  lastEventId?: string;
}

export interface DefinitionCounters {
  initial: number;
  start: number;
  handler: number;
  whenEvent?: unknown;
  startEvent?: unknown;
  onCorrelationEvent?: unknown;
  handlerEvent?: unknown;
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

const registrations = new WeakMap<object, SagaRegistration<TurnState>>();

export function parseTurnInput(value: unknown): { orderId: string } {
  if (typeof value !== 'object' || value === null || !('orderId' in value) || typeof value.orderId !== 'string') {
    throw new TypeError('Invalid turn start input');
  }
  return { orderId: value.orderId };
}

export function parseTurnState(value: unknown): TurnState {
  if (typeof value !== 'object' || value === null || !('count' in value) || typeof value.count !== 'number' ||
      ('lastEventId' in value && typeof value.lastEventId !== 'string')) throw new TypeError('Invalid turn state');
  return { ...value, count: value.count };
}

function isTurnEvent(value: unknown): value is SagaTurnAggregateEvent {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' &&
    'type' in value && typeof value.type === 'string' && 'payload' in value &&
    (!('aggregateType' in value) || typeof value.aggregateType === 'string') &&
    (!('aggregateId' in value) || typeof value.aggregateId === 'string') &&
    (!('sequence' in value) || typeof value.sequence === 'number') &&
    (!('metadata' in value) || (typeof value.metadata === 'object' && value.metadata !== null && !Array.isArray(value.metadata)));
}

export function parseTurnEvent(value: unknown): SagaTurnAggregateEvent {
  if (!isTurnEvent(value)) throw new TypeError('Invalid turn event');
  return value;
}

export function registeredTurnDefinition(definition: object): SagaRegistration<TurnState> {
  const registration = registrations.get(definition);
  if (!registration) throw new TypeError('Missing test executable registration');
  return registration;
}

export function registrationOptions(table: CompiledSagaRoutingTable, maxConflictRetries?: number): SagaTurnProcessorOptions {
  const active = table.registered ?? table.legacyDefinitions?.map((definition) => registerSagaTurnDefinition({
    definition, pluginManifests: [], responseHandlerBindings: {}, canonicalCommandTypes: []
  }));
  if (!active) throw new TypeError('Test requires executable or legacy registrations');
  return { registrationForRoute: bindSagaRegistrations(table, active), ...(maxConflictRetries === undefined ? {} : { maxConflictRetries }) };
}

export function createTurnDefinition(
  name: string,
  counters: DefinitionCounters,
  onCorrelation?: (event: unknown) => unknown,
  version = 1
) {
  const definition = createSaga<TurnState>({ identity: { namespace: 'turns', name, version } })
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
      when: (event) => {
        counters.whenEvent = event;
        return true;
      },
      toStartInput: (event: { payload: OrderPayload }) => {
        counters.startEvent = event;
        return { orderId: event.payload.orderId };
      }
    })
    .correlate(orders, (event) => {
      counters.onCorrelationEvent = event;
      return onCorrelation?.(event) ?? readOrderId(event);
    })
    .on(orders, {
      placed: async (state, event, ctx) => runHandler(state, event, ctx, counters),
      paid: async (state, event, ctx) => runHandler(state, event, ctx, counters)
    })
    .build();
  registrations.set(definition, registerSagaDefinition({ definition, pluginManifests: [], responseHandlerBindings: {},
    parseStartInput: parseTurnInput, parseState: parseTurnState, parseOnEvent: parseTurnEvent, canonicalCommandTypes: [] }));
  return definition;
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
  state: { count: number; bad?: unknown; lastEventId?: string },
  event: { id?: string; payload: OrderPayload },
  ctx: { schedule(id: string, delay: number): unknown },
  counters: DefinitionCounters
): Promise<void> {
  counters.handler += 1;
  counters.handlerEvent = event;
  if (event.id === undefined) throw new Error('handler event id is required');
  state.lastEventId = event.id;
  const { payload } = event;
  if (payload.mode === 'throw') throw new Error('handler exploded');
  if (payload.mode === 'intent') ctx.schedule('later', 1);
  state.count += payload.amount ?? 1;
  if (payload.mode === 'invalid') state.bad = () => 'not-json';
}

export function createTurnTable(name: string, counters: DefinitionCounters) {
  const definition = createTurnDefinition(name, counters);
  return compileRegisteredSagaRoutes([registeredTurnDefinition(definition)],
    [{ registration: registeredTurnDefinition(definition), triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] }]);
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
  registrations.set(definition, registerSagaDefinition({ definition, pluginManifests: [], responseHandlerBindings: {},
    parseStartInput: parseTurnInput, parseState: parseTurnState, parseOnEvent: parseTurnEvent, canonicalCommandTypes: [] }));
  return compileRegisteredSagaRoutes([registeredTurnDefinition(definition)],
    [{ registration: registeredTurnDefinition(definition), triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] }]);
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
  readonly partitionId = 'sagas';
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
    const events = this.eventsByStream.get(instanceId) ?? [];
    const commits = [...this.commits.values()].filter((commit) => commit.streamId === instanceId)
      .sort((a, b) => a.commitSequence - b.commitSequence);
    return {
      streamId: instanceId,
      nextCommitSequence: this.nextSequenceByStream.get(instanceId) ?? 0,
      commits: (async function* () {
        let offset = 0;
        for (const [position, commit] of commits.entries()) {
          const count = position === commits.length - 1 ? events.length - offset : commit.events.length;
          yield { ...commit, events: events.slice(offset, offset + count).map((event, index) => ({
            ...event, id: `${commit.commitId}:event:${index}`, version: offset + index
          })) };
          offset += count;
        }
      })()
    };
  }

  async findCommit(streamId: string, commitId: string): Promise<SagaTurnStoredCommit | null> {
    this.findCalls.push({ streamId, commitId });
    if (this.forcedCommit !== undefined) return this.forcedCommit;
    return this.commits.get(this.commitKey(streamId, commitId)) ?? null;
  }

  assertCommitMaterial(stored: SagaTurnStoredCommit, request: SagaTurnAppendRequest, firstEventVersion: number): void {
    if (stored.commitSequence !== request.expectedNextCommitSequence) {
      throw new SagaTurnIntegrityError('incompatible_turn_commit', 'Original sequence differs');
    }
    assertEquivalentSagaCommit(stored, request, 'sagas', firstEventVersion);
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
    const commit: SagaTurnStoredCommit = {
      partitionId: 'sagas', streamId: request.streamId, commitId: request.commitId, commitSequence: sequence,
      identity: request.identity,
      events: request.events.map((event, index) => ({ ...event, id: `${request.commitId}:event:${index}`,
        version: (this.eventsByStream.get(request.streamId)?.length ?? 0) + index }))
    };
    this.eventsByStream.set(request.streamId, [...(this.eventsByStream.get(request.streamId) ?? []), ...request.events]);
    this.nextSequenceByStream.set(request.streamId, sequence + 1);
    this.commits.set(this.commitKey(request.streamId, request.commitId), commit);
    return { status: 'committed', commitSequence: sequence };
  }

  replaceBusinessState(request: SagaTurnAppendRequest, count: number): void {
    const observed = request.events[0]?.payload as { record: { sourcePosition: {
      partitionId: string; streamId: string; commitId: string; eventIndex: number } } };
    const position = { ...observed.record.sourcePosition, commitId: `${observed.record.sourcePosition.commitId}-winner` };
    const winner = { ...request.identity, sourceTriggerId: deriveSourceTriggerId(position) };
    const events = request.events.map((event, index) => {
      if (index === 0) return { ...event, payload: { record: { ...observed.record, sourcePosition: position } } };
      if (event.type === 'saga.business_state_recorded.event' && typeof event.payload === 'object' && event.payload !== null) {
        return { ...event, payload: { ...event.payload, sourceTriggerId: winner.sourceTriggerId, state: { count } } };
      }
      return event;
    });
    this.commit({ ...request, commitId: deriveTurnCommitId(winner), identity: winner, events });
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
