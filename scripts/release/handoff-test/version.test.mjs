import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { manifest, put, repo, workspace } from '../test/fixtures.mjs';
import { run, sourceIdentity } from '../workspace.mjs';

test('actual Changesets 2.31 fixture pre version, lock refresh/frozen validation, explicit stable exit; repository untouched', async (t) => {
  const report = { root: repo, invocations: [] };
  const before = await sourceIdentity(repo, report);
  const fixture = await workspace([
    manifest('@fixture/version-base'),
    manifest('@fixture/version-app', { dependencies: { '@fixture/version-base': 'workspace:*' } })
  ]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert(fixture.root.startsWith('/tmp/release-fixture-'));
  assert.equal(JSON.parse(await readFile(resolve(fixture.root, 'package.json'))).name, 'fixture-root');
  await put(resolve(fixture.root, '.changeset/config.json'), {
    changelog: false,
    commit: false,
    fixed: [],
    linked: [],
    access: 'public',
    baseBranch: 'HEAD',
    updateInternalDependencies: 'patch',
    ignore: []
  });
  await put(
    resolve(fixture.root, '.changeset/fixture-version.md'),
    '---\n"@fixture/version-base": patch\n"@fixture/version-app": patch\n---\n\nDisposable fixture bump.\n'
  );
  const beforeLock = await readFile(resolve(fixture.root, 'pnpm-lock.yaml'), 'utf8');
  run(report, fixture.root, 'pnpm', ['exec', 'changeset', 'pre', 'enter', 'pre']);
  run(report, fixture.root, 'pnpm', ['exec', 'changeset', 'version']);
  assert.equal(JSON.parse(await readFile(resolve(fixture.root, 'nested/group/p0/package.json'))).version, '1.0.1-pre.0');
  run(report, fixture.root, 'pnpm', ['install', '--lockfile-only', '--offline', '--no-frozen-lockfile', '--ignore-scripts']);
  run(report, fixture.root, 'pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts']);
  const preLock = await readFile(resolve(fixture.root, 'pnpm-lock.yaml'), 'utf8');
  run(report, fixture.root, 'pnpm', ['exec', 'changeset', 'pre', 'exit']);
  run(report, fixture.root, 'pnpm', ['exec', 'changeset', 'version']);
  assert.equal(JSON.parse(await readFile(resolve(fixture.root, 'nested/group/p0/package.json'))).version, '1.0.1');
  run(report, fixture.root, 'pnpm', ['install', '--lockfile-only', '--offline', '--no-frozen-lockfile', '--ignore-scripts']);
  run(report, fixture.root, 'pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts']);
  await assert.rejects(() => readFile(resolve(fixture.root, '.changeset/pre.json')), { code: 'ENOENT' });
  assert.deepEqual(await sourceIdentity(repo, report), before);
  console.log(
    JSON.stringify({
      fixture: fixture.root,
      beforeLock,
      preLock,
      stableLock: await readFile(resolve(fixture.root, 'pnpm-lock.yaml'), 'utf8'),
      commands: report.invocations
    })
  );
});
