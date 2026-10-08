import { createDispatch } from './dispatch';
import { rejectLifecycle, requireSync, validateHandler } from './guards';
import { installMethods } from './methods';
import { StandaloneAggregate } from './StandaloneAggregate';
import type { CommandHandler, CommandSink, EventHandler } from './lifecycleTypes';
import type { BridgeableAggregate, BridgeConstructor, BridgeOptions, CommandCreators } from './types';

export function createDemeineBridge<S extends object, C extends CommandCreators>(
  builder: BridgeableAggregate<S, C>, options: BridgeOptions<S> = {},
): BridgeConstructor<S, C> {
  if ('AggregateBase' in options) throw new TypeError('AggregateBase is no longer supported; the bridge owns its lifecycle');
  rejectLifecycle(builder);
  const dispatch = createDispatch(builder, options);
  class Bridge extends StandaloneAggregate<S> {
    constructor(sink?: CommandSink<S> | null, events?: EventHandler | null, commands?: CommandHandler | null) {
      validateHandler(events, 'eventHandler');
      validateHandler(commands, 'commandHandler');
      const eventHandler = events == null ? { handle: dispatch.apply } : synchronousHandler(events);
      super(builder.initialState, sink, eventHandler, commands ?? { handle: dispatch.process });
      this.type = builder.aggregateType ?? Object.values(builder.types.commands)[0]?.split('.')[0] ?? 'unknown';
    }
  }
  installMethods(Bridge.prototype, builder, dispatch);
  // Generated methods are installed and collision-checked above, not visible to TS.
  return Bridge as BridgeConstructor<S, C>;
}

function synchronousHandler(handler: EventHandler): EventHandler {
  return {
    handle(aggregate, event) {
      return requireSync(handler.handle(aggregate, event), 'eventHandler');
    },
  };
}
