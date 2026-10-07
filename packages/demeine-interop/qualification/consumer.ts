import { Aggregate, type CommandSink } from 'demeine';
import { createAggregate } from '@redemeine/aggregate';
import { createDemeineBridge } from '@redemeine/demeine-interop';
import { createIdentity, type Event } from '@redemeine/kernel';

const built = createAggregate('counter', { count: 0 })
  .events({ added: (state, event: Event<{ amount: number }>) => { state.count += event.payload.amount; } })
  .commands(emit => ({ add: { pack: (amount: number) => ({ amount }), handler: (_state: unknown, payload: { amount: number }) => emit.added(payload) } }))
  .build();
const Counter = createDemeineBridge(built, { AggregateBase: Aggregate, envelope: event => ({ ...event }) });
const sink: CommandSink = { sink: (command, aggregate) => aggregate._process(command) };
const aggregate: InstanceType<typeof Aggregate> = new Counter(sink);
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
  createDemeineBridge(unsafe, { AggregateBase: Aggregate });
  throw new Error('then shortcut was accepted');
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'Legacy method collision: then') throw error;
}
const count: number = counter._state.count;
void count;
void aggregate;
if (typeof createIdentity() !== 'string') throw new Error('kernel export failed');
if (!(counter instanceof Aggregate)) throw new Error('supplied base identity lost');
void counter.add(4).then(() => {
  if (counter._state.count !== 4 || counter.getVersion() !== 1) throw new Error('legacy lifecycle failed');
  console.log('qualified counter', counter._state.count);
});
