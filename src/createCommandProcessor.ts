import { Command } from './createCommand';
import { Event } from './createEvent';

//order.cancel.command -> order.cancelled.event

export function createCommandProcessor<S, C extends Command>(command: C): Event<C['payload']> {
  return {
    type: 'a.b.event',
    payload: undefined
  };
}
