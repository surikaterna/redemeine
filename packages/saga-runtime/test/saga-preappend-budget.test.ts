import { createSaga } from '@redemeine/saga';
import { bindSagaRegistrations, compileRegisteredSagaRoutes, processSagaSourceEvent, registerSagaDefinition } from '../src/index';
import { FakeTurnRepository, orders, parseTurnEvent, parseTurnInput, parseTurnState, sourceEvent } from './fixtures/turn-processor.fixture';

function setup(startTimers: number, onTimers: number, stateBytes = 0) {
  const definition = createSaga({ identity: { namespace: 'turns', name: 'physical-budget', version: 1 } })
    .initialState(() => ({ count: 0, blob: '' }))
    .start<{ orderId: string }>((state, _input, ctx) => {
      state.blob = 's'.repeat(stateBytes);
      for (let index = 0; index < startTimers; index += 1) ctx.schedule(`start-${index}`, 10);
    })
    .correlateBy(input => input.orderId)
    .triggeredBy({ kind: 'domain', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
    .correlate(orders, event => event.payload.orderId)
    .on(orders, { paid: (_state, _event, ctx) => {
      for (let index = 0; index < onTimers; index += 1) ctx.schedule(`on-${index}`, 10);
    } }).build();
  const registration = registerSagaDefinition({ definition, pluginManifests: [], responseHandlerBindings: {},
    canonicalCommandTypes: [], parseStartInput: parseTurnInput,
    parseState: (value: unknown) => {
      const state = parseTurnState(value);
      if (!('blob' in state) || typeof state.blob !== 'string') throw new TypeError('missing state blob');
      return { count: state.count, blob: state.blob };
    }, parseOnEvent: parseTurnEvent });
  const table = compileRegisteredSagaRoutes([registration],
    [{ registration, triggerIndex: 0, eventTypes: ['turn.order-placed.v1.event'] }]);
  const options = { registrationForRoute: bindSagaRegistrations(table, [registration]) };
  return { table, options };
}

it.each(['start', 'on'] as const)('rejects complete %s turn with 258 physical events before permissive append', async kind => {
  const { table, options } = setup(kind === 'start' ? 127 : 0, kind === 'on' ? 128 : 0);
  const repository = new FakeTurnRepository();
  if (kind === 'on') await processSagaSourceEvent(table, repository, sourceEvent(), options);
  const before = repository.appendCalls.length;
  const source = kind === 'on' ? sourceEvent({ type: 'turn.order-paid.v1.event', commitId: 'second' }) : sourceEvent();
  await expect(processSagaSourceEvent(table, repository, source, options))
    .rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
  expect(repository.appendCalls).toHaveLength(before);
});

it.each(['start', 'on'] as const)('accepts complete %s turn with exactly 256 physical events', async kind => {
  const { table, options } = setup(kind === 'start' ? 126 : 0, kind === 'on' ? 127 : 0);
  const repository = new FakeTurnRepository();
  if (kind === 'on') await processSagaSourceEvent(table, repository, sourceEvent(), options);
  const source = kind === 'on' ? sourceEvent({ type: 'turn.order-paid.v1.event', commitId: 'second' }) : sourceEvent();
  await expect(processSagaSourceEvent(table, repository, source, options)).resolves.toMatchObject([{ status: 'committed' }]);
  expect(repository.appendCalls.at(-1)?.events).toHaveLength(256);
});

it.each(['start', 'on'] as const)('rejects %s complete BSON envelope over 12 MiB with individually valid state and observation', async kind => {
  const { table, options } = setup(0, 0, 5 * 1024 * 1024);
  const repository = new FakeTurnRepository();
  if (kind === 'on') await processSagaSourceEvent(table, repository, sourceEvent(), options);
  const before = repository.appendCalls.length;
  const source = sourceEvent({ ...(kind === 'on' ? { type: 'turn.order-paid.v1.event', commitId: 'second' } : {}),
    payload: { orderId: 'order-1', blob: 'p'.repeat(8 * 1024 * 1024 - 200) } });
  await expect(processSagaSourceEvent(table, repository, source, options))
    .rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
  expect(repository.appendCalls).toHaveLength(before);
});

it('rejects a physical observation event over 10 MiB before permissive append', async () => {
  const { table, options } = setup(0, 0);
  const repository = new FakeTurnRepository();
  await expect(processSagaSourceEvent(table, repository, sourceEvent({
    payload: { orderId: 'order-1', blob: 'p'.repeat(6 * 1024 * 1024) },
    metadata: { blob: 'm'.repeat(5 * 1024 * 1024) }
  }), options)).rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
  expect(repository.appendCalls).toHaveLength(0);
});
