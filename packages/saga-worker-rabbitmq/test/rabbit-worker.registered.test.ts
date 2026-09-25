import { createSaga } from '@redemeine/saga';
import { bindSagaRegistrations, compileRegisteredSagaRoutes, registerSagaDefinition,
  type SagaTurnRepository } from '@redemeine/saga-runtime';
import { createSagaRabbitWorker, createSagaSourceEventProcessor } from '../src/index';
import { body, FakeChannel, message, options } from './helpers';

interface State { count: number }
let started = 0;
const definition = createSaga<State>({ identity: { namespace: 'worker', name: 'registered', version: 1 } })
  .initialState(() => ({ count: 0 }))
  .start((state, input: { orderId: string }, ctx) => {
    started++;
    state.count = input.orderId.length;
    if (input.orderId === 'intent') ctx.actions.core.schedule('later', 1000);
    if (input.orderId === 'invalid') ctx.actions.core.schedule('later', -1);
    if (input.orderId === 'overflow') {
      for (let index = 0; index < 127; index += 1) ctx.actions.core.schedule(`later-${index}`, 1000);
    }
  })
  .correlateBy((input) => input.orderId)
  .triggeredBy({ kind: 'event', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
  .build();

function register(commands: readonly string[] = [], activeDefinition = definition) {
  return registerSagaDefinition({ definition: activeDefinition, pluginManifests: [] as const, responseHandlerBindings: {},
    canonicalCommandTypes: commands, parseStartInput: (input: unknown) => {
      if (!input || typeof input !== 'object' || !('orderId' in input) || typeof input.orderId !== 'string') throw new TypeError('input');
      return { orderId: input.orderId };
    }, parseState: (state: unknown): State => {
      if (!state || typeof state !== 'object' || !('count' in state) || typeof state.count !== 'number') throw new TypeError('state');
      return { count: state.count };
    }, parseOnEvent: (event: unknown) => {
      if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') throw new TypeError('event');
      return { id: 'event', type: event.type, payload: {} };
    } });
}

it('ACKs only after an intent-free registered start has appended its four events', async () => {
  started = 0;
  const registration = register();
  const table = compileRegisteredSagaRoutes([registration], [
    { registration, triggerIndex: 0, eventTypes: ['order.created.event'] }
  ]);
  const appendCalls: unknown[] = [];
  const repository: SagaTurnRepository = {
    partitionId: 'sagas',
    load: async (streamId) => ({ streamId, nextCommitSequence: 0, commits: (async function* () {})() }),
    findCommit: async () => null,
    assertCommitMaterial: () => { throw new Error('unexpected comparison'); },
    append: async (request) => { appendCalls.push(request); return { status: 'committed', commitSequence: 0 }; }
  };
  const channel = new FakeChannel();
  const worker = createSagaRabbitWorker(options(channel, createSagaSourceEventProcessor(table, repository,
    { registrationForRoute: bindSagaRegistrations(table, [registration]) })));
  await worker.start();
  const incoming = message({ body: { ...body(), events: [body().events[0]] } });
  await worker.handle(incoming);
  expect(appendCalls).toEqual([expect.objectContaining({ events: [
    expect.objectContaining({ type: 'saga.instance_created.event' }),
    expect.objectContaining({ type: 'saga.definition_identity_recorded.event' }),
    expect.objectContaining({ type: 'saga.source_event_observed.event' }),
    expect.objectContaining({ type: 'saga.business_state_recorded.event', payload: expect.objectContaining({ state: { count: 7 } }) })
  ] })]);
  expect(started).toBe(1);
  expect(channel.acks).toEqual([{ message: incoming, allUpTo: false }]);
  expect(channel.nacks).toEqual([]);
  await worker.stop();
});

it.each(['invalid', 'overflow'])('dead-letters %s complete turn before append without ACK or hot retry', async orderId => {
  started = 0;
  const registration = register();
  const table = compileRegisteredSagaRoutes([registration],
    [{ registration, triggerIndex: 0, eventTypes: ['order.created.event'] }]);
  const appendCalls: unknown[] = [];
  const repository: SagaTurnRepository = {
    partitionId: 'sagas',
    load: async (streamId) => ({ streamId, nextCommitSequence: 0, commits: (async function* () {})() }),
    findCommit: async () => null,
    assertCommitMaterial: () => { throw new Error('unexpected comparison'); },
    append: async (request) => { appendCalls.push(request); return { status: 'committed', commitSequence: 0 }; }
  };
  const channel = new FakeChannel();
  const worker = createSagaRabbitWorker(options(channel, createSagaSourceEventProcessor(table, repository,
    { registrationForRoute: bindSagaRegistrations(table, [registration]) })));
  await worker.start();
  const source = body();
  const incoming = message({ body: { ...source, events: [{ ...source.events[0], payload: { orderId } }] } });
  await worker.handle(incoming);
  expect(started).toBe(1);
  expect(appendCalls).toEqual([]);
  expect(channel.acks).toEqual([]);
  expect(channel.nacks).toEqual([{ message: incoming, allUpTo: false, requeue: false }]);
  await worker.stop();
});

it('ACKs a valid timer only after its intent and fact share the physical append', async () => {
  const registration = register();
  const table = compileRegisteredSagaRoutes([registration],
    [{ registration, triggerIndex: 0, eventTypes: ['order.created.event'] }]);
  const appended: string[][] = [];
  const repository: SagaTurnRepository = {
    partitionId: 'sagas',
    load: async streamId => ({ streamId, nextCommitSequence: 0, commits: (async function* () {})() }),
    findCommit: async () => null,
    assertCommitMaterial: () => { throw new Error('unexpected comparison'); },
    append: async request => {
      appended.push(request.events.map(event => event.type));
      return { status: 'committed', commitSequence: 0 };
    }
  };
  const channel = new FakeChannel();
  const worker = createSagaRabbitWorker(options(channel, createSagaSourceEventProcessor(table, repository,
    { registrationForRoute: bindSagaRegistrations(table, [registration]) })));
  await worker.start();
  const source = body();
  const incoming = message({ body: { ...source, events: [{ ...source.events[0], payload: { orderId: 'intent' } }] } });
  await worker.handle(incoming);
  expect(appended).toEqual([[
    'saga.instance_created.event', 'saga.definition_identity_recorded.event', 'saga.source_event_observed.event',
    'saga.business_state_recorded.event', 'saga.intent_recorded.event', 'saga.timer_fact_recorded.event'
  ]]);
  expect(channel.acks).toEqual([{ message: incoming, allUpTo: false }]);
  expect(channel.nacks).toEqual([]);
  await worker.stop();
});

it('refuses missing and mismatched issued registrations before Rabbit startup', () => {
  const registration = register();
  const table = compileRegisteredSagaRoutes([registration]);
  const channel = new FakeChannel();
  const startup = (registrations: readonly typeof registration[]) => {
    const registrationForRoute = bindSagaRegistrations(table, registrations);
    return createSagaRabbitWorker(options(channel, async () => {
      void registrationForRoute;
      return [];
    }));
  };
  expect(() => startup([])).toThrow('Missing');
  expect(() => startup([register()])).toThrow('Mismatched');
  expect(() => startup([register(['changed.policy'])])).toThrow('Mismatched');
  expect(() => startup([{ ...registration }])).toThrow('Untrusted');
  const versioned = { ...definition, identity: { ...definition.identity } };
  const changedVersion = register([], versioned);
  const versionTable = compileRegisteredSagaRoutes([changedVersion]);
  versioned.identity.version = 2;
  expect(() => bindSagaRegistrations(versionTable, [changedVersion])).toThrow('identity mismatch');
  expect(channel.calls).toEqual([]);
});

it('refuses a table without registered executable handles before consume', () => {
  const registration = register();
  const table = compileRegisteredSagaRoutes([registration],
    [{ registration, triggerIndex: 0, eventTypes: ['order.created.event'] }]);
  const { registered: _registered, ...bareTable } = table;
  const repository: SagaTurnRepository = {
    partitionId: 'sagas',
    load: async () => { throw new Error('unexpected load'); },
    findCommit: async () => null,
    assertCommitMaterial: () => undefined,
    append: async () => { throw new Error('unexpected append'); }
  };
  expect(() => createSagaSourceEventProcessor(bareTable, repository,
    { registrationForRoute: bindSagaRegistrations(table, [registration]) })).toThrow('compiled executable registration table');
});
