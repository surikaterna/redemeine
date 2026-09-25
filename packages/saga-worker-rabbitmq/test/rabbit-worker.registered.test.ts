import { createSaga } from '@redemeine/saga';
import { bindSagaRegistrations, compileRegisteredSagaRoutes, registerSagaDefinition,
  type SagaTurnRepository } from '@redemeine/saga-runtime';
import { createSagaRabbitWorker, createSagaSourceEventProcessor } from '../src/index';
import { body, FakeChannel, message, options } from './helpers';

interface State { count: number }
let started = 0;
const definition = createSaga<State>({ identity: { namespace: 'worker', name: 'registered', version: 1 } })
  .initialState(() => ({ count: 0 }))
  .start((state, input: { orderId: string }) => { started++; state.count = input.orderId.length; })
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

it('rejects absent registered start before append and never ACKs Rabbit delivery', async () => {
  started = 0;
  const registration = register();
  const table = compileRegisteredSagaRoutes([registration], [
    { registration, triggerIndex: 0, eventTypes: ['order.created.event'] }
  ]);
  const appendCalls: unknown[] = [];
  const repository: SagaTurnRepository = {
    load: async (streamId) => ({ streamId, nextCommitSequence: 0, commits: (async function* () {})() }),
    findCommit: async () => null,
    assertCommitMaterial: () => { throw new Error('unexpected comparison'); },
    append: async (request) => { appendCalls.push(request); throw new Error('unexpected append'); }
  };
  const channel = new FakeChannel();
  const worker = createSagaRabbitWorker(options(channel, createSagaSourceEventProcessor(table, repository,
    { registrationForRoute: bindSagaRegistrations(table, [registration]) })));
  await worker.start();
  const incoming = message({ body: { ...body(), events: [body().events[0]] } });
  await worker.handle(incoming);
  expect(appendCalls).toEqual([]);
  expect(started).toBe(0);
  expect(channel.acks).toEqual([]);
  expect(channel.nacks).toEqual([{ message: incoming, allUpTo: false, requeue: false }]);
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
