import { createAggregate } from '@redemeine/aggregate';
import { createSaga } from '@redemeine/saga';
import { bindSagaRegistrations, compileRegisteredSagaRoutes, registerSagaDefinition,
  type SagaTurnRepository, type SagaTurnStoredCommit } from '@redemeine/saga-runtime';
import { createSagaRabbitWorker, createSagaSourceEventProcessor } from '../src/index';
import { body, FakeChannel, message, options } from './helpers';

const orders = createAggregate('orders', { paid: 0 })
  .events({ paid: (state) => { state.paid += 1; } })
  .overrideEventNames({ paid: 'order.paid.event' }).build();

function overBudgetRoutes() {
  const definition = createSaga({ identity: { namespace: 'worker', name: 'on-budget', version: 1 } })
    .initialState(() => ({ count: 0 }))
    .start<{ orderId: string }>(state => { state.count = 1; })
    .correlateBy(input => input.orderId)
    .triggeredBy({ kind: 'event', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
    .correlate(orders, event => event.payload.orderId)
    .on(orders, { paid: (_state, _event, ctx) => {
      for (let index = 0; index < 128; index += 1) ctx.schedule(`on-${index}`, 1000);
    } }).build();
  const registration = registerSagaDefinition({ definition, pluginManifests: [], responseHandlerBindings: {},
    canonicalCommandTypes: [], parseStartInput: (input: unknown) => {
      if (!input || typeof input !== 'object' || !('orderId' in input) || typeof input.orderId !== 'string') throw new TypeError('input');
      return { orderId: input.orderId };
    }, parseState: (state: unknown) => {
      if (!state || typeof state !== 'object' || !('count' in state) || typeof state.count !== 'number') throw new TypeError('state');
      return { count: state.count };
    }, parseOnEvent: (event: unknown) => {
      if (!event || typeof event !== 'object' || !('id' in event) || typeof event.id !== 'string' ||
        !('type' in event) || typeof event.type !== 'string' || !('payload' in event)) throw new TypeError('event');
      return { id: event.id, type: event.type, payload: event.payload };
    } });
  const table = compileRegisteredSagaRoutes([registration],
    [{ registration, triggerIndex: 0, eventTypes: ['order.created.event'] }]);
  return { registration, table };
}

function memoryRepository() {
  const commits: SagaTurnStoredCommit[] = [];
  let appendCalls = 0;
  const repository: SagaTurnRepository = {
    partitionId: 'sagas',
    load: async streamId => ({ streamId, nextCommitSequence: commits.length, commits: (async function* () { yield* commits; })() }),
    findCommit: async () => null,
    assertCommitMaterial: () => { throw new Error('unexpected comparison'); },
    append: async request => {
      appendCalls += 1;
      commits.push({ partitionId: 'sagas', streamId: request.streamId, commitId: request.commitId,
        commitSequence: commits.length, identity: request.identity,
        events: request.events.map((event, index) => ({ ...event, id: `${request.commitId}:event:${index}`, version: index })) });
      return { status: 'committed', commitSequence: commits.length - 1 };
    }
  };
  return { repository, appendCount: () => appendCalls };
}

it('dead-letters an over-limit on turn without appending its final intent or ACKing the source', async () => {
  const { registration, table } = overBudgetRoutes();
  const { repository, appendCount } = memoryRepository();
  const channel = new FakeChannel();
  const worker = createSagaRabbitWorker(options(channel, createSagaSourceEventProcessor(table, repository,
    { registrationForRoute: bindSagaRegistrations(table, [registration]) })));
  await worker.start();
  const source = body();
  const initial = message({ body: { ...source, events: [source.events[0]] } });
  await worker.handle(initial);
  expect(appendCount()).toBe(1);
  expect(channel.acks).toEqual([{ message: initial, allUpTo: false }]);
  const on = message({ body: { ...source, id: 'commit-2', commitSequence: 5, events: [source.events[1]] }, messageId: 'commit-2' });
  await worker.handle(on);
  expect(appendCount()).toBe(1);
  expect(channel.acks).toEqual([{ message: initial, allUpTo: false }]);
  expect(channel.nacks).toEqual([{ message: on, allUpTo: false, requeue: false }]);
  const badKey = Object.fromEntries([['bad\u0000key', 1]]);
  const invalid = message({ body: { ...source, id: 'commit-3', commitSequence: 6,
    events: [{ ...source.events[1], metadata: { nested: badKey } }] }, messageId: 'commit-3' });
  await worker.handle(invalid);
  expect(appendCount()).toBe(1);
  expect(channel.acks).toEqual([{ message: initial, allUpTo: false }]);
  expect(channel.nacks).toEqual([
    { message: on, allUpTo: false, requeue: false }, { message: invalid, allUpTo: false, requeue: false }
  ]);
  await worker.stop();
});
