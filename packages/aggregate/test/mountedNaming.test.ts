import { commandMetadata, createAggregate, createEntity, createMixin } from '../src';
import type { Event } from '@redemeine/kernel';

const identifier = createEntity('identifier', { id: '', value: '' })
  .events({ registered(state, event: Event<{ id: string; value: string }>) { state.value = event.payload.value; } })
  .commands(emit => ({ register(_state, payload: { id: string; value: string }) { return emit.registered(payload); } }), { static: ['register'] })
  .build();

test('mounted semantic names are independent from navigation and root command names', () => {
  const host = createAggregate('party', { identifiers: [] as { id: string; value: string }[] })
    .commands(() => ({ registerIdentifier() { return []; } }))
    .entityList('identifiers', identifier).build();
  expect(host.types.commands.registerIdentifier).toBe('party.register_identifier.command');
  expect(host.types.commands.identifiersRegister).toBe('party.identifier.register.command');
  const [event] = host.process(host.initialState, host.commandCreators.identifiersRegister({ id: 'i', value: 'v' }));
  expect(event!.type).toBe('party.identifier.registered.event');
  expect(host.apply(host.initialState, event!).identifiers).toEqual([{ id: 'i', value: 'v' }]);
});

test('nested semantic paths preserve every entity segment', () => {
  const customer = createEntity('customer', { id: '', identifiers: [] as { id: string; value: string }[] })
    .entityList('identifiers', identifier).build();
  const host = createAggregate('party', { customers: [{ id: 'c', identifiers: [] as { id: string; value: string }[] }] })
    .entityList('customers', customer).build();
  expect(host.types.commands.customersIdentifiersRegister).toBe('party.customer.identifier.register.command');
  const [event] = host.process(host.initialState,
    host.commandCreators.customersIdentifiersRegister({ customersId: 'c', id: 'i', value: 'v' }));
  expect(event!.type).toBe('party.customer.identifier.registered.event');
  expect(host.apply(host.initialState, event!).customers[0]!.identifiers).toEqual([{ id: 'i', value: 'v' }]);
});

test('aliases preserve authored segments, member formatting, metadata and registration-local emitters', () => {
  const host = createAggregate('party', { left: [] as { id: string; value: string }[], right: [] as { id: string; value: string }[] })
    .entityList('left', identifier, {}, { semanticName: 'externalID', eventNameOverrides: { registered: 'left.wire.event' } })
    .entityList('right', identifier, {}, { semanticName: 'otherID', eventNameOverrides: { registered: 'right.wire.event' } }).build();
  expect(host.types.commands.leftRegister).toBe('party.externalID.register.command');
  expect(host.types.commands.rightRegister).toBe('party.otherID.register.command');
  for (const side of ['left', 'right'] as const) {
    const local = `${side}Register` as const;
    const [event] = host.process(host.initialState, host.commandCreators[local]({ id: 'i', value: side }));
    expect(event!.type).toBe(`${side}.wire.event`);
    expect(Object.values(host.types.events)).toContain(event!.type);
    expect(Object.hasOwn(host.metadata.events, event!.type)).toBe(true);
    expect(commandMetadata(host, local)!.wireType).toBe(host.types.commands[local]);
    expect(host.apply(host.initialState, event!)[side]).toEqual([{ id: 'i', value: side }]);
  }
});

