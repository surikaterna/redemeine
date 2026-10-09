import type { ResolveEventName } from '@redemeine/aggregate';
import { createAggregate, createMixin, defaultNamingStrategy, namingStrategies } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const defaultName: Equal<ResolveEventName<'order', 'itemAdded', {}>, 'order.item_added.event'> = true;
const multiwordName: Equal<ResolveEventName<'order', 'orderLineAdded', {}>, 'order.order_line_added.event'> = true;
const overrideName: Equal<ResolveEventName<'order', 'itemAdded', { itemAdded: 'legacy.item.event' }>, 'legacy.item.event'> = true;
const acronymName: Equal<ResolveEventName<'order', 'itemURL2Changed', {}>, 'order.item_url2_changed.event'> = true;
void [defaultName, multiwordName, overrideName, acronymName];

const initial = { items: [] as string[], count: 0 };

const createOrder = (strategy?: typeof namingStrategies.targeted) => {
  const builder = createAggregate('order', initial)
    .events({
      itemAdded: (state, event: Event<string>) => {
        state.items.push(event.payload);
      }
    })
    .commands((emit) => ({ addItem: (_state, item: string) => emit.itemAdded(item) }));
  return (strategy ? builder.naming(strategy) : builder).build();
};

describe('aggregate event naming defaults', () => {
  test('flat snake_case is the default, independent of the targeted preset', () => {
    expect(namingStrategies.targeted).not.toBe(defaultNamingStrategy);
    expect(namingStrategies.targeted.event).not.toBe(defaultNamingStrategy.event);
    expect(namingStrategies.snakeCase.event('order', 'itemAdded')).toBe(defaultNamingStrategy.event('order', 'itemAdded'));
    expect(namingStrategies.flat.event('order', 'itemAdded')).toBe('order.itemAdded.event');
    const aggregate = createOrder();
    const command = aggregate.commandCreators.addItem('first');
    expect(command.type).toBe('order.add_item.command');
    expect(aggregate.types.events.itemAdded).toBe('order.item_added.event');
    const [event] = aggregate.process(initial, command);
    expect(event.type).toBe('order.item_added.event');
    expect(aggregate.apply(initial, event).items).toEqual(['first']);
    const draft = { items: [] as string[], count: 0 };
    aggregate.applyToDraft(draft, { type: 'order.item_added.event', payload: 'replayed' });
    expect(draft.items).toEqual(['replayed']);
    expect(initial.items).toEqual([]);
  });

  test('explicit targeted retains old dot path for emit and replay', () => {
    const aggregate = createOrder(namingStrategies.targeted);
    expect(aggregate.types.events.itemAdded).toBe('order.item.added.event');
    expect(aggregate.commandCreators.addItem('one').type).toBe('order.add_item.command');
    expect(aggregate.process(initial, aggregate.commandCreators.addItem('one'))[0].type).toBe('order.item.added.event');
    expect(aggregate.apply(initial, { type: 'order.item.added.event', payload: 'old' }).items).toEqual(['old']);
  });

  test('custom strategy and explicit overrides take priority over defaults', () => {
    const custom = createAggregate('order', initial)
      .naming({ event: (_name, key) => `custom.${key}.event` })
      .events({
        itemAdded: (state, event: Event<string>) => {
          state.items.push(event.payload);
        }
      })
      .commands((emit) => ({ addItem: (_state, item: string) => emit.itemAdded(item) }))
      .build();
    expect(custom.types.events.itemAdded).toBe('custom.itemAdded.event');
    expect(custom.process(initial, custom.commandCreators.addItem('new'))[0].type).toBe('custom.itemAdded.event');
    expect(custom.apply(initial, { type: 'custom.itemAdded.event', payload: 'old' }).items).toEqual(['old']);
    const aggregate = createAggregate('order', initial)
      .naming({ event: (_name, key) => `custom.${key}.event` })
      .events({
        itemAdded: (state, event: Event<string>) => {
          state.items.push(event.payload);
        }
      })
      .overrideEventNames({ itemAdded: 'explicit.item.event' })
      .commands((emit) => ({ addItem: (_state, item: string) => emit.itemAdded(item) }))
      .build();
    expect(aggregate.types.events.itemAdded).toBe('explicit.item.event');
    expect(aggregate.process(initial, aggregate.commandCreators.addItem('new'))[0].type).toBe('explicit.item.event');
    expect(aggregate.apply(initial, { type: 'explicit.item.event', payload: 'old' }).items).toEqual(['old']);
    expect(aggregate.commandCreators.addItem('new').type).toBe('order.add_item.command');
  });

  test('mixin inherited keys use default unless explicitly overridden', () => {
    const mixin = createMixin<typeof initial>()
      .events({
        itemAdded: (state, event: Event<string>) => {
          state.items.push(event.payload);
        }
      })
      .commands((emit) => ({ addItem: (_state, item: string) => emit.itemAdded(item) }))
      .build();
    const aggregate = createAggregate('order', initial).mixins(mixin).build();
    expect(aggregate.types.events.itemAdded).toBe('order.item_added.event');
    expect(aggregate.commandCreators.addItem('m').type).toBe('order.add_item.command');
    const event = aggregate.process(initial, aggregate.commandCreators.addItem('m'))[0];
    expect(event.type).toBe('order.item_added.event');
    expect(aggregate.apply(initial, event).items).toEqual(['m']);
    const overridden = createAggregate('order', initial).mixins(mixin).overrideEventNames({ itemAdded: 'manual.item.event' }).build();
    expect(overridden.process(initial, overridden.commandCreators.addItem('m'))[0].type).toBe('manual.item.event');
    expect(overridden.apply(initial, { type: 'manual.item.event', payload: 'replayed' }).items).toEqual(['replayed']);
  });
});
