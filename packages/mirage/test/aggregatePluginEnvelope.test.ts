import { createAggregate, createAggregatePlugin, createEntity } from '@redemeine/aggregate';
import type { Command, Event, RedemeinePlugin } from '@redemeine/kernel';
import { createMirage, dispatch, extractState, extractUncommittedEvents } from '../src';
import { createDepot, type EventStore } from '../src/Depot';

const instant = '2026-10-16T10:00:00.000Z';

function datePlugin(clock: () => Date, order: string[] = []) {
  return createAggregatePlugin('audit').state(() => ({ dates: [] as string[], refs: [] as string[] }))
    .commandEnvelope(input => {
      order.push('prepare');
      const dateTime = input.dateTime === undefined ? clock() : input.dateTime;
      if (!(dateTime instanceof Date) || !Number.isFinite(dateTime.getTime())) throw new TypeError('Invalid dateTime');
      return { dateTime };
    })
    .eventEnvelope((_, context) => ({ sourceCommandDateTime: new Date(context.command.dateTime.getTime()), auditRef: context.command.id! }))
    .onEvent((draft, event) => {
      const date: unknown = Reflect.get(event, 'sourceCommandDateTime');
      const ref: unknown = Reflect.get(event, 'auditRef');
      if (!(date instanceof Date) || typeof ref !== 'string') throw new Error('Missing event audit');
      draft.dates.push(date.toISOString());
      draft.refs.push(ref);
    }).build();
}