test('relative entity overrides and full mount overrides keep their origin through nesting', () => {
  const leaf = createEntity('leaf', { id: '' }).events({ changed() {} })
    .overrideEventNames({ changed: 'revision' })
    .commands(emit => ({ change(_state, payload: { id: string }) { return emit.changed(payload); } }), { static: ['change'] })
    .overrideCommandNames({ change: 'revise' }).build();
  const parent = createEntity('parent', { id: '', leaves: [] as { id: string }[] })
    .entityList('leaves', leaf, {}, { semanticName: 'leafAlias' }).build();
  const builder = createAggregate('party', { parents: [{ id: 'p', leaves: [] as { id: string }[] }] })
    .entityList('parents', parent, {}, { semanticName: 'parentAlias' });
  const host = builder.build();
  expect(host.types.commands.parentsLeavesChange).toBe('party.parentAlias.leafAlias.revise.command');
  expect(host.process(host.initialState, host.commandCreators.parentsLeavesChange({ parentsId: 'p', id: 'i' }))[0]!.type)
    .toBe('party.parentAlias.leafAlias.revision.event');
  expect(builder.build().types).toEqual(host.types);
  const ancestor = createEntity('parent', { id: '', leaves: [] as { id: string }[] })
    .entityList('leaves', leaf, {}, { commandNameOverrides: { change: 'inner.full.command' }, eventNameOverrides: { changed: 'inner.full.event' } })
    .overrideCommandNames({ leavesChange: 'ancestor.command' }).overrideEventNames({ leavesChanged: 'ancestor.event' }).build();
  const ancestorHost = createAggregate('party', { parents: [{ id: 'p', leaves: [] as { id: string }[] }] })
    .entityList('parents', ancestor).build();
  expect(ancestorHost.types.commands.parentsLeavesChange).toBe('party.parent.ancestor.command');
  expect(ancestorHost.process(ancestorHost.initialState,
    ancestorHost.commandCreators.parentsLeavesChange({ parentsId: 'p', id: 'i' }))[0]!.type).toBe('party.parent.ancestor.event');
  const full = createAggregate('party', { parents: [{ id: 'p', leaves: [] as { id: string }[] }] })
    .entityList('parents', ancestor, {}, { commandNameOverrides: { leavesChange: 'outer.command' }, eventNameOverrides: { leavesChanged: 'outer.event' } }).build();
  expect(full.types.commands.parentsLeavesChange).toBe('outer.command');
  expect(full.process(full.initialState, full.commandCreators.parentsLeavesChange({ parentsId: 'p', id: 'i' }))[0]!.type).toBe('outer.event');
});

test('custom strategies receive authored leaf members and complete semantic paths through mixins', () => {
  const args: unknown[][] = [];
  const leaf = createEntity('multiWord', { id: '' }).events({ itemAdded() {} })
    .commands(emit => ({ addItem(_state, payload: { id: string }) { return emit.itemAdded(payload); } }), { static: ['addItem'] }).build();
  const mixin = createMixin<{ rows: { id: string }[] }>().entityList('rows', leaf, {}, { semanticName: 'AuthoredAlias' }).build();
  const host = createAggregate('party', { rows: [] as { id: string }[] }).mixins(mixin)
    .naming({ command: (aggregate, member, path) => { args.push([aggregate, member, path]); return `${aggregate}.${path}.${member}.command`; },
      event: (aggregate, member, path) => { args.push([aggregate, member, path]); return `${aggregate}.${path}.${member}.event`; } }).build();
  expect(host.types.commands.rowsAddItem).toBe('party.AuthoredAlias.addItem.command');
  expect(args).toContainEqual(['party', 'addItem', 'AuthoredAlias']);
  expect(args).toContainEqual(['party', 'itemAdded', 'AuthoredAlias']);
  expect(host.process(host.initialState, host.commandCreators.rowsAddItem({ id: 'i' }))[0]!.type).toBe('party.AuthoredAlias.itemAdded.event');
});

test.each(['', ' ', 'two.segments'])('invalid semantic alias %j rejects before invoking a command factory', semanticName => {
  const factory = jest.fn(() => ({}));
  const leaf = createEntity('leaf', { id: '' }).commands(factory).build();
  expect(() => createAggregate('party', { rows: [] as { id: string }[] }).entityList('rows', leaf, {}, { semanticName }).build())
    .toThrow('Entity semanticName');
  expect(factory).not.toHaveBeenCalled();
});

test('same semantic default deliberately shares a wire and the last registration wins', () => {
  const host = createAggregate('party', { left: [] as { id: string; value: string }[], right: [] as { id: string; value: string }[] })
    .entityList('left', identifier).entityList('right', identifier).build();
  expect(host.types.commands.leftRegister).toBe('party.identifier.register.command');
  expect(host.types.commands.rightRegister).toBe(host.types.commands.leftRegister);
  for (const creator of [host.commandCreators.leftRegister, host.commandCreators.rightRegister]) {
    const [event] = host.process(host.initialState, creator({ id: 'i', value: 'winner' }));
    expect(event!.type).toBe('party.identifier.registered.event');
    expect(host.apply(host.initialState, event!)).toEqual({ left: [], right: [{ id: 'i', value: 'winner' }] });
  }
  expect(commandMetadata(host, 'leftRegister')!.winnerLocalName).toBe('rightRegister');
});

