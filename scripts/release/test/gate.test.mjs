import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { sri } from '../workspace.mjs';
import { addRegistry, cli, manifest, packageArchive, policy, put, repo, rootManifest, workspace } from './fixtures.mjs';

function clean(t, fixture) {
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
}
function codes(result) {
  return result.report.diagnostics.map((entry) => entry.code);
}

test('actual pnpm discovery, build outputs, star/caret/tilde/alias rewrites; private and hooks never packed/executed', async (t) => {
  const hook = "node -e \"require('fs').writeFileSync('HOOK-RAN','bad')\"";
  const a = manifest('@fixture/a', {
    dependencies: { '@fixture/b': 'workspace:*', alias: 'workspace:@fixture/b@^' },
    devDependencies: { '@fixture/c': 'workspace:~' },
    peerDependencies: { '@fixture/c': 'workspace:^' },
    scripts: { prepack: hook, prepare: hook, postpack: hook }
  });
  const f = await workspace([a, manifest('@fixture/b'), manifest('@fixture/c'), manifest('private', { private: true, scripts: { prepack: 'exit 99' } })]);
  clean(t, f);
  await addRegistry(f, '@fixture/b', []);
  await addRegistry(f, '@fixture/c', []);
  const result = await cli(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.workspaces.length, 6);
  assert(result.report.workspaces.some((w) => w.name === 'fixture-root' && w.sourcePath === '.' && w.selection === 'private'));
  assert(result.report.workspaces.some((w) => w.name === 'fixture-website' && w.sourcePath === 'website'));
  assert(!result.report.workspaces.some((w) => w.name === 'excluded'));
  assert.equal(result.report.artifacts.length, 3);
  assert.equal(result.report.invocations.filter((i) => i.args.includes('pack')).length, 3);
  assert(result.report.invocations.filter((i) => i.args.includes('pack')).every((i) => i.ignoreScripts));
  const packed = result.report.artifacts.find((a) => a.manifest.name === '@fixture/a');
  assert.deepEqual(packed.manifest.dependencies, { '@fixture/b': '1.0.0', alias: 'npm:@fixture/b@^1.0.0' });
  assert.equal(packed.manifest.devDependencies['@fixture/c'], '~1.0.0');
  assert.equal(packed.manifest.peerDependencies['@fixture/c'], '^1.0.0');
  assert.match(packed.integrity, /^sha512-/);
  assert(packed.entries.some((e) => e.path === 'package/dist/index.d.ts'));
  await assert.rejects(access(resolve(f.root, 'nested/group/p0/HOOK-RAN')));
});

test('held diagnostics expose both private edges, canonical aliases, optional deps and required peers; unscoped names owned', async (t) => {
  const f = await workspace(
    [
      manifest('held', { dependencies: { alias: 'workspace:private-a@*' }, optionalDependencies: { 'private-b': 'workspace:*' } }),
      manifest('private-a', { private: true }),
      manifest('private-b', { private: true }),
      manifest('consumer', { peerDependencies: { held: 'workspace:*' } })
    ],
    { ...policy, holds: { held: { owner: 'maintainers', reason: 'private closure' } } }
  );
  clean(t, f);
  const result = await cli(f);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(codes(result).filter((c) => c === 'WITHHELD_EDGE').length, 3);
  assert.equal(result.report.artifacts.filter((a) => a.origin === 'held-audit').length, 1);
  assert(!result.report.artifacts.some((a) => a.manifest.private));
});

test('exact source pin selects original registry bytes, recursively diagnoses broken artifact despite healthy same-version local', async (t) => {
  const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': '1.0.0' } }), manifest('@fixture/b')], {
    ...policy,
    knownBad: { '@fixture/b': ['1.0.0'] }
  });
  clean(t, f);
  await addRegistry(f, '@fixture/b', [manifest('@fixture/b', { dependencies: { '@fixture/c': '1.0.0' } })]);
  await addRegistry(f, '@fixture/c', [manifest('@fixture/c', { dependencies: { '@fixture/d': 'workspace:*' } })]);
  const result = await cli(f);
  assert.equal(result.status, 1, result.stderr);
  assert(codes(result).includes('KNOWN_BAD_RANGE'));
  assert(codes(result).includes('SPEC'));
  const edge = result.report.edges.find((e) => e.package === '@fixture/a');
  assert.equal(edge.resolved.origin, 'fixture-registry');
  assert(result.report.diagnostics.some((d) => d.code === 'SPEC' && d.chain.length === 3));
});

test('healthy recursive registry cycle terminates and external edges remain explicitly unvalidated', async (t) => {
  const f = await workspace([manifest('@fixture/a', { dependencies: { alias: 'npm:@fixture/b@^1.0.0', lodash: '^4.0.0' } })]);
  clean(t, f);
  await addRegistry(f, '@fixture/b', [manifest('@fixture/b', { dependencies: { '@fixture/c': '^1.0.0' } })]);
  await addRegistry(f, '@fixture/c', [manifest('@fixture/c', { dependencies: { '@fixture/b': '^1.0.0' } })]);
  const result = await cli(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.artifacts.length, 3);
  assert(result.report.edges.some((e) => e.resolution === 'external-unvalidated'));
});

