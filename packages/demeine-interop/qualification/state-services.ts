import { createAggregate } from '@redemeine/aggregate';
import { createDemeineBridge, type Command, type CommandHandler, type CommandSink,
  type CompatibleAggregateConstructor, type Event, type EventHandler } from '@redemeine/demeine-interop';
import type { Command as KernelCommand, Event as KernelEvent } from '@redemeine/kernel';

type State = { count: number };
const builder = createAggregate('counter', { count: 0 })
  .events({ added: (state, event: { payload: { amount: number } }) => { state.count += event.payload.amount; } })
  .commands(emit => ({ add: { pack: (amount: number) => ({ amount }), handler: (_state: unknown, payload: { amount: number }) => emit.added(payload) } }))
  .build();
const Counter = createDemeineBridge(builder);
const Base: CompatibleAggregateConstructor<State> = Counter;
const headers = { trace: 'application-specific' };
const metadata = { command: { id: 'origin' } };
const calls: string[] = [];
const events: EventHandler<State> = { handle(aggregate, event) {
  const link: unknown = event.metadata?.command;
  if (link !== metadata.command || event.headers !== headers) throw new Error('event fields were not preserved');
  aggregate._state.count += 2;
  calls.push('event');
} };
const commands: CommandHandler<State> = { handle(aggregate, command) {
  if (command.metadata !== metadata || command.headers !== headers) throw new Error('command fields were not preserved');
  const event: Event = { type: 'counter.added.event', aggregateId: aggregate.id, payload: {}, headers: command.headers, metadata: command.metadata };
  const kernelEvent: KernelEvent<object, string> = event;
  const neutralEvent: Event = kernelEvent;
  void neutralEvent;
  calls.push('command');
  aggregate._apply(event, true);
  return aggregate;
} };
const sink: CommandSink<State> = { sink(command, aggregate) {
  const trace: unknown = command.headers?.trace;
  if (trace !== headers.trace || command.metadata !== metadata) throw new Error('sink fields were not preserved');
  const kernelCommand: KernelCommand<object, string> = command;
  const neutralCommand: Command = kernelCommand;
  void neutralCommand;
  calls.push('sink');
  return aggregate._process(command);
} };

async function namedServices() {
  for (const Constructor of [Counter, Base]) {
    const aggregate = new Constructor(sink, events, commands);
    const result = await aggregate._sink({ id: 'command', type: 'counter.add.command', aggregateId: aggregate.id, payload: {}, headers, metadata });
    if (result !== aggregate || aggregate._state.count !== 2 || aggregate.getVersion() !== 1) throw new Error('typed service lifecycle');
    if (aggregate.getUncommittedEvents()[0]?.metadata !== metadata) throw new Error('buffer metadata identity');
  }
  if (calls.join(',') !== 'sink,command,event,sink,command,event') throw new Error('service invocation order');
}

async function inlineServices() {
  const generated = new Counter(undefined, { handle(aggregate) { aggregate._state.count++; } }, {
    handle(aggregate) { aggregate._state.count++; return aggregate; },
  });
  const authored = new Base(undefined, { handle(aggregate) { aggregate._state.count++; } }, {
    handle(aggregate) { aggregate._state.count++; return aggregate; },
  });
  await generated.add(1);
  await authored._process({ type: 'counter.add.command', payload: {} });
  if (generated._state.count !== 1 || authored._state.count !== 1) throw new Error('inline state inference');
}
void namedServices().then(inlineServices).then(() => console.log('typed state services and message fields qualified'));
