import { randomUUID } from 'node:crypto';
import { expect, jest, test } from '@jest/globals';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';
import { fixtureRuntime, read, type Backend, type State, viewFixture } from '../../projection-transport/integration/joinSeedFixture';
import { order } from '../../projection-transport/integration/joinSeedScenarios';

test.each([false, true])('rejects a promise-returning handler with a staged seed (compatibility=%s)', async (compatibility) => {
  const store = new InMemoryProjectionStore<State>();
  if (compatibility) Object.defineProperty(store, 'sourceCommitSnapshotCapability', { value: undefined });
  const backend: Backend = { store: () => store, history: async () => store.getProjectionChanges() };
  const provider = jest.fn(async () => null);
  const write = jest.spyOn(store, 'commitProjectionSourceCommit');
  const { definition, reader } = viewFixture(provider);
  const hook = jest.fn();
  const stream = definition.joinStreams![0]!;
  const assign = stream.handlers.assign!;
  const late = jest.fn();
  const registration = definition.joinInitializers![0]!;
  const initializer = jest.fn(registration.initialize);
  const fixture = fixtureRuntime(backend, { reader, definition: {
    ...definition,
    joinInitializers: [{ ...registration, initialize: initializer }],
    hooks: { afterEach: hook },
    joinStreams: [{ ...stream, handlers: { ...stream.handlers, async assign(draft, event, ctx) {
      assign(draft, event, ctx);
      await Promise.resolve();
      late();
      draft.total = 999;
    } } }]
  } });
  const source = randomUUID();
  const commit = order(source, 0, [['assign', { to: 'A', amount: 5 }]]);
  expect(await fixture.start().process(commit)).toMatchObject({ status: 'terminal', reason: 'Projection handler must be synchronous.' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(late).toHaveBeenCalledTimes(1);
  expect(provider).not.toHaveBeenCalled();
  expect(initializer).not.toHaveBeenCalled();
  expect(hook).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(fixture.coverage.has(source)).toBe(false);
  expect(await read(backend, source, 'A')).toMatchObject({
    row: { revision: null, targetDocumentIds: [] }, states: [null], progress: null
  });
  expect(await backend.history()).toEqual([]);
});
