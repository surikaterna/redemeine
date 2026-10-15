import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { produce } from 'immer';
import { ModuleKind, transpileModule } from 'typescript';
import { createAggregatePlugin } from '../src';

const context = { aggregateType: 'invoice', state: {}, ownState: {}, command: { type: 'pay.command', payload: {} } };

describe('aggregate envelope builder descriptors', () => {
  test('closes configured clock without executing it and snapshots ordered recipes', () => {
    const clock = jest.fn(() => new Date('2026-10-16T00:00:00Z'));
    const factory = (clock: () => Date) =>
      createAggregatePlugin('audit')
        .state(() => ({}))
        .commandEnvelope((input) => ({ dateTime: input.dateTime instanceof Date ? input.dateTime : clock(), nested: { values: [] as number[] } }));
    const root = factory(clock);
    const first = root.prepareCommand((draft) => {
      draft.nested.values.push(1);
    });
    const second = first
      .prepareCommand((draft) => {
        draft.nested.values.push(2);
      })
      .eventEnvelope((_, ctx) => ({ commandDate: ctx.command.dateTime, nested: { count: 0 } }))
      .prepareEvent((draft) => {
        draft.nested.count++;
      })
      .build();
    expect(clock).not.toHaveBeenCalled();
    const descriptor = second.commandEnvelope!;
    const initial = descriptor.initialize({}, context);
    expect(clock).toHaveBeenCalledTimes(1);
    const prepared = produce(initial as { dateTime: Date; nested: { values: number[] } }, (draft) => {
      for (const recipe of descriptor.recipes) recipe(draft, context);
    });
    expect(prepared.nested.values).toEqual([1, 2]);
    expect(root.build().commandEnvelope!.recipes).toHaveLength(0);
    expect(first.build().commandEnvelope!.recipes).toHaveLength(1);
    expect(root.build().eventEnvelope).toBeUndefined();
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.recipes)).toBe(true);
    const eventContext = { ...context, command: { ...context.command, ...prepared }, event: { type: 'paid.event', payload: {} } };
    const enriched = second.eventEnvelope!.initialize({}, eventContext);
    expect(enriched).toEqual({ commandDate: prepared.dateTime, nested: { count: 0 } });
    const event = produce(enriched as { commandDate: Date; nested: { count: number } }, (draft) => {
      for (const recipe of second.eventEnvelope!.recipes) recipe(draft, eventContext);
    });
    expect(event.nested.count).toBe(1);
  });

  test('guards phases at runtime for erased callers and preserves independent branches', () => {
    const root = createAggregatePlugin('phases').state(() => ({}));
    for (const method of ['prepareCommand', 'prepareEvent'] as const) {
      expect(() => Reflect.apply(root[method], root, [() => undefined])).toThrow('before recipes');
    }
    const initialized = root.commandEnvelope(() => ({ value: 1 })).eventEnvelope(() => ({ value: 2 }));
    for (const method of ['commandEnvelope', 'eventEnvelope'] as const) {
      expect(() => Reflect.apply(initialized[method], initialized, [() => ({})])).toThrow('already declared');
    }
    expect(root.commandEnvelope(() => ({ other: true })).build().commandEnvelope).toBeDefined();
  });

  test('snapshots optional parser methods, preserving their receiver', () => {
    const parser = {
      offset: 2,
      parse(input: unknown) {
        return { count: Number(input) + this.offset };
      }
    };
    const plugin = createAggregatePlugin('parsed')
      .state(() => ({}))
      .commandEnvelope(() => ({}), parser)
      .build();
    parser.parse = () => {
      throw new Error('replaced');
    };
    expect(plugin.commandEnvelope!.parser!.parse(3)).toEqual({ count: 5 });
    expect(Object.isFrozen(plugin.commandEnvelope!.parser)).toBe(true);
  });

  test('observes rejected initializer/parser/recipe promises in an isolated strict process', () => {
    const compile = (name: string) =>
      transpileModule(readFileSync(join(__dirname, '../src/plugins', name), 'utf8'), {
        compilerOptions: { module: ModuleKind.CommonJS }
      }).outputText;
    const script = `
      const assert = require('node:assert/strict');
      const descriptor = { exports: {} }, envelopes = { exports: {} }, builder = { exports: {} };
      new Function('exports', ${JSON.stringify(compile('descriptor.ts'))})(descriptor.exports);
      new Function('exports', 'require', ${JSON.stringify(compile('envelopeDescriptor.ts'))})(envelopes.exports, () => descriptor.exports);
      new Function('exports', 'require', ${JSON.stringify(compile('createAggregatePlugin.ts'))})(builder.exports,
        name => name === './envelopeDescriptor' ? envelopes.exports : descriptor.exports);
      let guarded = 0;
      for (const delayed of [false, true]) {
        const callback = () => delayed ? new Promise((_, reject) => setTimeout(() => reject(Error('late')), 10)) : Promise.reject(Error('now'));
        const plugin = builder.exports.createAggregatePlugin('probe').state(() => ({}))
          .commandEnvelope(callback, { parse: callback }).prepareCommand(callback)
          .eventEnvelope(callback, { parse: callback }).prepareEvent(callback).build();
        for (const slot of [plugin.commandEnvelope, plugin.eventEnvelope]) {
          for (const invoke of [() => slot.initialize({}, {}), () => slot.parser.parse({}), () => slot.recipes[0]({}, {})]) {
            assert.throws(invoke, /must be synchronous/); guarded++;
          }
        }
      }
      setTimeout(() => process.stdout.write('survived:' + guarded), 40);
    `;
    expect(execFileSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], { encoding: 'utf8' })).toBe('survived:12');
  });
});
