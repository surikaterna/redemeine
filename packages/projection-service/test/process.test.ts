import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDirectory, externalEnvironment } from './fixtures';

function launch(env: Record<string, string> = {}, args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'projection-process-'));
  const started = performance.now();
  try {
    const result = spawnSync(process.execPath, ['--require', join(__dirname, 'denyNetwork.cjs'),
      join(artifactDirectory, 'main.js'), ...args], { cwd: directory, env, encoding: 'utf8', timeout: 2000 });
    return { ...result, elapsed: performance.now() - started };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('built no-argument executable with absent config exits78 within2s without network or secrets', () => {
  const result = launch();
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(78);
  expect(result.elapsed).toBeLessThan(2000);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ reason: 'invalid_configuration', variable: 'MONGODB_URI', detail: 'uri_required' });
});

test('explicit reference is finite, uses compiled real pipeline, no network, and never claims production readiness', () => {
  const result = launch({ PROJECTION_MODE: 'reference' });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'reference', evidence: 'model:ordered-history',
    productionReady: false, referenceOnly: true, firstSequence: 42, coveredThrough: 44,
    inlineCount: 14, ownRecordCount: 14, acknowledgements: 4 });
});

test.each([
  [{ PROJECTION_MODE: 'reference', MONGODB_URI: 'secret-canary' }, []],
  [{ PROJECTION_MODE: 'reference', PROJECTION_START_JSON: '{"trusted":true,"secret":"secret-canary"}' }, []],
  [{ PROJECTION_MODE: 'reference' }, ['secret-canary']]
])('config refusal output is allowlisted, not an environment dump', (env, args) => {
  const result = launch(env, args);
  expect(result.status).toBe(78);
  expect(result.stdout + result.stderr).not.toContain('secret-canary');
  expect(result.stderr).toBe('');
});

test('complete-looking external config still refuses before any connection or consumption', () => {
  const result = launch(externalEnvironment);
  expect(result.status).toBe(78);
  expect(result.stdout + result.stderr).not.toContain('secret-canary');
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'external', productionReady: false, reason: 'external_requires_serve' });
});
