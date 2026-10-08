import { Aggregate, Repository, type CommandSink as LegacySink, type CommandHandler as LegacyCommands, type EventHandler as LegacyEvents, type Partition } from 'demeine';
import type { Constructor } from '@surikat/factory/lib/types';
import { createAggregate } from '@redemeine/aggregate';
import { createDemeineBridge, type CompatibleAggregateConstructor } from '@redemeine/demeine-interop';

const builder = createAggregate('counter', { count: 0 })
  .events({ added: (state, event: { payload: { amount: number } }) => { state.count += event.payload.amount; } })
  .commands(emit => ({ add: { pack: (amount: number) => ({ amount }), handler: (_state: unknown, payload: { amount: number }) => emit.added(payload) } }))
  .build();
const Base: CompatibleAggregateConstructor<{ count: number }> = createDemeineBridge(builder);
class Authored extends Base {
  add(payload: { amount: number }) {
    return this._sink({ ...builder.commandCreators.add(payload.amount), aggregateId: this.id });
  }
}

export function compatibility(partition: Partition<Authored>, sink: LegacySink<{ count: number }>, events: LegacyEvents, commands: LegacyCommands) {
  const factoryConstructor: Constructor<Aggregate> = Authored;
  const aggregate: Aggregate<{ count: number }> = new Authored(sink, events, commands);
  const repository: Repository<Authored> = new Repository(partition, 'counter', id => {
    const instance = new Authored(sink, events, commands);
    instance.id = id;
    return instance;
  });
  const generated = createDemeineBridge(builder);
  const generatedConstructor: Constructor<Aggregate> = generated;
  void factoryConstructor;
  void generatedConstructor;
  void aggregate;
  return { read: repository.findById('counter'), save: repository.save(new Authored(sink, events, commands)) };
}
