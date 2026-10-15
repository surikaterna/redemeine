import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { produce } from 'immer';
import { ModuleKind, transpileModule } from 'typescript';
import { createAggregatePlugin, createAggregatePluginFor } from '../src';
import { assertSynchronous } from '../src/plugins/descriptor';

describe('aggregate event plugin descriptors', () => {
  test('does not initialize during construction and returns independent state', () => {
    const initialize = jest.fn(() => ({ nested: { count: 0 } }));
    const plugin = createAggregatePlugin('counter').state(initialize).build();
    expect(initialize).not.toHaveBeenCalled();
    expect(plugin.kind).toBe('aggregate-event');
    expect(plugin.initialize()).not.toBe(plugin.initialize());
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  test('branches and built descriptors are immutable handler snapshots', () => {
    const root = createAggregatePlugin('counter').state(() => ({ nested: { count: 0 } }));
    const handlers = { added(draft: { nested: { count: number } }): undefined { draft.nested.count++; } };
    const branch = root.events(handlers);
    const first = branch.build();
    handlers.added = () => { throw new Error('mutated'); };
    const second = branch.onEvent(draft => { draft.nested.count += 10; }).build();
    expect(root.build().events).toEqual({});
    expect(first.onEvent).toBeUndefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.events)).toBe(true);
    expect(Object.isFrozen(first.eventTypes)).toBe(true);
    const initial = first.initialize();
    const result = produce(initial, draft => {
      first.events.added!(draft, { type: 'added.event', payload: {} }, { aggregateType: 'x', state: {} });
      second.onEvent!(draft, { type: 'unknown.event', payload: null }, { aggregateType: 'x', state: {} });
    });
    expect(initial.nested.count).toBe(0);
    expect(result.nested.count).toBe(11);
  });

  test('retains source identity and snapshots resolved names', () => {
    const source = {
      aggregateType: 'source', initialState: {}, pure: { eventProjectors: { added() {} } },
      types: { events: { added: 'custom.added.event' } }
    };
    const plugin = createAggregatePluginFor(source, 'source-plugin').state(() => ({})).events({ added() {} }).build();
    source.types.events.added = 'later.event';
    expect(plugin.source).toBe(source);
    expect(plugin.eventTypes).toEqual({ added: 'custom.added.event' });
  });

  test('guards widened initializer and handler thenables at invocation', () => {
    const initialize: () => object = () => Promise.resolve({});
    const plugin = createAggregatePlugin('widened').state(initialize).build();
    expect(() => plugin.initialize()).toThrow('must be synchronous');
    const hidden = (() => Object.defineProperty({}, 'then', { value() {} })) as unknown as () => undefined;
    const handlers = createAggregatePlugin('handlers').state(() => ({})).events({ added: hidden }).onEvent(hidden).build();
    const args = [{}, { type: 'x.event', payload: {} }, { aggregateType: 'x', state: {} }] as const;
    expect(() => handlers.events.added!(...args)).toThrow('must be synchronous');
    expect(() => handlers.onEvent!(...args)).toThrow('must be synchronous');
    expect(() => assertSynchronous(Object.defineProperty({}, 'then', { value: 1 }))).not.toThrow();
    expect(() => assertSynchronous(Object.defineProperty(() => {}, 'then', { value() {} }))).toThrow('must be synchronous');
  });

  test('rejects invalid runtime ids and ambiguous resolved handlers', () => {
    for (const id of ['', '__proto__', 'prototype', 'constructor', 'toString']) {
      expect(() => Reflect.apply(createAggregatePlugin, undefined, [id])).toThrow('Invalid aggregate plugin id');
    }
    const source = {
      aggregateType: 'x', initialState: {}, pure: { eventProjectors: { a() {}, b() {} } },
      types: { events: { a: 'same.event', b: 'same.event' } }
    };
    expect(() => createAggregatePluginFor(source, 'ambiguous').state(() => ({})).events({ a() {}, b() {} }).build()).toThrow('Ambiguous');
  });

  test('refuses rejecting callbacks synchronously without unhandled rejections in an isolated process', () => {
    const compile = (name: string) => transpileModule(readFileSync(join(__dirname, '../src/plugins', name), 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS }
    }).outputText;
    const script = `
      const assert = require('node:assert/strict');
      const descriptor = { exports: {} };
      new Function('exports', ${JSON.stringify(compile('descriptor.ts'))})(descriptor.exports);
      const builder = { exports: {} };
      new Function('exports', 'require', ${JSON.stringify(compile('createAggregatePlugin.ts'))})(builder.exports, () => descriptor.exports);
      const { createAggregatePlugin } = builder.exports;
      let guarded = 0;
      for (const delayed of [false, true]) {
        const callback = () => delayed
          ? new Promise((_, reject) => setTimeout(() => reject(new Error('later rejection')), 10))
          : Promise.reject(new Error('immediate rejection'));
        const plugin = createAggregatePlugin('probe').state(callback).events({ added: callback }).onEvent(callback).build();
        for (const invoke of [() => plugin.initialize(), () => plugin.events.added({}, {}, {}), () => plugin.onEvent({}, {}, {})]) {
          assert.throws(invoke, /must be synchronous/);
          guarded++;
        }
      }
      setTimeout(() => process.stdout.write('survived:' + guarded), 40);
    `;
    expect(execFileSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], { encoding: 'utf8' })).toBe('survived:6');
  });

  test('refuses throwing then getters and methods with the synchronous guard error', async () => {
    const getter = Object.defineProperty({}, 'then', { get() { throw new Error('getter'); } });
    const method = Object.defineProperty({}, 'then', { value() { throw new Error('method'); } });
    for (const value of [getter, method]) expect(() => assertSynchronous(value)).toThrow('must be synchronous');
    await new Promise(resolve => setImmediate(resolve));
  });
});
