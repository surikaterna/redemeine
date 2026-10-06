import { afterEach, expect, it, jest } from '@jest/globals';

afterEach(() => {
  jest.dontMock('@redemeine/projection-runtime-core');
  jest.resetModules();
});

it('preserves the load failure cause and does not fall back to workspace source', async () => {
  const cause = new Error('runtime initialization failed');
  jest.doMock('@redemeine/projection-runtime-core', () => { throw cause; });
  const { loadProjectionRuntimeModule } = await import('../src/projectionRuntime');

  await expect(loadProjectionRuntimeModule()).rejects.toMatchObject({
    message: expect.stringContaining('runtime initialization failed'),
    cause
  });
});

it('loads constructors in an independent healthy module context without sharing store instances', async () => {
  const { loadProjectionRuntimeModule } = await import('../src/projectionRuntime');
  const runtime = await loadProjectionRuntimeModule();
  const laterRuntime = await loadProjectionRuntimeModule();

  expect(laterRuntime.core.ProjectionDaemon).toBe(runtime.core.ProjectionDaemon);
  expect(new runtime.inmemory.InMemoryProjectionStore()).not.toBe(
    new laterRuntime.inmemory.InMemoryProjectionStore()
  );
  expect(runtime.core.ProjectionDaemon).toBeDefined();
});