function definition(clock: () => Date, order: string[] = []) {
  const line = createEntity<{ id: string; qty: number }, 'line'>('line')
    .events({ set(state, event: Event<{ id: string; qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ setQty: { pack: (id: string, qty: number) => ({ id, qty }),
      handler: (_state, payload) => emit.set(payload) } })).build();
  return createAggregate('order', { total: 0, lines: [{ id: 'line-1', qty: 0 }] })
    .events({ added(state, event: Event<number>) { state.total += event.payload; } })
    .commands(emit => ({ add: (_state, amount: number) => { order.push('domain'); return emit.added(amount); } }))
    .entityList('lines', line).build().withPlugins(datePlugin(clock, order));
}

test('prepares before async legacy lifecycle and hooks; raw creators and readonly results stay unchanged', async () => {
  const order: string[] = [];
  const clock = jest.fn(() => new Date(instant));
  const built = definition(clock, order);
  let observed: Command<unknown, string> | undefined;
  built.hooks = { onBeforeCommand(command) {
    order.push('hook'); observed = command;
    expect(Reflect.get(command, 'dateTime')).toEqual(new Date(instant));
  } };
  const legacy: RedemeinePlugin = { key: 'legacy', async onBeforeCommand() { order.push('legacy'); } };
  const live = createMirage(built, 'one', { plugins: [legacy] });
  const raw = { ...built.commandCreators.add(2), id: 'command-1', unexpected: true,
    headers: { commandSummary: { amount: 2 }, commandStoreRef: 'store:1' }, metadata: { trace: 'trace' } };
  const result = dispatch(live, raw);
  expect(result).toBeInstanceOf(Promise);
  expect(order).toEqual(['prepare', 'legacy']);
  expect(await result).toEqual({ total: 2, lines: [{ id: 'line-1', qty: 0 }], audit: { dates: [instant], refs: ['command-1'] } });
  expect(order).toEqual(['prepare', 'legacy', 'hook', 'domain']);
  expect(observed).toMatchObject({ aggregateId: 'one', aggregateType: 'order', id: 'command-1', metadata: raw.metadata, headers: raw.headers });
  expect(observed).not.toHaveProperty('unexpected');
  expect(raw).not.toHaveProperty('dateTime');
  expect(live).not.toHaveProperty('dateTime');
  expect(clock).toHaveBeenCalledTimes(1);
  expect(extractUncommittedEvents(live)[0]).toMatchObject({ sourceCommandDateTime: new Date(instant), auditRef: 'command-1',
    aggregateId: 'one', correlationId: 'command-1', metadata: { command: { id: 'command-1', summary: { amount: 2 }, storeRef: 'store:1' } } });
  expect(Reflect.set(live.audit.dates, '0', 'corrupt')).toBe(false);
  expect(live.audit.dates).toEqual([instant]);
  expect(built.initialState.audit.dates).toEqual([]);
});

test('root/entity shortcuts and direct dispatch persist enriched events; Depot replay never prepares', async () => {
  const clock = jest.fn(() => new Date(instant));
  const built = definition(clock);
  const stream: Event[] = [];
  const store: EventStore = {
    async *readStream() { yield* structuredClone(stream); },
    async saveEvents(_id, events, version) { expect(version).toBe(0); stream.push(...structuredClone(events)); }
  };
  const depot = createDepot(built, store);
  const live = await depot.get('one');
  await live.add(1);
  expect(await live.lines('line-1').setQty(3)).toEqual({ id: 'line-1', qty: 3 });
  await dispatch(live, built.commandCreators.add(2));
  expect(clock).toHaveBeenCalledTimes(3);
  expect(live.total).toBe(3);
  expect(live.lines('line-1').qty).toBe(3);
  const events = extractUncommittedEvents(live);
  expect(events).toHaveLength(3);
  for (const event of events) {
    expect(event).toMatchObject({ aggregateId: 'one', aggregateType: 'order', sourceCommandDateTime: new Date(instant) });
    expect(Reflect.get(event, 'auditRef')).toBe(event.correlationId);
  }
  await depot.save(live);
  expect(extractUncommittedEvents(live)).toEqual([]);
  clock.mockImplementation(() => { throw new Error('replay clock'); });
  const replay = await depot.get('one');
  expect(extractState(replay)).toEqual(extractState(live));
  expect(built.initialState.audit.dates).toEqual([]);
});

test('existing dates survive without restamping; invalid input fails before lifecycle/application', () => {
  const clock = jest.fn(() => { throw new Error('no clock'); });
  const built = definition(clock);
  const hook = jest.fn();
  built.hooks = { onBeforeCommand: hook };
  const live = createMirage(built, 'one');
  for (const extra of [{ dateTime: 'bad' }, { dateTime: new Date('bad') }, { aggregateId: 42 }, { correlationId: false }]) {
    expect(() => dispatch(live, { ...built.commandCreators.add(1), ...extra })).toThrow();
  }
  expect(hook).not.toHaveBeenCalled();
  expect(extractUncommittedEvents(live)).toEqual([]);
  dispatch(live, { ...built.commandCreators.add(1), dateTime: new Date(instant), id: 'retry' });
  expect(live.audit.refs).toEqual(['retry']);
  expect(clock).not.toHaveBeenCalled();
});

test('a before hook mutation invalidates the Aggregate preparation cache before domain processing', () => {
  const clock = jest.fn(() => new Date(instant));
  const order: string[] = [];
  const built = definition(clock, order);
  built.hooks = { onBeforeCommand(command) { Reflect.set(command, 'dateTime', 'invalid'); } };
  const live = createMirage(built, 'one');
  expect(() => live.add(1)).toThrow('Invalid dateTime');
  expect(order).toEqual(['prepare', 'prepare']);
  expect(live.total).toBe(0);
  expect(extractUncommittedEvents(live)).toEqual([]);
});

test('without envelope plugins dispatch retains original command reference and extra fields', () => {
  const built = createAggregate('plain', { count: 0 }).events({ added(state) { state.count++; } })
    .commands(emit => ({ add: () => emit.added() })).build();
  const raw = { ...built.commandCreators.add(), arbitrary: true };
  const hook = jest.fn();
  built.hooks = { onBeforeCommand: hook };
  const live = createMirage(built, 'plain-1');
  expect(dispatch(live, raw)).not.toBeInstanceOf(Promise);
  expect(hook.mock.calls[0]?.[0]).toBe(raw);
  expect(raw).not.toHaveProperty('aggregateId');
});
