import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertBuildContextClosure, readBuildContextClosure, rootBuildInputs } from '../../scripts/main-image-context.mjs';
import { buildDiagnostics, persistBuildDiagnostics } from '../../scripts/main-image-diagnostics.mjs';

const root = new URL('../../../../', import.meta.url).pathname;
const manifests = [{ path: '.', manifest: { name: 'root', devDependencies: { '@redemeine/app': 'workspace:*' } } },
  { path: 'packages/app', manifest: { name: '@redemeine/app', dependencies: { '@redemeine/core': 'workspace:*' } } },
  { path: 'packages/core', manifest: { name: '@redemeine/core', devDependencies: { '@redemeine/test-helper': 'workspace:*' } } },
  { path: 'packages/test-helper', manifest: { name: '@redemeine/test-helper' } }];
const lock = `importers:
  .:
    devDependencies:
      '@redemeine/app':
        specifier: workspace:*
        version: link:packages/app
  packages/app:
    dependencies:
      '@redemeine/core':
        specifier: workspace:*
        version: link:../core
  packages/core:
    devDependencies:
      '@redemeine/test-helper':
        specifier: workspace:*
        version: link:../test-helper
packages:
`;
const rootCopy = `COPY ${rootBuildInputs.join(' ')} ./\n`;
const docker = `FROM node AS build\n${rootCopy}COPY packages/app/ packages/app/\nCOPY packages/core/ packages/core/\nCOPY packages/test-helper/ packages/test-helper/\nFROM node AS runtime\n`;

