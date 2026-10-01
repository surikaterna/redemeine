import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readSchemaRegistryManifest } from '../../src/cli/schemaRegistryManifest';

const root = resolve(__dirname, '../..');
const fixtures = join(root, 'test/cli/fixtures/registries');
let directory: string;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'registries-cli-')); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function cli(args: string[], cwd = root) {
  return spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'bin/redemeine.ts'),
    'extract-schema-registries', ...args], { cwd, encoding: 'utf8', timeout: 60000 });
}

test('first flag works, alternate cwd resolves manifest inputs but out against cwd, without preflight/source evaluation', () => {
  const result = cli(['--manifest', join(fixtures, 'manifest.json'), '--out', 'schemas.ts'], directory);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Schema registries written');
  expect(result.stdout).not.toMatch(/package.json|Installing|USER SOURCE EXECUTED/);
  expect(readFileSync(join(directory, 'schemas.ts'), 'utf8')).toContain('export const aggregateSchemas');
  const out = join(directory, 'same.ts');
  expect(cli(['--manifest', join(fixtures, 'manifest.json'), '--out', out]).status).toBe(0);
  expect(readFileSync(out, 'utf8')).toBe(readFileSync(join(directory, 'schemas.ts'), 'utf8'));
});

test.each([
  [], ['--out', 'ignored.ts'],
  ['--manifest', '--out', 'ignored.ts'], ['--manifest', join(fixtures, 'manifest.json'), '--tsconfig', 'bad'],
  ['--manifest', join(fixtures, 'manifest.json'), '--entry', 'bad'],
  ['--manifest', join(fixtures, 'manifest.json'), '--unknown'],
  ['--manifest', join(fixtures, 'manifest.json'), '--__proto__', 'ignored'],
  ['--manifest', join(fixtures, 'manifest.json'), '--constructor', 'ignored'],
  ['--manifest', join(fixtures, 'manifest.json'), '-x'],
  ['--manifest', join(fixtures, 'manifest.json'), '--manifest', 'bad'],
].map((args) => [args]))('rejects missing/unknown/duplicate/positional CLI options %j', (args) => {
  const out = join(directory, 'invalid.ts');
  writeFileSync(out, 'sentinel');
  expect(cli([...args, '--out', out]).status).not.toBe(0);
  expect(readFileSync(out, 'utf8')).toBe('sentinel');
});

test('missing output is rejected', () => {
  expect(cli(['--manifest', join(fixtures, 'manifest.json')]).status).not.toBe(0);
});

const invalid = [null, [], {}, { version: 2, tsconfig: 'tsconfig.json', definitions: [] },
  { version: 1, definitions: [] }, { version: 1, tsconfig: 'tsconfig.json', definitions: [], extra: true },
  { version: 1, tsconfig: 'tsconfig.json', definitions: [{ kind: 'projection', entry: 'a', export: 'b', name: '' }] }];
test.each(invalid.map((value) => [value]))('rejects manifest shape %j before writing', (value) => {
  const manifest = join(directory, 'invalid.json');
  writeFileSync(manifest, JSON.stringify(value));
  expect(() => readSchemaRegistryManifest(manifest)).toThrow();
  const out = join(directory, 'no-write.ts');
  rmSync(out, { force: true });
  expect(cli(['--manifest', manifest, '--out', out]).status).not.toBe(0);
  expect(existsSync(out)).toBe(false);
  writeFileSync(out, 'sentinel');
  expect(cli(['--manifest', manifest, '--out', out]).status).not.toBe(0);
  expect(readFileSync(out, 'utf8')).toBe('sentinel');
});

test('invalid JSON is not evaluated or overwritten', () => {
  const manifest = join(directory, 'invalid.json');
  writeFileSync(manifest, 'throw new Error("EXECUTED")');
  const out = join(directory, 'no-write.ts');
  writeFileSync(out, 'sentinel');
  expect(cli(['--manifest', manifest, '--out', out]).status).not.toBe(0);
  expect(readFileSync(out, 'utf8')).toBe('sentinel');
});
