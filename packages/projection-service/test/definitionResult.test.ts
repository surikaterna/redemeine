import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { validateRegistrations } from '../src/definitionValidation';
import { moduleRegistrations } from '../src/definitionModule';

test.each([
  ['handler', 'before_await'], ['handler', 'after_await'], ['handler', 'ordinary_promise'], ['hook', 'after_await'],
  ['hook', 'ordinary_promise'], ['initialState', 'rejected'], ['identity', 'rejected'],
  ...['resolving_thenable', 'rejecting_thenable', 'stuck_thenable', 'hostile_thenable', 'throwing_getter', 'cross_realm', 'native_getter'].map((kind) => ['handler', kind])
])('loaded %s/%s refuses in actual coordinator without writes/coverage/unhandled rejection', (boundary, kind) => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, 'support/definitionResultProbe.ts'), boundary ?? '', kind ?? ''],
    { cwd: join(__dirname, '../../..'), encoding: 'utf8', timeout: 8000 });
  expect(child.status).toBe(0); expect(child.stderr).toBe('');
  const receipt = JSON.parse(child.stdout);
  expect(receipt.result).toEqual({ status: 'paused', processedCommits: 0, coveredThrough: null, reason: 'live_definition_failed' });
  expect(receipt).toMatchObject({ writes: 0, advances: 0, persisted: null, unhandled: 0, floor: { firstSequence: 42, coveredThrough: null } });
  expect(child.stdout).not.toContain('private://');
});

test('synchronous number-valued void callback still contributes5 and covers42', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, 'support/definitionResultProbe.ts'), 'handler', 'synchronous'],
    { cwd: join(__dirname, '../../..'), encoding: 'utf8', timeout: 8000 });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ result: { status: 'completed', coveredThrough: 42 }, writes: 1, advances: 1, persisted: { total: 5 }, unhandled: 0 });
});

function input() {
  return { initialization: 'suffix_contributions', routing: 'event_stable_commutative', definition: { name: 'ledger:test', subscriptions: [],
    initialState: () => ({ total: 0 }), identity: () => 'shared', hooks: {}, deduplication: { strategy: 'in_document', warnings: {} },
    fromStream: { aggregate: { aggregateType: 'Ledger', initialState: {}, pure: { eventProjectors: {} } }, handlers: { Credited: () => {} } } } };
}
test.each(['registration', 'definition', 'stream', 'dedupe', 'warnings', 'hooks'])('hidden unsupported %s own fields refuse', (location) => {
  const entry = input(); const targets: Record<string, object> = { registration: entry, definition: entry.definition, stream: entry.definition.fromStream,
    dedupe: entry.definition.deduplication, warnings: entry.definition.deduplication.warnings, hooks: entry.definition.hooks };
  Object.defineProperty(targets[location] ?? {}, 'generation', { value: 'authored', enumerable: false });
  expect(() => validateRegistrations([entry])).toThrow('unsupported_definition_field');
});
test('nonenumerable supported fields are preserved; symbols/accessors refuse without invoking getters', () => {
  const entry = input(); Object.defineProperty(entry.definition, 'name', { value: 'ledger:hidden', enumerable: false });
  Object.defineProperty(entry.definition.fromStream.handlers, 'Credited', { value: () => {}, enumerable: false });
  const validated = validateRegistrations([entry])[0]; expect(validated?.name).toBe('ledger:hidden');
  expect(Object.keys(validated?.fromStream.handlers ?? {})).toEqual(['Credited']);
  Object.defineProperty(entry, Symbol('hidden'), { value: true }); expect(() => validateRegistrations([entry])).toThrow('invalid_definition_shape');
  const other = input(); const getter = jest.fn(); Object.defineProperty(other.definition.hooks, 'afterEach', { get: getter });
  expect(() => validateRegistrations([other])).toThrow('invalid_definition_shape'); expect(getter).not.toHaveBeenCalled();
});

test('module boundary refuses hidden exports, authored symbols and accessors without getter execution', () => {
  const module = { registrations: [input()] };
  Object.defineProperty(module, 'generation', { value: 'authored', enumerable: false });
  expect(() => moduleRegistrations(module)).toThrow('unsupported_definition_module_export');
  const symbolic = { registrations: [input()], [Symbol.toStringTag]: 'Module' };
  expect(() => moduleRegistrations(symbolic)).toThrow('unsupported_definition_module_export');
  const getter = jest.fn(); const accessor = Object.defineProperty({}, 'registrations', { get: getter });
  expect(() => moduleRegistrations(accessor)).toThrow('unsupported_definition_module_export'); expect(getter).not.toHaveBeenCalled();
  const supported = Object.defineProperty(Object.create(null), 'registrations', { value: [input()], enumerable: false });
  expect(validateRegistrations(moduleRegistrations(supported))).toHaveLength(1);
});