test('actual Docker selected workspace closure is complete; no missing COPY is inferred', async () => {
  const result = await readBuildContextClosure(root);
  assert.deepEqual(result.selected, ['.', 'packages/aggregate', 'packages/projection', 'packages/projection-router-core', 'packages/projection-runtime-core',
    'packages/projection-runtime-store-mongodb', 'packages/projection-service', 'packages/projection-transport', 'packages/projection-worker-core']);
  assert.ok(result.edges.length > 0); assert.ok(result.copiedSources.includes('packages/kernel/'));
});
test('root and transitive dev workspace dependencies must be copied before Docker can execute', () => {
  assert.equal(assertBuildContextClosure(manifests, lock, docker, '@redemeine/app').selected.length, 4);
  assert.throws(() => assertBuildContextClosure(manifests, lock, docker.replace('COPY packages/test-helper/ packages/test-helper/\n', ''), '@redemeine/app'), /workspace_copy_missing/);
  assert.throws(() => assertBuildContextClosure(manifests, lock, docker.replace(rootCopy, ''), '@redemeine/app'), /context_root_build_input_missing/);
});
test('missing declared workspace, mismatched lock link/specifier and whole-context COPY refuse', () => {
  assert.throws(() => assertBuildContextClosure(manifests.slice(0, 3), lock, docker, '@redemeine/app'), /workspace_manifest_missing/);
  assert.throws(() => assertBuildContextClosure(manifests, lock.replace('link:../core', 'link:../missing'), docker, '@redemeine/app'), /workspace_lock_link_mismatch/);
  assert.throws(() => assertBuildContextClosure(manifests, lock.replace('specifier: workspace:*', 'specifier: workspace:^'), docker, '@redemeine/app'), /workspace_lock_specifier_mismatch/);
  assert.throws(() => assertBuildContextClosure(manifests, lock, docker.replace('FROM node AS runtime', 'COPY . .\nFROM node AS runtime'), '@redemeine/app'), /whole_context_copy_refused/);
});
test('shared root tsup config is required by selected package configs and must be copied', async () => {
  const closure = await readBuildContextClosure(root);
  assert.ok(closure.copiedSources.includes('tsup.config.base.ts'));
  for (const path of closure.selected.filter((path) => path !== '.' && path !== 'packages/projection-service')) {
    const config = await readFile(join(root, path, 'tsup.config.ts'), 'utf8');
    assert.match(config, /from ['"]\.\.\/\.\.\/tsup\.config\.base['"]/);
  }
  const shared = await readFile(join(root, 'tsup.config.base.ts'), 'utf8');
  assert.match(shared, /export const baseConfig/); assert.match(shared, /dts: true/);
  const actualDockerfile = await readFile(join(root, 'packages/projection-service/Dockerfile'), 'utf8');
  const omit = actualDockerfile.replace(' tsup.config.base.ts ', ' ');
  const actualManifests = await Promise.all(closure.selected.map(async (path) => ({ path,
    manifest: JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')) })));
  const actualLock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
  assert.equal(assertBuildContextClosure(actualManifests, actualLock, actualDockerfile).selected.length, 9);
  assert.throws(() => assertBuildContextClosure(actualManifests, actualLock, omit), /context_root_build_input_missing/);
  assert.ok(!omit.includes('COPY . .'));
});
test('missing actual shared build-input file refuses before any future Docker command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'missing-root-config-'));
  try {
    for (const path of rootBuildInputs.filter((path) => path !== 'tsup.config.base.ts')) await writeFile(join(directory, path), 'fixture', { flag: 'wx', mode: 0o600 });
    await assert.rejects(readBuildContextClosure(directory), /context_root_build_input_missing/);
  }
  finally { await rm(directory, { recursive: true, force: true }); }
});

const context = { packageNames: ['@redemeine/core'] };
function result(stdout = '', stderr = '') { return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), code: 1, cliJoined: true, elapsedMilliseconds: 12 }; }
test('closed build diagnostics capture readable stages/codes but omit URI, credentials, raw errors and unknown names', () => {
  const facts = buildDiagnostics(result('Step 16/41 : RUN token=secret-canary\nERR_PNPM_WORKSPACE_PKG_NOT_FOUND @redemeine/core\n',
    'https://user:password-canary@registry.invalid npm error code E401\nraw secret-canary error TS2307 @redemeine/private-secret\nreturned a non-zero code: 1'), context);
  assert.deepEqual(facts.records, [{ kind: 'docker_step', step: 16, total: 41, instruction: 'RUN' },
    { kind: 'pnpm_error', code: 'ERR_PNPM_WORKSPACE_PKG_NOT_FOUND', packages: ['@redemeine/core'] },
    { kind: 'npm_error', code: 'E401' }, { kind: 'typescript_error', code: 'TS2307' }, { kind: 'docker_command_failed', code: 1 }]);
  assert.doesNotMatch(JSON.stringify(facts), /canary|registry|user:|private-secret/); assert.equal(facts.elapsedMilliseconds, 12);
});
test('diagnostic input/line/record caps and unknown-message omission stay explicit', () => {
  assert.throws(() => buildDiagnostics(result('x'.repeat(1048577)), context), /diagnostic_capacity/);
  assert.deepEqual(buildDiagnostics(result('x'.repeat(16385)), context).records, [{ kind: 'diagnostic_line_omitted' }]);
  const many = buildDiagnostics(result(Array.from({ length: 100 }, (_, n) => `Step ${n}/100 : RUN secret`).join('\n')), context);
  assert.equal(many.records.length, 64); assert.equal(many.omitted, true);
  assert.equal(buildDiagnostics(result('unknown private://canary'), context).diagnosticStatus, 'no_allowlisted_diagnostic');
  assert.equal(buildDiagnostics({ ...result(), reason: 'private://canary' }, context).reason, 'unknown_cli_failure');
});
test('diagnostics are private0600 in owned0700 directory, exclusive and contain only allowlisted facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'build-facts-'));
  try {
    await chmod(directory, 0o700); await persistBuildDiagnostics(directory, result('', 'ERR_PNPM_OUTDATED_LOCKFILE secret-canary'), context);
    assert.equal((await stat(join(directory, 'build-diagnostics.json'))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(directory, 'build-diagnostics.json'), 'utf8'), /canary/);
    await assert.rejects(persistBuildDiagnostics(directory, result(), context));
    await chmod(directory, 0o755); await assert.rejects(persistBuildDiagnostics(directory, result(), context), /diagnostic_directory_refused/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const privateDirectory = { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700 };
async function originalRequired(capture, receipt, cliResult) {
  const source = await readFile(new URL('../../scripts/check-main-image.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function command('), source.indexOf('async function inspect('));
  return new Function('assert', 'spawn', 'superviseChild', 'noSpawnResult', 'persistBuildDiagnostics', 'interruption', 'cleanupDeadline', 'root', 'sha256', 'receipt',
    `${body};return required;`)(assert, () => ({}), async () => cliResult, () => { throw new Error('unexpected_no_spawn'); }, capture,
    new AbortController(), Infinity, root, (bytes) => createHash('sha256').update(bytes).digest('hex'), receipt);
}
test('DIAG1 original joined build failure reaches finally within default2s even when metadata never settles', { timeout: 5000 }, async () => {
  const cli = { ...result('', 'private://canary'), nativeNoSpawn: false, secondary: [], bytes: 16 };
  const receipt = { commands: [], failures: [], uncertainty: [] }; let cleanup = false; let writes = 0;
  const required = await originalRequired((directory, output, context) => persistBuildDiagnostics(directory, output, context,
    { lstat: () => new Promise(() => {}), writeFile: async () => { writes++; } }), receipt, cli);
  const started = performance.now();
  const pending = required({ deadlines: { command: 10 }, dockerPrefix: [], directory: '/owned', buildContextClosure: context }, ['build'])
    .finally(() => { cleanup = true; });
  await assert.rejects(pending, (error) => error.code === 'docker_command_failed' && error.result === cli && error.result.cliJoined === true);
  assert.ok(cleanup && performance.now() - started < 4000); assert.equal(writes, 0);
  assert.equal(receipt.commands[0].code, 1); assert.equal(receipt.commands[0].nativeNoSpawn, false);
  assert.equal(receipt.uncertainty[0].reason, 'diagnostic_persistence_failed');
  assert.doesNotMatch(JSON.stringify(receipt), /canary/);
});
test('DIAG1 late metadata fulfillment cannot start a fresh write; timer and monotonic guards agree', async () => {
  let complete; let writes = 0;
  const pending = persistBuildDiagnostics('/owned', result(), context, { milliseconds: 20,
    lstat: () => new Promise((resolve) => { complete = resolve; }), writeFile: async () => { writes++; } });
  await assert.rejects(pending, /diagnostic_capture_unproven/); complete(privateDirectory); await delay(10);
  assert.equal(writes, 0);
  let now = 0;
  await assert.rejects(persistBuildDiagnostics('/owned', result(), context, { milliseconds: 20, now: () => now,
    lstat: async () => { now = 20; return privateDirectory; }, writeFile: async () => { writes++; } }), /diagnostic_capture_unproven/);
  assert.equal(writes, 0);
});
test('DIAG1 late metadata rejection is observed without unhandled rejection or write', async () => {
  let reject; let unhandled = 0; let writes = 0; const listener = () => { unhandled++; }; process.on('unhandledRejection', listener);
  try {
    const pending = persistBuildDiagnostics('/owned', result(), context, { milliseconds: 20,
      lstat: () => new Promise((_resolve, failed) => { reject = failed; }), writeFile: async () => { writes++; } });
    await assert.rejects(pending, /diagnostic_capture_unproven/); reject(new Error('private://late')); await delay(10);
    assert.equal(unhandled, 0); assert.equal(writes, 0);
  } finally { process.removeListener('unhandledRejection', listener); }
});
test('DIAG1 admitted hanging write returns finite uncertainty, preserves original CLI and observes late rejection', async () => {
  let reject; let writes = 0; let cleanup = false; let unhandled = 0; const listener = () => { unhandled++; }; process.on('unhandledRejection', listener);
  const receipt = { commands: [], failures: [], uncertainty: [] }; const cli = { ...result(), nativeNoSpawn: false, secondary: [], bytes: 0 };
  try {
    const required = await originalRequired((directory, output, context) => persistBuildDiagnostics(directory, output, context, { milliseconds: 20,
      lstat: async () => privateDirectory, writeFile: () => { writes++; return new Promise((_resolve, failed) => { reject = failed; }); } }), receipt, cli);
    await assert.rejects(required({ deadlines: { command: 10 }, dockerPrefix: [], directory: '/owned', buildContextClosure: context }, ['build'])
      .finally(() => { cleanup = true; }), (error) => error.code === 'docker_command_failed' && error.result === cli);
    reject(new Error('private://late-write')); await delay(10);
    assert.ok(cleanup); assert.equal(writes, 1); assert.equal(unhandled, 0); assert.equal(receipt.uncertainty.length, 1);
  } finally { process.removeListener('unhandledRejection', listener); }
});
test('DIAG1 shared deadline includes metadata time and cannot be inflated by caller options', async () => {
  let now = 0; let writes = 0;
  await assert.rejects(persistBuildDiagnostics('/owned', result(), context, { milliseconds: 20, now: () => now,
    lstat: async () => { now = 19; return privateDirectory; }, writeFile: async () => { writes++; now = 20; } }), /diagnostic_capture_unproven/);
  assert.equal(writes, 1);
  await assert.rejects(persistBuildDiagnostics('/owned', result(), context, { milliseconds: 2001, lstat: async () => { throw new Error('unexpected'); } }), /diagnostic_budget_refused/);
});
