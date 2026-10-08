import { createAggregate } from '@redemeine/aggregate';
import { createDemeineBridge, type CommandSink, type CompatibleAggregate } from '@redemeine/demeine-interop';
import { createIdentity, type Event } from '@redemeine/kernel';

const built = createAggregate('counter', { count: 0 })
  .events({ added: (state, event: Event<{ amount: number }>) => { state.count += event.payload.amount; } })
  .commands(emit => ({
    add: { pack: (amount: number) => ({ amount }), handler: (_state: unknown, payload: { amount: number }) => emit.added(payload) },
    confirm: () => emit.added({ amount: 1 }),
    packed: { pack: () => undefined, handler: () => emit.added({ amount: 1 }) },
  }))
  .build();
const Counter = createDemeineBridge(built, { envelope: event => ({ ...event }) });
const sink: CommandSink<{ count: number }> = { sink: (command, aggregate) => aggregate._process(command) };
const aggregate: CompatibleAggregate = new Counter(sink);
const counter = new Counter(sink);
const rejected = new Counter(sink, { handle: () => Promise.reject(new Error('event rejected')) });
void rejected.add(1).then(
  () => { throw new Error('asynchronous event handler was accepted'); },
  error => {
    if (error.message !== 'eventHandler must be synchronous' || rejected.getVersion() !== 0) throw error;
  },
);
const unsafe = createAggregate('counter', { count: 0 })
  .events({ added: (state, _event: Event<Record<string, never>>) => { state.count++; } })
  // biome-ignore lint/suspicious/noThenProperty: Regression fixture must reject this promise-assimilation collision.
  .commands(emit => ({ then: { pack: () => ({}), handler: () => emit.added({}) } }))
  .build();
try {
  createDemeineBridge(unsafe);
  throw new Error('then shortcut was accepted');
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'Legacy method collision: then') throw error;
}
const count: number = counter._state.count;
void count;
void aggregate;
if (typeof createIdentity() !== 'string') throw new Error('kernel export failed');
void counter.add(4).then(async result => {
  if (result !== counter) throw new Error('queued result lost aggregate identity');
  const initialCount = counter._state.count;
  if (initialCount !== 4 || counter.getVersion() !== 1) throw new Error('legacy lifecycle failed');
  if (await counter.confirm() !== counter || await counter.packed() !== counter) throw new Error('no-payload shortcut result failed');
  if (counter._state.count !== 6 || counter.getVersion() !== 3) throw new Error('no-payload shortcut evolution failed');
  console.log('qualified counter', counter._state.count);
});
