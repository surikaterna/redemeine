import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect, inventory } from '../artifacts.mjs';
import { argumentsFor } from '../check.mjs';
import { edges, fields } from '../specs.mjs';
import { archive, manifest, packageArchive } from './fixtures.mjs';

for (const path of ['../escape', '/package/a', 'package/../a', 'package/a\\b', 'C:/package/a', 'elsewhere/a', 'package/./a', 'package//a']) {
  test(`reject unsafe archive path ${path}`, async () => {
    await assert.rejects(inventory(packageArchive(manifest('a'), [{ path }])));
  });
}
for (const type of ['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO']) {
  test(`reject archive ${type}`, async () => {
    await assert.rejects(inventory(packageArchive(manifest('a'), [{ path: 'package/evil', type, linkpath: '../../escape' }])));
  });
}
test('duplicate and file/directory collisions in either order, malformed and absent manifests', async () => {
  for (const entries of [
    [{ path: 'package/package.json', data: '{}' }],
    [{ path: 'package/dist' }],
    [{ path: 'package/a' }, { path: 'package/a/b' }],
    [{ path: 'package/a/b' }, { path: 'package/a' }]
  ])
    await assert.rejects(inventory(packageArchive(manifest('a'), entries)));
  await assert.rejects(inventory(archive([{ path: 'package/package.json', data: '{' }])));
  await assert.rejects(inventory(archive([{ path: 'package/README' }])));
  await assert.rejects(inventory(Buffer.from('not gzip')));
});

for (const field of ['main', 'module', 'types', 'typings', 'bin', 'exports']) {
  test(`missing packed ${field} target fails`, async () => {
    const report = { diagnostics: [] };
    const pkg = manifest('a', { [field]: './missing.js' });
    await inspect(packageArchive(pkg), pkg, report, {});
    assert(report.diagnostics.some((d) => d.code === 'CONTENT' && d.field === field));
  });
}
test('bin has no extension requirement but needs executable mode/shebang; exports null/conditions/arrays', async () => {
  const pkg = manifest('a', { bin: { a: './dist/cli' }, exports: { '.': { import: ['./dist/index.js'], types: './dist/index.d.ts' }, './blocked': null } });
  const report = { diagnostics: [] };
  await inspect(packageArchive(pkg, [{ path: 'package/dist/cli', data: '#!/usr/bin/env node\n', mode: 0o755 }]), pkg, report, {});
  assert.equal(report.diagnostics.length, 0);
  await inspect(packageArchive(pkg, [{ path: 'package/dist/cli', data: 'not a script', mode: 0o644 }]), pkg, report, {});
  assert.equal(report.diagnostics.length, 1);
});

test('identity and private flags fail even when content is healthy', async () => {
  const report = { diagnostics: [] };
  await inspect(packageArchive(manifest('different', { private: true })), manifest('a'), report, {});
  assert(report.diagnostics.some((d) => d.code === 'IDENTITY'));
});

for (const field of fields) {
  for (const spec of [
    'workspace:*',
    'workspace:^',
    'file:../local',
    'link:../local',
    'portal:../local',
    'catalog:',
    '../local',
    'npm:a@workspace:*',
    'npm:a@file:../local',
    'https://example.org/a.tgz',
    'github:org/repo',
    'latest'
  ]) {
    test(`${field} rejects ${spec}`, () => {
      const report = { diagnostics: [] };
      edges({ manifest: manifest('a', { [field]: { b: spec } }), origin: 'fixture' }, report, ['a']);
      assert.equal(report.diagnostics.length, 1);
      assert.equal(report.diagnostics[0].devOnly, field === 'devDependencies');
    });
  }
}

test('nested dependency overrides, resolutions, publishConfig and pnpm overrides are scanned', () => {
  const report = { diagnostics: [] };
  edges(
    {
      manifest: manifest('a', {
        overrides: { a: { b: 'workspace:*' } },
        resolutions: { a: 'file:../a' },
        publishConfig: { dependencies: { b: 'npm:b@workspace:*' } },
        pnpm: { overrides: { a: 'link:../a' } }
      })
    },
    report,
    ['a']
  );
  assert.equal(report.diagnostics.length, 4);
});
test('CLI rejects unknown options, positionals and relative output', () => {
  for (const args of [['--unknown'], ['position'], ['--output', 'relative']]) assert.throws(() => argumentsFor(args));
  assert.equal(argumentsFor(['--help']).help, true);
});

test('wildcard exports require matching files and aligned conditions, unsupported shapes fail explicitly', async () => {
  const healthy = manifest('a', { exports: { './*': { import: './dist/*.js', types: './dist/*.d.ts' } } });
  const report = { diagnostics: [] };
  await inspect(packageArchive(healthy), healthy, report, {});
  assert.equal(report.diagnostics.length, 0);
  const nested = { diagnostics: [] };
  await inspect(packageArchive(healthy, [{ path: 'package/dist/nested/other.js' }]), healthy, nested, {});
  assert(nested.diagnostics.some((d) => d.code === 'CONTENT'));
  for (const exports of [
    { './*': './missing/*.js' },
    { './*': './dist/index.js' },
    { '.': 42 },
    { './*': { import: './dist/*.js', types: './dist/*.d.ts' } }
  ]) {
    const result = { diagnostics: [] };
    const pkg = manifest('a', { exports });
    await inspect(packageArchive(pkg, [{ path: 'package/dist/other.js' }]), pkg, result, {});
    assert(result.diagnostics.some((d) => d.code === 'CONTENT'));
  }
});

test('non-export wildcards, invalid export conditions, encoded paths and override selectors fail closed', async () => {
  for (const extra of [{ main: './dist/*.js' }, { bin: {} }, { exports: { '.': { 0: './dist/index.js' } } }, { exports: './dist/%69ndex.js' }]) {
    const report = { diagnostics: [] };
    const pkg = manifest('a', extra);
    await inspect(packageArchive(pkg), pkg, report, {});
    assert(report.diagnostics.some((d) => d.code === 'CONTENT'));
  }
  const report = { diagnostics: [] };
  edges({ manifest: manifest('a', { overrides: { 'b@file:../local': '1.0.0' } }) }, report, ['a']);
  assert.equal(report.diagnostics[0].code, 'SPEC');
});
