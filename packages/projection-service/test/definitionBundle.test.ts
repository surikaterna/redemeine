import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDefinitionBundle } from '../src/definitionBundle';
import { validateRegistrations } from '../src/definitionValidation';
import { applicationRegistry } from '../src/runtimeRegistry';
import { parseWorkerConfig } from '../src/workerConfig';
import { spawnSync } from 'node:child_process';
import { runWorkerCli } from '../src/runWorkerCli';

const example = join(__dirname, '.built/application/definitions.mjs');
const loader = join(__dirname, '../src/definitionBundle.ts');
const root = join(__dirname, '../../..');
const env = { MONGODB_URI: 'mongodb://127.0.0.1:1', MONGODB_DATABASE: 'app', MONGODB_COMMITS_COLLECTION: 'commits',
  RABBITMQ_URI: 'amqp://user:dummy@127.0.0.1:1/v', RABBITMQ_VHOST: 'v', RABBITMQ_EXCHANGE: 'tapeworm.master.commits',
  PROJECTION_PARTITION_ID: 'master', RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:1', RABBITMQ_MANAGEMENT_USERNAME: 'user', RABBITMQ_MANAGEMENT_PASSWORD: 'dummy' };

function registrations() {
  return [{ initialization: 'suffix_contributions', routing: 'event_stable_commutative', definition: { name: 'ledger:total', subscriptions: [],
    initialState: jest.fn(() => ({ total: 0 })), identity: () => 'shared',
    fromStream: { aggregate: { aggregateType: 'Ledger', initialState: {}, pure: { eventProjectors: {} } }, handlers: { Credited: jest.fn() } } } }];
}

test('typed prebundled application example loads natively, normalizes inline and is not ModelCounter', () => {
  const script = `const {loadDefinitionBundle}=await import(${JSON.stringify(loader)});const b=await loadDefinitionBundle(${JSON.stringify(example)},2000);const d=b.definitions[0];console.log(JSON.stringify({name:d.name,aggregate:d.fromStream.aggregate.aggregateType,strategy:d.deduplication.strategy,frozen:Object.isFrozen(d.fromStream.handlers)}));`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 4000 });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ name: 'ledger:total', aggregate: 'Ledger', strategy: 'in_document', frozen: true });
});

test('validation snapshots never invoke state factories, reducers or hooks', () => {
  const input = registrations(); const factory = input[0]?.definition.initialState; const handler = input[0]?.definition.fromStream.handlers.Credited;
  const result = validateRegistrations(input); expect(result).toHaveLength(1);
  expect(factory).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
});

test('explicit own_record/hook/warning options are copied; unsupported identity fanout refuses at execution', () => {
  const entry = registrations()[0]; if (!entry) throw new Error('missing_case');
  const afterEach = jest.fn(); const input = [{ ...entry, definition: { ...entry.definition,
    deduplication: { strategy: 'own_record', warnings: { warnAtSourceCount: 5 } }, hooks: { afterEach }, identity: () => ['one', 'two'] } }];
  const normalized = validateRegistrations(input)[0]; if (!normalized) throw new Error('missing_result');
  expect(normalized.deduplication).toEqual({ strategy: 'own_record', warnings: { warnAtSourceCount: 5 } }); expect(afterEach).not.toHaveBeenCalled();
  expect(() => normalized.identity({ aggregateType: 'Ledger', aggregateId: 'a', type: 'Credited', sequence: 0, timestamp: '', payload: {} })).toThrow('unsupported_definition_identity');
});

