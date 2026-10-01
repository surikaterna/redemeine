import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
let directory: string;
beforeAll(() => { directory = mkdtempSync(join(__dirname, 'cli-generated-')); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(extra: string[], aggregate = false) {
  const fixture = aggregate ? 'test/cli/fixtures' : 'test/cli/fixtures/projection';
  const out = join(directory, 'schemas.ts');
  return spawnSync(process.execPath, [require.resolve('tsx/cli'), 'bin/redemeine.ts', 'extract-schemas',
    '--tsconfig', `${fixture}/tsconfig.json`, '--entry', `${fixture}/${aggregate ? 'test-aggregate' : 'test-projection'}.ts`,
    '--export', aggregate ? 'testAggregate' : 'implicitProjection', '--out', out, ...extra], { cwd: root, encoding: 'utf8' });
}

test('CLI generates projection schemas with explicit kind', () => {
  const result = run(['--kind', 'projection']);
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: expect.any(String), stderr: '' });
  expect(readFileSync(join(directory, 'schemas.ts'), 'utf8')).toContain('stateJsonSchema = z.toJSONSchema(stateSchema)');
});

test.each([['--kind', 'invalid'], ['--kind', 'projection', '--no-state'], ['--kind', 'projection', '--date-handling', 'string']])
('CLI rejects incompatible options %j without overwriting', (...args) => {
  const before = existsSync(join(directory, 'schemas.ts')) ? readFileSync(join(directory, 'schemas.ts'), 'utf8') : undefined;
  const result = run(args);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toMatch(/--kind|not supported/);
  if (before) expect(readFileSync(join(directory, 'schemas.ts'), 'utf8')).toBe(before);
});

test('CLI default aggregate output equals explicit aggregate kind', () => {
  expect(run([], true)).toMatchObject({ status: 0 });
  const implicit = readFileSync(join(directory, 'schemas.ts'), 'utf8');
  expect(run(['--kind', 'aggregate'], true).status).toBe(0);
  expect(readFileSync(join(directory, 'schemas.ts'), 'utf8')).toBe(implicit);
  expect(implicit).toContain('commandSchemas');
});
