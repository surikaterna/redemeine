import { expect, test } from 'bun:test';

test('built saga package is ESM importable', async () => {
  const saga = await import('../../saga/dist/index.js');

  expect(typeof saga.runSagaHandler).toBe('function');
});

test('built saga-runtime package is ESM importable', async () => {
  const sagaRuntime = await import('../dist/index.js');

  expect(typeof sagaRuntime.createSagaAggregate).toBe('function');
  expect(typeof sagaRuntime.createSagaDispatchContext).toBe('function');
  expect(typeof sagaRuntime.runSagaHandler).toBe('function');
});