test('missing/empty/bad-export modules refuse78 before the main serve/driver acquisition seam', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-config-')); const path = join(directory, 'bad.mjs');
  try {
    const serve = jest.fn(async () => 0); const lines: string[] = [];
    expect(await runWorkerCli(env, [], join(__dirname, '../dist-worker'), (line) => lines.push(line), serve)).toBe(78);
    await writeFile(path, 'export const nope=1;');
    expect(await runWorkerCli({ ...env, PROJECTION_DEFINITIONS_MODULE: path }, [], join(__dirname, '../dist-worker'), (line) => lines.push(line), serve)).toBe(78);
    expect(serve).not.toHaveBeenCalled(); expect(lines.join('\n')).not.toContain(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(['empty', 'duplicate', 'history', 'routing', 'unknown', 'subscription', 'bad_hook', 'bad_warning', 'none', 'generation'])('%s registration refuses', (fault) => {
  const entry = registrations()[0]; if (!entry) throw new Error('missing_case');
  const definition: Record<string, unknown> = { ...entry.definition };
  let input: unknown = [{ ...entry, definition }];
  if (fault === 'empty') input = [];
  if (fault === 'duplicate') input = [entry, entry];
  if (fault === 'history') input = [{ ...entry, initialization: 'history_dependent' }];
  if (fault === 'routing') input = [{ ...entry, routing: 'dynamic' }];
  if (fault === 'unknown') definition.plugin = 'bad';
  if (fault === 'subscription') definition.subscriptions = [{}];
  if (fault === 'bad_hook') definition.hooks = { afterEach: 'bad' };
  if (fault === 'bad_warning') definition.deduplication = { strategy: 'in_document', warnings: { warnAtSourceCount: -1 } };
  if (fault === 'none') definition.deduplication = { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'bad' };
  if (fault === 'generation') input = [{ ...entry, generation: 'authored' }];
  expect(() => validateRegistrations(input)).toThrow();
});

test('runtime/bundle/order/metadata identities change without handler stringification; identical inputs are stable', () => {
  const defs = validateRegistrations(registrations()); const digest = 'a'.repeat(64); const module = 'b'.repeat(64);
  const first = applicationRegistry(digest, module, defs); expect(applicationRegistry(digest, module, defs).identity).toEqual(first.identity);
  expect(applicationRegistry('c'.repeat(64), module, defs).identity).not.toEqual(first.identity);
  expect(applicationRegistry(digest, 'c'.repeat(64), defs).identity).not.toEqual(first.identity);
  expect(first.registry.namespace('epoch')).toMatch(/^rdm_projection_[a-f0-9]{64}$/);
});

test('changed bytes and atomic same-byte replacement during import refuse before use', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-bundle-')); const path = join(directory, 'app.mjs');
  try {
    await writeFile(path, 'export const registrations=[];');
    await expect(loadDefinitionBundle(path, 2000, undefined, { importModule: async () => {
      await writeFile(path, 'export const registrations=[1];'); return { registrations: registrations() };
    } })).rejects.toThrow('definition_bundle_invalid');
    await expect(loadDefinitionBundle(path, 2000, undefined, { importModule: async () => {
      const bytes = await readFile(path); await rm(path); await writeFile(path, bytes); return { registrations: registrations() };
    } })).rejects.toThrow('definition_bundle_invalid');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('hash-keyed imports re-evaluate changed same-path files; symlinks and oversized files refuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-bundle-')); const path = join(directory, 'app.mjs');
  try {
    const bytes = await readFile(example, 'utf8'); await writeFile(path, bytes);
    const script = `import {readFile,writeFile} from 'node:fs/promises';const {loadDefinitionBundle}=await import(${JSON.stringify(loader)});const p=${JSON.stringify(path)};const first=await loadDefinitionBundle(p,2000);const s=await readFile(p,'utf8');await writeFile(p,s.replace('ledger:total','ledger:changed'));const second=await loadDefinitionBundle(p,2000);console.log(JSON.stringify({name:second.definitions[0].name,changed:second.moduleHash!==first.moduleHash}));`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 4000 });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ name: 'ledger:changed', changed: true });
    await symlink(path, join(directory, 'link.mjs')); await expect(loadDefinitionBundle(join(directory, 'link.mjs'), 2000)).rejects.toThrow('definition_bundle_invalid');
    await writeFile(path, 'x'.repeat(4194305)); await expect(loadDefinitionBundle(path, 2000)).rejects.toThrow('definition_bundle_invalid');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('independent timeout and monotonic post-import checks refuse late/stuck imports without unhandled late rejection', async () => {
  let now = 0;
  await expect(loadDefinitionBundle(example, 100, undefined, { now: () => now, importModule: async () => { now = 100; return { registrations: registrations() }; } }))
    .rejects.toThrow('definition_bundle_timeout');
  let reject: (error: unknown) => void = () => {};
  await expect(loadDefinitionBundle(example, 20, undefined, { importModule: () => new Promise((_resolve, failed) => { reject = failed; }) }))
    .rejects.toThrow('definition_bundle_timeout'); reject(new Error('late-private')); await new Promise(setImmediate);
});

test('main config defaults external/serve and rejects reference/once; native invalid/TLA processes exit78 with otherwise valid dummy config', async () => {
  expect(parseWorkerConfig({ ...env, PROJECTION_DEFINITIONS_MODULE: example }, []).config.execution).toBe('serve');
  expect(() => parseWorkerConfig({ ...env, PROJECTION_MODE: 'reference' }, [])).toThrow();
  expect(() => parseWorkerConfig({ ...env, PROJECTION_EXECUTION: 'once' }, [])).toThrow();
  const directory = await mkdtemp(join(tmpdir(), 'worker-cli-')); const path = join(directory, 'bad.mjs');
  try {
    for (const source of ['throw new Error("amqp://secret-canary");', 'await new Promise(()=>{});', 'export const nope=1;', 'export const registrations=[];']) {
      await writeFile(path, source);
      const result = spawnSync(process.execPath, [join(__dirname, '../dist-worker/main.js')], {
        env: { ...env, CONNECT_TIMEOUT_MS: '100', PROJECTION_DEFINITIONS_MODULE: path }, encoding: 'utf8', timeout: 2000 });
      expect(result.status).toBe(78); expect(result.signal).toBeNull(); expect(result.stderr).toBe('');
      expect(result.stdout).toMatch(/definition_bundle_(invalid|timeout)/); expect(result.stdout).not.toMatch(/amqp|secret-canary|bad\.mjs/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
