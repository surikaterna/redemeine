import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createAggregate, createMixin } from '../src';

const state = { count: 2 };
const numeric = createMixin<typeof state>().selectors({ value: s => s.count }).build();
const textual = createMixin<typeof state>().selectors({ value: s => String(s.count), total: s => s.count + 1 }).build();

test('roots are replaced, then ordered mixins win even over later root registrations', () => {
  const host = createAggregate('selectors', state).selectors({ value: s => s.count })
    .mixins(numeric).mixins(textual).selectors({ value: s => s.count })
    .commands((_emit, { selectors }) => ({ inspect: s => {
      expect(selectors.value(s).toUpperCase()).toBe('2');
      expect(selectors.total(s).toFixed()).toBe('3');
      return [];
    } })).build();
  expect(host.selectors.value(state)).toBe('2');
  expect(host.process(state, host.commandCreators.inspect())).toEqual([]);
});

test('extends keeps parent roots before child roots and parent mixins before child mixins', () => {
  const parent = createAggregate('parent', state).selectors({ value: s => s.count }).mixins(textual);
  const child = createAggregate('child', state).selectors({ value: (_s: typeof state) => false })
    .mixins(numeric).extends(parent).build();
  expect(child.selectors.value(state)).toBe(2);
  expect(child.selectors.total(state)).toBe(3);
  const roots = createAggregate('roots', state).selectors({ value: (_s: typeof state) => 'child' })
    .extends(createAggregate('parentRoot', state).selectors({ value: s => s.count })).build();
  expect(roots.selectors.value(state)).toBe('child');
});

test('readonly tuples and successive mixin selector registrations preserve last-writer behavior', () => {
  const tuple = [numeric, textual] as const;
  expect(createAggregate('tuple', state).mixins(...tuple).build().selectors.value(state)).toBe('2');
  const replaced = createMixin<typeof state>().selectors({ value: s => s.count })
    .selectors({ value: s => String(s.count) }).build();
  expect(replaced.selectors.value(state)).toBe('2');
});

test.each([[], [numeric], [textual], [textual, numeric]])('widened arrays retain actual fallback/order: %j', (...variants) => {
  const host = createAggregate('array', state).selectors({ value: (_s: typeof state) => false })
    .mixins(...variants).build();
  const last = variants.at(-1);
  expect(host.selectors.value(state)).toBe(last ? last.selectors.value(state) : false);
  expect(host.selectors.total?.(state)).toBe(variants.includes(textual) ? 3 : undefined);
});

test.each(['module', 'commonjs'])('%s actual package exports preserve selector/command behavior', format => {
  const load = format === 'module'
    ? "import { createAggregate, createMixin } from '@redemeine/aggregate';"
    : "const { createAggregate, createMixin } = require('@redemeine/aggregate');";
  const result = spawnSync(process.execPath, [`--input-type=${format}`, '-e', `${load}
    const state = { count: 2 };
    const mixin = createMixin().selectors({ value: s => String(s.count), total: s => s.count + 1 }).build();
    const host = createAggregate('public', state).mixins(mixin).selectors({ value: s => s.count })
      .commands((_emit, { selectors }) => ({ inspect: s => {
        if (selectors.value(s).toUpperCase() !== '2' || selectors.total(s) !== 3) throw Error('selectors');
        return [];
      } })).build();
    host.process(state, host.commandCreators.inspect());
    if (host.selectors.value(state) !== '2') throw Error('root incorrectly won');
  `], { cwd: join(__dirname, '..'), encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
