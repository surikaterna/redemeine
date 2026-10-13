import type { ResolveEventName } from '@redemeine/aggregate';
import { createAggregate, namingStrategies } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const defaultName: Equal<ResolveEventName<'order', 'itemAdded', {}>, 'order.item_added.event'> = true;
const overrideName: Equal<ResolveEventName<'order', 'itemAdded', { itemAdded: 'custom.event' }>, 'custom.event'> = true;
const digitName: Equal<ResolveEventName<'order', 'item2Added', {}>, 'order.item2_added.event'> = true;
const consecutiveDigits: Equal<ResolveEventName<'order', 'v22Changed', {}>, 'order.v22_changed.event'> = true;
const separatorName: Equal<ResolveEventName<'order', 'item_Added', {}>, 'order.item_added.event'> = true;
const digitOverride: Equal<ResolveEventName<'order', 'item2Added', { item2Added: 'legacy.event' }>, 'legacy.event'> = true;
void [defaultName, overrideName, digitName, consecutiveDigits, separatorName, digitOverride];

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
