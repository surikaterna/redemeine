import { EventEmitter } from 'node:events';
import { ProjectionHost } from '../src/host';
import { selectExternalInfrastructure } from '../src/infrastructure/external';
import { createReferenceRuntime } from '../src/reference/runtime';
import { SessionFence } from '../src/sessionFence';
import { builtArtifact, referenceConfig } from './fixtures';
import { until } from './support/deferred';
import { externalConfig, mongoClientFixture } from './support/mongoClient';
import { rabbitClientFixture } from './support/rabbitClient';
import { request } from './support/http';

afterEach(() => { jest.restoreAllMocks(); });

test('selection does not construct clients and cancellation refuses before any client opens', async () => {
  const artifact = await builtArtifact();
  const mongo = jest.fn(() => { throw new Error('must_not_construct'); });
  const rabbit = jest.fn(async () => { throw new Error('must_not_connect'); });
  const selected = selectExternalInfrastructure(externalConfig(), artifact, { mongo, rabbit });
  const controller = new AbortController(); controller.abort();
  await expect(selected.connect(controller.signal, new SessionFence())).rejects.toThrow('infrastructure_stopped');
  expect(mongo).not.toHaveBeenCalled(); expect(rabbit).not.toHaveBeenCalled();
});

test('external host attempts its configured client and pauses503 when initialization fails', async () => {
  const config = externalConfig(); const artifact = await builtArtifact();
  const mongo = jest.fn(() => { throw new Error('must_not_construct'); });
  const rabbit = jest.fn(async () => { throw new Error('must_not_connect'); });
  const selected = selectExternalInfrastructure(config, artifact, { mongo, rabbit });
  const connect = jest.fn(selected.connect); const signals = new EventEmitter(); const close = jest.fn(async () => {});
  const host = new ProjectionHost({ ...config, healthPort: 0 }, { acquire: async () => ({ close }), connect,
    signals, forceExit: jest.fn() });
  const done = host.start();
  try {
    await until(() => host.snapshot().reason === 'startup_refused');
    expect((await request(host.healthPort, '/live')).status).toBe(200);
    expect((await request(host.healthPort, '/ready')).status).toBe(503);
    const reference = await request(host.healthPort, '/reference-ready');
    expect(reference.status).toBe(503);
    expect(JSON.parse(reference.text)).toMatchObject({ referenceOnly: false, productionReady: false, referenceReady: false });
    expect(connect).toHaveBeenCalledTimes(1); expect(mongo).toHaveBeenCalledTimes(1); expect(rabbit).not.toHaveBeenCalled();
  } finally { signals.emit('SIGTERM'); expect(await done).toBe(0); }
  expect(close).toHaveBeenCalledTimes(1);
});

test('model and external selectors cannot be interchanged', async () => {
  const artifact = await builtArtifact();
  expect(() => selectExternalInfrastructure(referenceConfig, artifact)).toThrow('external_mode_required');
  expect(() => createReferenceRuntime(artifact, externalConfig(), [])).toThrow('model:external_forbidden');
});

test('successful injected prerequisite inspection does not elevate evidence, consume or initialize durable stores', async () => {
  const mongo = mongoClientFixture(); const rabbit = rabbitClientFixture();
  const artifact = await builtArtifact();
  const selected = selectExternalInfrastructure(mongo.config, artifact, { mongo: mongo.factory, rabbit: rabbit.factory });
  const inspected = await selected.inspectPrerequisites(new AbortController().signal);
  await expect(selected.connect(new AbortController().signal, new SessionFence())).rejects.toThrow('broker_startup_refused');
  expect(inspected.rabbit.queueFacts.qualification).toBe('unproven');
  expect(mongo.initialize).not.toHaveBeenCalled(); expect(mongo.createIndex).not.toHaveBeenCalled();
  expect(mongo.update).not.toHaveBeenCalled(); expect(rabbit.native.consume).not.toHaveBeenCalled(); expect(rabbit.native.ack).not.toHaveBeenCalled();
  await inspected.close();
  expect(mongo.close).toHaveBeenCalledTimes(2); expect(rabbit.connection.close).toHaveBeenCalledTimes(2);
});

test('partial composite acquisition closes Mongo when Rabbit prerequisites fail', async () => {
  const mongo = mongoClientFixture(); const rabbit = rabbitClientFixture();
  rabbit.native.checkQueue.mockRejectedValue(new Error('secret-canary'));
  const selected = selectExternalInfrastructure(mongo.config, await builtArtifact(), { mongo: mongo.factory, rabbit: rabbit.factory });
  await expect(selected.inspectPrerequisites(new AbortController().signal)).rejects.toThrow('rabbit_prerequisite_failed');
  expect(mongo.close).toHaveBeenCalledTimes(1); expect(rabbit.connection.close).toHaveBeenCalledTimes(1);
  expect(mongo.createIndex).not.toHaveBeenCalled();
});
