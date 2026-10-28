import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandMetadata, createAggregate, createEntity, createMixin } from '../src';

test('only declared flat creators exist; protocol lookups do not manufacture commands', async () => {
  const row = createEntity<{ id: string }, 'row'>('row').commands(() => ({ read: (_state, _payload: { id: string }) => [] })).build();
  const built = createAggregate('store', { rows: [{ id: 'a' }] }).entityList('rows', row)
    .commands(() => ({ root: () => [] })).build();
  for (const host of [built, built.withPlugins()]) {
    expect(Reflect.get(host.pure, 'commandTargets')).toBeUndefined();
    expect(Object.hasOwn(host.pure, 'commandTargets')).toBe(false);
    for (const key of ['rows', 'missing', 'then', 'toJSON', 'constructor', '__proto__', Symbol.iterator, Symbol.toStringTag]) {
      expect(Reflect.get(host.commandCreators, key)).toBeUndefined();
    }
    expect(await Promise.resolve(host.commandCreators)).toBe(host.commandCreators);
    expect(Object.keys(host.commandCreators).sort()).toEqual(['root', 'rowsRead']);
    expect(host.process(host.initialState, host.commandCreators.root())).toEqual([]);
    expect(host.process(host.initialState, host.commandCreators.rowsRead({ id: 'a' }))).toEqual([]);
    expect(commandMetadata(host, 'rowsRead')!.targets).toMatchObject([{ statePath: ['rows'] }]);
  }
});

test.each(['direct', 'component'] as const)('%s mounts ignore retired aliases and preserve modern and definition wire overrides', kind => {
  const row = createEntity<{ id: string; qty: number }, 'row'>('row')
    .events({ changed: (state, event: { payload: { id: string; qty: number } }) => { state.qty = event.payload.qty; } })
    .commands(emit => ({ set: (_state, payload: { id: string; qty: number }) => emit.changed(payload) }))
    .overrideEventNames({ changed: 'definition.changed.event' })
    .overrideCommandNames({ set: 'definition.set.command' }).build();
  const state = { rows: [{ id: 'a', qty: 1 }] };
  const legacy = { eventOverrides: { changed: 'old.event' }, commandOverrides: { set: 'old.command' } };
  const mount = (options: object) => kind === 'direct'
    ? createAggregate('store', state).entityList('rows', row, {}, options).build()
    : createAggregate('store', state).mixins(createMixin<typeof state>().entityList('rows', row, {}, options).build()).build();
  const original = mount({});
  const ignored = mount(legacy);
  expect(ignored.types).toEqual(original.types);
  const modern = mount({ ...legacy, commandNameOverrides: { set: 'modern.command' }, eventNameOverrides: { changed: 'modern.event' } });
  const command = modern.commandCreators.rowsSet({ id: 'a', qty: 3 });
  expect(command.type).toBe('modern.command');
  const events = modern.process(state, command);
  expect(events[0]!.type).toBe('modern.event');
  expect(modern.apply(state, events[0]!)).toEqual({ rows: [{ id: 'a', qty: 3 }] });
  expect(commandMetadata(modern, 'rowsSet')!.wireType).toBe('modern.command');
});

test.each(['js', 'cjs'])('public %s runtime retains cross-entry queries without retired surfaces', extension => {
  const entry = pathToFileURL(resolve(__dirname, `../dist/index.${extension}`)).href;
  const other = pathToFileURL(resolve(__dirname, `../dist/index.${extension === 'js' ? 'cjs' : 'js'}`)).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createAggregate, createEntity, commandMetadata } from ${JSON.stringify(entry)};
    import { commandMetadata as otherQuery } from ${JSON.stringify(other)};
    const row = createEntity('row').commands(() => ({ read: () => [] })).build();
    const built = createAggregate('store', { rows: [{ id: 'a' }] }).entityList('rows', row).build();
    for (const host of [built, built.withPlugins()]) {
      assert.equal(host.pure.commandTargets, undefined);
      assert.equal(Object.hasOwn(host.pure, 'commandTargets'), false);
      for (const key of ['rows', 'missing', 'then', 'constructor', Symbol.iterator]) assert.equal(host.commandCreators[key], undefined);
      assert.equal(await Promise.resolve(host.commandCreators), host.commandCreators);
      assert.deepEqual(otherQuery(host, 'rowsRead'), commandMetadata(host, 'rowsRead'));
      assert.deepEqual(host.process(host.initialState, host.commandCreators.rowsRead({ id: 'a' })), []);
      host.pure.commandTargets = { rowsRead: [] };
      assert.deepEqual(otherQuery(host, 'rowsRead').targets[0].statePath, ['rows']);
      delete host.pure.commandTargets;
    }
  `;
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })).not.toThrow();
});