test('strict prerelease, missing required peers and present optional-peer mismatch', async (t) => {
  const f = await workspace([
    manifest('@fixture/a', {
      dependencies: { '@fixture/b': '^1.0.0' },
      peerDependencies: { '@fixture/c': '^2.0.0' },
      peerDependenciesMeta: { '@fixture/c': { optional: true } }
    }),
    manifest('@fixture/c')
  ]);
  clean(t, f);
  await addRegistry(f, '@fixture/b', [manifest('@fixture/b', { version: '1.1.0-pre.0' })]);
  await addRegistry(f, '@fixture/c', [manifest('@fixture/c')]);
  const result = await cli(f);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(codes(result).filter((c) => c === 'UNSATISFIED').length, 2);
});

test('optional peer absence is explicit deferred consumer proof', async (t) => {
  const f = await workspace([
    manifest('@fixture/a', { peerDependencies: { '@fixture/missing': '^1.0.0' }, peerDependenciesMeta: { '@fixture/missing': { optional: true } } })
  ]);
  clean(t, f);
  await addRegistry(f, '@fixture/missing', []);
  const result = await cli(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.report.edges[0].resolution, /optional-peer-absent/);
});

test('candidate cycle fails before any future publication', async (t) => {
  const f = await workspace([
    manifest('@fixture/a', { dependencies: { '@fixture/b': 'workspace:*' } }),
    manifest('@fixture/b', { dependencies: { '@fixture/a': 'workspace:*' } })
  ]);
  clean(t, f);
  await addRegistry(f, '@fixture/a', []);
  await addRegistry(f, '@fixture/b', []);
  const result = await cli(f);
  assert.equal(result.status, 1, result.stderr);
  assert(codes(result).includes('CANDIDATE_CYCLE'));
});

for (const failure of ['missing-fixture', 'integrity', 'metadata-identity', 'manifest-disagreement']) {
  test(`registry ${failure} exits 2, never network fallback`, async (t) => {
    const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': '1.0.0' } })]);
    clean(t, f);
    if (failure !== 'missing-fixture')
      await addRegistry(f, '@fixture/b', [manifest('@fixture/b')], {
        ...(failure === 'integrity' ? { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } : {}),
        ...(failure === 'manifest-disagreement' ? { packed: manifest('@fixture/b', { dependencies: { external: 'workspace:*' } }) } : {})
      });
    if (failure === 'metadata-identity') await put(resolve(f.registry, f.index['@fixture/b']), { name: 'wrong', versions: {} });
    const result = await cli(f);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.report.complete, false);
    assert(result.report.registrySnapshots.every((s) => s.origin === 'fixture'));
    if (failure === 'manifest-disagreement') assert(codes(result).includes('SPEC'));
  });
}

test('range admitting denied old version fails even with healthy latest; workspace overlap keeps original origin', async (t) => {
  const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': 'workspace:^' } }), manifest('@fixture/b', { version: '1.1.0' })], {
    ...policy,
    knownBad: { '@fixture/b': ['1.1.0'] }
  });
  clean(t, f);
  await addRegistry(f, '@fixture/b', [manifest('@fixture/b', { version: '1.1.0' }), manifest('@fixture/b', { version: '1.2.0' })]);
  const result = await cli(f);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.edges[0].resolved.origin, 'fixture-registry');
  assert(codes(result).includes('KNOWN_BAD_RANGE'));
});

test('CLI path rejects unsafe original tarball with verified integrity as artifact violation, not healthy metadata', async (t) => {
  const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': '1.0.0' } })]);
  clean(t, f);
  await addRegistry(f, '@fixture/b', [manifest('@fixture/b')]);
  const metadataPath = resolve(f.registry, f.index['@fixture/b']);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const bytes = packageArchive(manifest('@fixture/b'), [{ path: 'package/../escape' }]);
  metadata.versions['1.0.0'].dist.integrity = sri(bytes);
  await put(resolve(f.registry, metadata.versions['1.0.0'].dist.tarball), bytes);
  await put(metadataPath, metadata);
  const result = await cli(f);
  assert.equal(result.status, 1, result.stderr);
  assert(codes(result).includes('ARCHIVE'));
});

