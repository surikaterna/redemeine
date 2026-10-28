import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge, type BridgeOptions, type BridgeableAggregate,
  type CommandSink, type EventHandler, type CommandHandler,
} from '@redemeine/demeine-interop';

function assert(value: boolean): asserts value {
  if (!value) throw new Error('Packed bridge contract failed');
}

const built = createAggregate('declared', { count: 0 })
  .events({ incremented: (state, _event: Event<{}>) => { state.count++; } })
  .commands(emit => ({ increment: () => emit.incremented({}) })).build();
const Bridge = createDemeineBridge(built);
const sink: CommandSink<{ count: number }> = { sink: (command, aggregate) => aggregate._process(command) };
const events: EventHandler<{ count: number }> = { handle: () => {} };
const commands: CommandHandler = { handle: aggregate => aggregate };
new Bridge(sink, events, commands);
const live = new Bridge();
assert(live.type === 'declared');
const broader: BridgeableAggregate<{ count: number }, typeof built.commandCreators> = built;
new (createDemeineBridge(broader))();
type Assert<T extends true> = T;
export type PublicContracts = [
  Assert<'AggregateBase' extends keyof BridgeOptions<{}> ? false : true>,
  Assert<{} extends Pick<typeof broader, 'aggregateType'> ? false : true>,
  Assert<0 extends (1 & typeof Bridge) ? false : true>,
];
const { aggregateType: _aggregateType, ...missing } = built;
if (false) {
  // @ts-expect-error explicit type is mandatory through public declarations
  createDemeineBridge(missing);
  // @ts-expect-error obsolete option is absent through public declarations
  createDemeineBridge(built, { AggregateBase: class {} });
}
for (const aggregateType of [undefined, '', '   ', 1]) {
  let rejected = false;
  try { Reflect.apply(createDemeineBridge, undefined, [{ ...built, aggregateType }]); }
  catch (error) { rejected = error instanceof TypeError && error.message === 'aggregateType must be a nonempty string'; }
  assert(rejected);
}
void live.increment().then(() => assert(live._state.count === 1));

const identities = new WeakMap<object, string>();
let closure = 'before';
class Definition {
  #tag = 'private';
  field = 'original';
  pack(id: string) { return { id, tag: this.#tag, identity: identities.get(this), field: this.field, closure }; }
  handler() { return []; }
}
const definition = new Definition();
identities.set(definition, 'original identity');
const receiverHost = createAggregate('receiver', {}).commands(() => ({ set: definition })).build();
definition.field = 'live';
closure = 'after';
const payload = receiverHost.commandCreators.set('one').payload;
assert(payload.tag === 'private' && payload.identity === 'original identity');
assert(payload.field === 'live' && payload.closure === 'after');
void new (createDemeineBridge(receiverHost))().set('two');
