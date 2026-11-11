import { EventEmitter } from 'node:events';
import { ProjectionHost } from '../../src/host';
import type { ConnectResource, HostResource } from '../../src/hostAttempt';
import { Observations } from '../../src/observability';
import { OrderedFeedModel } from '../../src/reference/feedModel';
import { modelStart } from '../../src/reference/modelIdentity';
import type { SessionFence } from '../../src/sessionFence';
import { referenceConfig } from '../fixtures';

export function modelResource(fence: SessionFence) {
  const start = modelStart('a'.repeat(64));
  const feed = new OrderedFeedModel(start, []);
  const status: { accepting: boolean; activeDeliveries: number; reason?: string } = { accepting: true, activeDeliveries: 0 };
  const resource: HostResource = {
    worker: { getStatus: () => status, stop: jest.fn(async () => ({ drained: true })) },
    start: jest.fn(async () => {
      await fence.wrap(feed).openSession(start, { sessionRef: 'model:host-test', queueName: start.queueName, exclusive: true, prefetch: 1 });
    }), close: jest.fn(async () => {})
  };
  return { resource, feed, status };
}

export function hostFixture(connect: ConnectResource, timeout = 150, connectTimeout = 1000) {
  const signals = new EventEmitter();
  const close = jest.fn(async () => {});
  const forceExit = jest.fn();
  const lines: string[] = [];
  const observations = new Observations((line) => lines.push(line));
  const host = new ProjectionHost({ ...referenceConfig, healthPort: 0, shutdownTimeoutMs: timeout,
    connectTimeoutMs: connectTimeout, reconnectAttempts: 3 }, { signals, forceExit, observations,
    acquire: async () => ({ close }), connect, random: () => 0 });
  const done = host.start();
  return { host, done, signals, close, forceExit, lines };
}
