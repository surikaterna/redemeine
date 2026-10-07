import type { Event } from '@redemeine/kernel';
import { createDispatch } from './dispatch';
import { rejectLifecycle, requireSync, validateHandler } from './guards';
import { installMethods } from './methods';
import type { AggregateBase, BridgeableAggregate, BridgeCommand, BridgeConstructor, BridgeContext, BridgeOptions, CommandCreators, Dispatcher } from './types';

export function createDemeineBridge<S extends object, C extends CommandCreators, B extends AggregateBase>(
  builder: BridgeableAggregate<S, C>, options: BridgeOptions<S, B>,
): BridgeConstructor<S, C, B> {
  rejectLifecycle(builder);
  const dispatch = createDispatch(builder, options);
  // Erase only constructor services at the runtime boundary. Public services and the
  // full inherited instance remain those of B; initialState establishes S below.
  const Base = options.AggregateBase as unknown as new (
    sink: unknown, events: Dispatcher<S, Event>, commands: Dispatcher<S, BridgeCommand>,
  ) => BridgeContext<S>;
  class Bridge extends Base {
    constructor(sink?: unknown, events?: Dispatcher<S, Event> | null, commands?: Dispatcher<S, BridgeCommand> | null) {
      validateHandler(events, 'eventHandler');
      validateHandler(commands, 'commandHandler');
      const eventHandler = events == null ? { handle: dispatch.apply } : synchronousHandler(events);
      super(sink ?? undefined, eventHandler, commands ?? { handle: dispatch.process });
      this._state = structuredClone(builder.initialState);
      this.type = builder.aggregateType ?? Object.values(builder.types.commands)[0]?.split('.')[0] ?? 'unknown';
    }
  }
  installMethods(Bridge.prototype, builder, dispatch);
  // Generated methods are installed and collision-checked above, not visible to TS.
  return Bridge as unknown as BridgeConstructor<S, C, B>;
}

function synchronousHandler<S extends object>(handler: Dispatcher<S, Event>): Dispatcher<S, Event> {
  return {
    handle(aggregate, event) {
      return requireSync(handler.handle(aggregate, event), 'eventHandler');
    },
  };
}
