import type { ResolveEventName } from '@redemeine/aggregate';
import { createAggregate, namingStrategies } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const defaultName: Equal<ResolveEventName<'order', 'itemAdded', {}>, 'order.item_added.event'> = true;
const overrideName: Equal<ResolveEventName<'order', 'itemAdded', { itemAdded: 'custom.event' }>, 'custom.event'> = true;
void [defaultName, overrideName];

const aggregate = createAggregate('order', { items: [] as string[] })
  .events({
    itemAdded: (state, event: Event<string>) => {
      state.items.push(event.payload);
    }
  })
  .commands((emit) => ({ addItem: (_state, item: string) => emit.itemAdded(item) }))
  .build();

aggregate.commandCreators.addItem('item');
aggregate.eventCreators.itemAdded('item');
// @ts-expect-error Known command argument must be a string.
aggregate.commandCreators.addItem(123);

const targeted = createAggregate('order', { items: [] as string[] })
  .naming(namingStrategies.targeted)
  .events({
    itemAdded: (state, event: Event<string>) => {
      state.items.push(event.payload);
    }
  })
  .build();
void targeted;