test('same semantic path with explicit wires does not share emitter lookup tables', () => {
  const host = createAggregate('party', { left: [] as { id: string; value: string }[], right: [] as { id: string; value: string }[] })
    .entityList('left', identifier, {}, { commandNameOverrides: { register: 'left.command' }, eventNameOverrides: { registered: 'left.event' } })
    .entityList('right', identifier, {}, { commandNameOverrides: { register: 'right.command' }, eventNameOverrides: { registered: 'right.event' } }).build();
  for (const side of ['left', 'right'] as const) {
    const [event] = host.process(host.initialState, host.commandCreators[`${side}Register`]({ id: 'i', value: side }));
    expect(event!.type).toBe(`${side}.event`);
    expect(host.apply(host.initialState, event!)[side]).toEqual([{ id: 'i', value: side }]);
    expect(Object.values(host.types.events)).toContain(event!.type);
  }
});

test.each([true, false])('repeated mounts keep winning event metadata with its projector and target (metadata=%s)', withMetadata => {
  const projector = (state: { id: string; value: string }) => { state.value = 'left'; };
  const left = createEntity('item', { id: '', value: '' }).events({ changed: {
    projector, ...(withMetadata ? { meta: { owner: 'left' } } : {})
  } }).build();
  const right = createEntity('item', { id: '', value: '' }).events({ changed: {
    projector(state) { state.value = 'right'; }, meta: { owner: 'right' }
  } }).build();
  const builder = createAggregate('party', { left: [] as { id: string; value: string }[], right: [] as { id: string; value: string }[] })
    .entityList('left', left).entityList('right', right).entityList('left', left);
  for (const host of [builder.build(), builder.build()]) {
    const event = { type: 'party.item.changed.event', payload: { id: 'i' } };
    expect(host.apply(host.initialState, event)).toEqual({ left: [{ id: 'i', value: 'left' }], right: [] });
    expect(host.pure.eventProjectors.changed).toBe(projector);
    expect(host.types.events['left:changed']).toBe(event.type);
    expect(host.types.events['right:changed']).toBe(event.type);
    expect(host.metadata.events[event.type]).toEqual(withMetadata ? { meta: { owner: 'left' } } : {});
  }
});

test('full inner overrides remain verbatim without an ancestor override', () => {
  const parent = createEntity('customer', { id: '', identifiers: [] as { id: string; value: string }[] })
    .entityList('identifiers', identifier, {}, { commandNameOverrides: { register: 'unprefixed' }, eventNameOverrides: { registered: 'also.unprefixed' } }).build();
  const host = createAggregate('party', { customers: [{ id: 'c', identifiers: [] as { id: string; value: string }[] }] })
    .entityList('customers', parent).build();
  expect(host.types.commands.customersIdentifiersRegister).toBe('unprefixed');
  expect(host.process(host.initialState, host.commandCreators.customersIdentifiersRegister({ customersId: 'c', id: 'i', value: 'v' }))[0]!.type)
    .toBe('also.unprefixed');
});

test('aggregate command overrides still take precedence over derived mounted defaults', () => {
  const host = createAggregate('party', { identifiers: [] as { id: string; value: string }[] })
    .entityList('identifiers', identifier).overrideCommandNames({ identifiersRegister: 'custom.command' }).build();
  expect(host.commandCreators.identifiersRegister({ id: 'i', value: 'v' }).type).toBe('custom.command');
  const [event] = host.process(host.initialState, host.commandCreators.identifiersRegister({ id: 'i', value: 'v' }));
  expect(event!.type).toBe('party.identifier.registered.event');
});

test('default member formatting is snake_case while authored entity spelling stays intact', () => {
  const leaf = createEntity('ExternalID', { id: '' }).events({ itemAdded() {} })
    .commands(emit => ({ addItem(_state, payload: { id: string }) { return emit.itemAdded(payload); } }), { static: ['addItem'] }).build();
  const host = createAggregate('party', { navigation: [] as { id: string }[] }).entityList('navigation', leaf).build();
  expect(host.types.commands.navigationAddItem).toBe('party.ExternalID.add_item.command');
  expect(host.process(host.initialState, host.commandCreators.navigationAddItem({ id: 'i' }))[0]!.type).toBe('party.ExternalID.item_added.event');
  expect(() => host.process(host.initialState, { type: 'party.navigation_add_item.command', payload: { id: 'i' } })).toThrow();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(host.apply(host.initialState, { type: 'party.navigation.item_added.event', payload: { id: 'i' } })).toBe(host.initialState);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});