test('real registry network failure is incomplete exit 2, never clean or defect exit 1', async (t) => {
  const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': '1.0.0' } })]);
  clean(t, f);
  const guard = resolve(f.root, 'network-failure.mjs');
  await put(guard, "globalThis.fetch = () => { throw new Error('intentional network failure'); };\n");
  const result = spawnSync(process.execPath, ['--import', guard, resolve(repo, 'scripts/release/check.mjs'), '--output', f.output], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(await readFile(resolve(f.output, 'manifest.json'), 'utf8'));
  assert(report.diagnostics.some((d) => d.code === 'REGISTRY_INCOMPLETE' && d.message === 'intentional network failure'));
});

test('actual pack catches missing exports and dev-only residual without calling it production install failure', async (t) => {
  const f = await workspace([manifest('@fixture/a', { exports: './absent.js', devDependencies: { external: 'file:../local' } })]);
  clean(t, f);
  const result = await cli(f);
  assert.equal(result.status, 1, result.stderr);
  assert(codes(result).includes('CONTENT'));
  assert(result.report.diagnostics.some((d) => d.code === 'SPEC' && d.devOnly && d.message.startsWith('Dev-only hygiene')));
});

for (const [label, algorithms, corruptStrong, expected] of [
  ['SHA1 alone', ['sha1'], false, 2],
  ['SHA256', ['sha256'], false, 0],
  ['SHA384', ['sha384'], false, 0],
  ['SHA1 plus SHA512', ['sha1', 'sha512'], false, 0],
  ['valid SHA1 plus mismatched SHA512', ['sha1', 'sha512'], true, 2],
  ['malformed SHA512', [], false, 2]
]) {
  test(`strong registry integrity: ${label}`, async (t) => {
    const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': '1.0.0' } })]);
    clean(t, f);
    await addRegistry(f, '@fixture/b', [manifest('@fixture/b')]);
    const path = resolve(f.registry, f.index['@fixture/b']);
    const metadata = JSON.parse(await readFile(path, 'utf8'));
    const dist = metadata.versions['1.0.0'].dist;
    const bytes = await readFile(resolve(f.registry, dist.tarball));
    dist.integrity = algorithms.map((algorithm) => `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`).join(' ') || 'sha512-invalid';
    if (corruptStrong) dist.integrity = dist.integrity.replace(/sha512-\S+/, `sha512-${Buffer.alloc(64).toString('base64')}`);
    await put(path, metadata);
    const result = await cli(f);
    assert.equal(result.status, expected, result.stderr);
    assert.equal(result.report.complete, expected === 0);
    assert.equal(codes(result).includes('REGISTRY_INCOMPLETE'), expected === 2);
    const original = result.report.artifacts.find((a) => a.origin === 'fixture-registry');
    if (expected === 0) assert.equal(original.integrity, sri(bytes));
    else assert.equal(original, undefined);
  });
}

for (const suffix of ['', '+sha512.', '+sha512.a', `+sha512.${'a'.repeat(129)}`, `+sha512.${'g'.repeat(128)}`]) {
  test(`packageManager requires full SHA512 pin: ${suffix || 'absent'}`, async (t) => {
    const f = await workspace([manifest('@fixture/a')]);
    clean(t, f);
    const path = resolve(f.root, 'package.json');
    const root = JSON.parse(await readFile(path, 'utf8'));
    await put(path, { ...root, packageManager: rootManifest.packageManager.split('+')[0] + suffix });
    const result = await cli(f);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.report.complete, false);
    assert(result.report.diagnostics.some((d) => d.code === 'INPUT_INCOMPLETE' && /SHA512 integrity/.test(d.message)));
    assert.deepEqual(result.report.invocations, []);
    assert.deepEqual(result.report.artifacts, []);
  });
}

test('required owned registry 404 is incomplete', async (t) => {
  const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': '1.0.0' } })]);
  clean(t, f);
  const guard = resolve(f.root, 'network-404.mjs');
  await put(guard, 'globalThis.fetch = async () => new Response(null, {status: 404});\n');
  const result = spawnSync(process.execPath, ['--import', guard, resolve(repo, 'scripts/release/check.mjs'), '--output', f.output], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(result.status, 2, result.stderr);
});

test('range admitting bad original fails even when a newer healthy registry version is selected', async (t) => {
  const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': '^1.0.0' } })], { ...policy, knownBad: { '@fixture/b': ['1.0.0'] } });
  clean(t, f);
  await addRegistry(f, '@fixture/b', [manifest('@fixture/b', { dependencies: { external: 'workspace:*' } }), manifest('@fixture/b', { version: '1.1.0' })]);
  const result = await cli(f);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.edges[0].resolved.version, '1.1.0');
  assert(codes(result).includes('KNOWN_BAD_RANGE'));
  assert(codes(result).includes('SPEC'));
  assert.equal(result.report.artifacts.length, 3);
});

test('npm packument omission of pack-only files selector is not contradictory consumer metadata', async (t) => {
  const f = await workspace([manifest('@fixture/a', { dependencies: { '@fixture/b': '1.0.0' } })]);
  clean(t, f);
  await addRegistry(f, '@fixture/b', [manifest('@fixture/b')], { omitMetadataKeys: ['files'] });
  const result = await cli(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.artifacts.find((a) => a.origin === 'fixture-registry').manifest.files, ['dist']);
});
