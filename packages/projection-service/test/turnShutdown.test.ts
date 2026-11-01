import { createReferenceRuntime, waitForModelTurn } from '../src/reference/runtime';
import { firstSource, modelCommit } from '../src/reference/scenario';
import { builtArtifact, referenceConfig } from './fixtures';
import { deferred, until } from './support/deferred';
import { hostFixture } from './support/hostFixture';

test.each(['live', 'recovery'])('host fences actual .2 %s turn and joins late completion before releasing ownership', async (kind) => {
  const artifact = await builtArtifact();
  const pending = deferred<void>();
  let blocked = false;
  let runtime: ReturnType<typeof createReferenceRuntime> | undefined;
  const fixture = hostFixture(async (_signal, fence) => {
    const active = createReferenceRuntime(artifact, referenceConfig, [modelCommit(42), modelCommit(43), modelCommit(44)], {
      wrapEvidence: (port) => fence.wrap(port), result: () => {}
    });
    runtime = active;
    const save = active.store.commitProjectionSourceCommit.bind(active.store);
    active.store.commitProjectionSourceCommit = async (request) => {
      if (kind === 'live') { blocked = true; await pending.promise; }
      return save(request);
    };
    const read = active.reader.readCompleteRange.bind(active.reader);
    active.reader.readCompleteRange = async (request) => {
      if (kind === 'recovery' && request.throughSequence === 43) { blocked = true; await pending.promise; }
      return read(request);
    };
    return { worker: active.worker, close: () => active.channel.close(), async start() {
      await active.worker.start(active.channel);
      active.channel.deliver();
      await waitForModelTurn(active.worker);
      if (kind === 'live') return;
      const floor = await active.sourceOrder.load(firstSource, active.start.epoch);
      if (!floor) throw new Error('missing floor');
      await active.coordinator.process(modelCommit(44), floor, () => { if (!fence.current()) throw new Error('stopped'); });
    } };
  }, 1000);
  await until(() => blocked);
  fixture.signals.emit('SIGTERM');
  expect(fixture.close).not.toHaveBeenCalled();
  expect(fixture.host.snapshot().referenceReady).toBe(false);
  pending.resolve();
  expect(await fixture.done).toBe(0);
  if (!runtime) throw new Error('missing runtime');
  expect(await runtime.sourceOrder.load(firstSource, runtime.start.epoch)).toMatchObject({ coveredThrough: kind === 'live' ? null : 42 });
  expect(runtime.channel.acknowledgements).toBe(kind === 'live' ? 0 : 1);
  expect(runtime.store.count('model:inline-counter')).toBe(1);
  expect(runtime.store.count('model:own-counter')).toBe(kind === 'live' ? null : 1);
  expect(fixture.close).toHaveBeenCalledTimes(1);
});

test('actual .2 start remains joined after worker.stop reports drained, until late consume settles', async () => {
  const artifact = await builtArtifact();
  const pending = deferred<void>();
  let entered = false;
  let stopped = false;
  const fixture = hostFixture(async (_signal, fence) => {
    const runtime = createReferenceRuntime(artifact, referenceConfig, [modelCommit(42)], {
      wrapEvidence: (port) => fence.wrap(port), result: () => {}
    });
    const consume = runtime.channel.consume.bind(runtime.channel);
    runtime.channel.consume = async (...args) => { entered = true; await pending.promise; return consume(...args); };
    const stop = runtime.worker.stop.bind(runtime.worker);
    runtime.worker.stop = async () => {
      const result = await stop();
      expect(result.drained).toBe(true);
      stopped = true;
      return result;
    };
    return { worker: runtime.worker, start: () => runtime.worker.start(runtime.channel), close: () => runtime.channel.close() };
  }, 1000);
  await until(() => entered);
  fixture.signals.emit('SIGTERM');
  await until(() => stopped);
  expect(fixture.close).not.toHaveBeenCalled();
  pending.resolve();
  expect(await fixture.done).toBe(0);
  expect(fixture.close).toHaveBeenCalledTimes(1);
});
