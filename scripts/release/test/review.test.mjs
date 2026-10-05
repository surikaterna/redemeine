import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { audit } from '../check.mjs';
import { addRegistry, cli, manifest, policy, put, workspace } from './fixtures.mjs';

for (const missing of ['version', 'index-entry', 'metadata-file', 'http-404']) {
  test(`known-bad candidate cannot pass with absent ${missing}`, async (t) => {
    const name = '@fixture/denied';
    const fixture = await workspace([manifest(name)], { ...policy, knownBad: { [name]: ['1.0.0'] } });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    if (missing === 'index-entry') await put(resolve(fixture.registry, 'index.json'), {});
    if (missing === 'metadata-file') await rm(resolve(fixture.registry, fixture.index[name]));
    let result;
    if (missing === 'http-404') {
      const requests = [];
      t.mock.method(globalThis, 'fetch', async (url) => {
        requests.push(String(url));
        return new Response(null, { status: 404 });
      });
      const status = await audit(fixture.root, { output: fixture.output });
      result = { status, report: JSON.parse(await readFile(resolve(fixture.output, 'manifest.json'), 'utf8')) };
      assert.deepEqual(requests, [`${policy.registry}${encodeURIComponent(name)}`]);
      assert.equal(result.report.registrySnapshots[0].missing, true);
    } else result = await cli(fixture);
    const incomplete = ['index-entry', 'metadata-file'].includes(missing);
    assert.equal(result.status, incomplete ? 2 : 1);
    assert.equal(result.report.complete, !incomplete);
    assert.equal(result.report.verdict, incomplete ? 'incomplete' : 'violations');
    assert(result.report.diagnostics.some((entry) => entry.code === (incomplete ? 'REGISTRY_INCOMPLETE' : 'KNOWN_BAD_ARTIFACT')));
  });
}

async function linkedFixture(t, kind, parent, internal = false) {
  const name = '@fixture/linked';
  const fixture = await workspace([manifest(name)]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const replay = await mkdtemp(resolve(tmpdir(), 'release-replay-'));
  t.after(() => rm(replay, { recursive: true, force: true }));
  await rename(fixture.registry, resolve(replay, 'registry'));
  fixture.registry = resolve(replay, 'registry');
  await addRegistry(fixture, name, [manifest(name)]);
  const index = 'index.json';
  const metadata = fixture.index[name];
  const data = JSON.parse(await readFile(resolve(fixture.registry, metadata), 'utf8'));
  const tarball = data.versions['1.0.0'].dist.tarball;
  const selected = kind.includes('metadata') ? metadata : kind.includes('tarball') ? tarball : index;
  const outside = resolve(internal ? fixture.registry : `${fixture.registry}-sibling`, 'files');
  const target = resolve(outside, selected);
  await put(target, kind.startsWith('malformed') ? 'harmless invalid bytes' : await readFile(resolve(fixture.registry, selected)));
  const link = parent ? 'linked' : selected;
  if (!parent) await rm(resolve(fixture.registry, selected));
  await symlink(parent ? outside : target, resolve(fixture.registry, link));
  if (parent && kind === 'metadata') {
    await put(resolve(fixture.registry, index), { [name]: `${link}/${selected}` });
  } else if (parent && kind === 'tarball') {
    data.versions['1.0.0'].dist.tarball = `${link}/${selected}`;
    await put(resolve(fixture.registry, metadata), data);
  } else if (parent) {
    await rm(resolve(fixture.registry, index));
    await symlink(`${link}/${selected}`, resolve(fixture.registry, index));
  }
  const marker = resolve(fixture.root, 'external-read');
  const preload = resolve(fixture.root, 'observe-read.mjs');
  await put(
    preload,
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFile;
fs.readFile = async function(path, ...args) {
  if (typeof path === 'string' && await fs.realpath(path).catch(() => '') === ${JSON.stringify(target)})
    await fs.writeFile(${JSON.stringify(marker)}, 'read');
  return original.call(this, path, ...args);
};
syncBuiltinESMExports();\n`
  );
  return { fixture, marker, env: { NODE_OPTIONS: `--import=${preload}` } };
}

for (const kind of ['index', 'metadata', 'tarball']) {
  for (const parent of [false, true]) {
    test(`fixture rejects external ${kind} ${parent ? 'parent' : 'file'} symlink before read`, async (t) => {
      const { fixture, marker, env } = await linkedFixture(t, kind, parent);
      const result = await cli(fixture, [], env);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.report.complete, false);
      assert(result.report.artifacts.some((entry) => entry.origin === 'candidate'));
      assert(result.report.diagnostics.some((entry) => /Fixture file escapes root/.test(entry.message)));
      await assert.rejects(access(marker), { code: 'ENOENT' });
      const evidence = await readdir(resolve(fixture.output, 'registry')).catch(() => []);
      assert(!evidence.some((file) => kind === 'metadata' || kind === 'index' || file.endsWith('.tgz')));
    });
  }
}

for (const kind of ['malformed-metadata', 'malformed-tarball']) {
  test(`fixture containment precedes external ${kind} parsing`, async (t) => {
    const { fixture, marker, env } = await linkedFixture(t, kind, false);
    const result = await cli(fixture, [], env);
    assert.equal(result.status, 2);
    assert(result.report.diagnostics.some((entry) => /Fixture file escapes root/.test(entry.message)));
    await assert.rejects(access(marker), { code: 'ENOENT' });
  });
}

for (const kind of ['index', 'metadata', 'tarball']) {
  test(`fixture permits contained ${kind} symlink through a symlinked root`, async (t) => {
    const { fixture, marker, env } = await linkedFixture(t, kind, true, true);
    const alias = resolve(fixture.root, 'fixture-alias');
    await symlink(fixture.registry, alias);
    fixture.registry = alias;
    const result = await cli(fixture, [], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.complete, true);
    await access(marker);
    assert(result.report.artifacts.some((entry) => entry.origin === 'fixture-registry'));
  });
}
