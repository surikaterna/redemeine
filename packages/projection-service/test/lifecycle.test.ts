import type { HostResource } from '../src/hostAttempt';
import { RetryBudget, TransientConnectionError } from '../src/reconnect';
import { deferred, until } from './support/deferred';
import { hostFixture, modelResource } from './support/hostFixture';

test('session expiry alone latches unready and stops even when worker accepting stays true', async () => {
  let model: ReturnType<typeof modelResource> | undefined;
  const fixture = hostFixture(async (_signal, fence) => { model = modelResource(fence); return model.resource; });
  await until(() => fixture.host.snapshot().referenceReady);
  model?.feed.loseContinuity();
  expect(fixture.host.snapshot()).toMatchObject({ productionReady: false, referenceReady: false, phase: 'paused', reason: 'session_invalid' });
  await until(() => !!model && jest.mocked(model.resource.worker.stop).mock.calls.length === 1);
  expect(model?.status.accepting).toBe(true);
  fixture.signals.emit('SIGTERM');
  expect(await fixture.done).toBe(0);
  expect(fixture.close).toHaveBeenCalledTimes(1);
  expect(fixture.signals.listenerCount('SIGTERM')).toBe(0);
});

test.each(['connect', 'start', 'stop', 'close', 'drained_false'])('%s unresolved cannot release ownership at deadline even with mocked exit', async (blocked) => {
  const pending = deferred<void>();
  let model: ReturnType<typeof modelResource> | undefined;
  const fixture = hostFixture(async (_signal, fence) => {
    if (blocked === 'connect') await pending.promise;
    model = modelResource(fence);
    if (blocked === 'start') model.resource.start = () => pending.promise;
    if (blocked === 'stop') model.resource.worker.stop = async () => { await pending.promise; return { drained: true }; };
    if (blocked === 'drained_false') model.resource.worker.stop = async () => ({ drained: false });
    if (blocked === 'close') model.resource.close = () => pending.promise;
    return model.resource;
  });
  await until(() => fixture.host.snapshot().phase === 'connecting' || fixture.host.snapshot().referenceReady);
  fixture.signals.emit('SIGINT');
  expect(await fixture.done).toBe(124);
  expect(fixture.forceExit).toHaveBeenCalledWith(124);
  expect(fixture.close).not.toHaveBeenCalled();
  pending.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(fixture.close).not.toHaveBeenCalled();
  expect(fixture.host.snapshot().referenceReady).toBe(false);
});

test('late connect completion closes its resource without starting or resurrecting readiness', async () => {
  const pending = deferred<HostResource>();
  const fixture = hostFixture(async () => pending.promise, 500);
  await until(() => fixture.host.snapshot().phase === 'connecting');
  fixture.signals.emit('SIGTERM');
  const resource: HostResource = { worker: { getStatus: () => ({ accepting: true, activeDeliveries: 0 }),
    stop: jest.fn(async () => ({ drained: true })) }, start: jest.fn(async () => {}), close: jest.fn(async () => {}) };
  pending.resolve(resource);
  expect(await fixture.done).toBe(0);
  expect(resource.start).not.toHaveBeenCalled();
  expect(resource.worker.stop).toHaveBeenCalledTimes(1);
  expect(resource.close).toHaveBeenCalledTimes(1);
  expect(fixture.close).toHaveBeenCalledTimes(1);
});

test('late start rejection is observed; repeated signals neither restart stop nor extend deadline', async () => {
  const pending = deferred<void>();
  let model: ReturnType<typeof modelResource> | undefined;
  const fixture = hostFixture(async (_signal, fence) => {
    model = modelResource(fence); model.resource.start = () => pending.promise; return model.resource;
  }, 250);
  await until(() => !!model);
  const started = performance.now();
  fixture.signals.emit('SIGTERM');
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  fixture.signals.emit('SIGINT');
  expect(await fixture.done).toBe(124);
  expect(performance.now() - started).toBeLessThan(375);
  pending.reject(new Error('secret-canary late startup'));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(model?.resource.worker.stop).toHaveBeenCalledTimes(1);
  expect(fixture.close).not.toHaveBeenCalled();
  expect(fixture.lines.join('')).not.toContain('secret-canary');
});

test('classified retries are finite; arbitrary errors remain latched and no reconnect overlaps cleanup', async () => {
  let attempts = 0;
  const fixture = hostFixture(async () => { attempts += 1; throw new TransientConnectionError(); });
  await until(() => fixture.host.snapshot().reason === 'retry_exhausted');
  expect(attempts).toBe(3);
  expect(fixture.close).not.toHaveBeenCalled();
  expect(fixture.host.snapshot()).toMatchObject({ phase: 'paused', referenceReady: false, productionReady: false });
  fixture.signals.emit('SIGTERM');
  expect(await fixture.done).toBe(0);
});

test('channel reconnect waits for original resource closure, retains same ownership, then opens one replacement', async () => {
  const closed = deferred<void>();
  const models: ReturnType<typeof modelResource>[] = [];
  const fixture = hostFixture(async (_signal, fence) => {
    const model = modelResource(fence); models.push(model);
    if (models.length === 1) model.resource.close = () => closed.promise;
    return model.resource;
  });
  await until(() => fixture.host.snapshot().referenceReady);
  const first = models[0];
  if (!first) throw new Error('missing resource');
  first.status.accepting = false;
  first.status.reason = 'live_channel_lost';
  fixture.host.snapshot();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(models).toHaveLength(1);
  expect(fixture.close).not.toHaveBeenCalled();
  closed.resolve();
  await until(() => models.length === 2 && fixture.host.snapshot().referenceReady);
  fixture.signals.emit('SIGTERM');
  expect(await fixture.done).toBe(0);
});

test('unjoined connect timeout cannot grant retry authority; late rejection is observed', async () => {
  const pending = deferred<HostResource>();
  const connect = jest.fn(async () => pending.promise);
  const fixture = hostFixture(connect, 500, 20);
  await until(() => fixture.host.snapshot().reason === 'startup_timeout');
  expect(connect).toHaveBeenCalledTimes(1);
  pending.reject(new TransientConnectionError());
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(connect).toHaveBeenCalledTimes(1);
  fixture.signals.emit('SIGTERM');
  expect(await fixture.done).toBe(0);
});

test('retry full-jitter bounds cap and budget reset requires thirty seconds qualified stability', () => {
  const budget = new RetryBudget(3, () => 1);
  expect(budget.begin()).toBe(true); expect(budget.delay()).toBe(250);
  expect(budget.begin()).toBe(true); expect(budget.delay()).toBe(500);
  expect(budget.begin()).toBe(true); expect(budget.begin()).toBe(false);
  budget.observeStable(0, true); budget.observeStable(29999, true);
  expect(budget.begin()).toBe(false);
  budget.observeStable(30000, true); expect(budget.begin()).toBe(true);
  const capped = new RetryBudget(10, () => 1);
  for (let n = 0; n < 10; n += 1) capped.begin();
  expect(capped.delay()).toBe(5000);
  expect(new RetryBudget(3, () => 0).delay()).toBe(0);
});
