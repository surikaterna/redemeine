import assert from 'node:assert/strict';
import { cp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { qualify } from '../consumer.mjs';
import { parseJson } from '../consumer-json.mjs';
import { addRegistry, archive, cli, manifest, workspace } from '../test/fixtures.mjs';
import { hash, sri } from '../workspace.mjs';

async function control(t) {
  const fixture = await workspace([manifest('@fixture/root', { dependencies: { '@fixture/dependency': '1.0.0' } })]);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await addRegistry(fixture, '@fixture/dependency', [manifest('@fixture/dependency')]);
  assert.equal((await cli(fixture)).status, 0);
  return fixture;
}

async function rejectMutation(fixture, index, mutate, code) {
  const directory = resolve(fixture.root, `mutation-${index}`);
  await cp(fixture.output, directory, { recursive: true });
  const path = resolve(directory, 'manifest.json');
  const data = JSON.parse(await readFile(path));
  const raw = await mutate(data, directory);
  await writeFile(path, raw || JSON.stringify(data, null, 2));
  const report = await qualify(
    { manifest: path, 'manifest-sha256': hash(await readFile(path)), output: resolve(fixture.root, `result-${index}`), root: ['@fixture/root@1.0.0'] },
    await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
  );
  assert.equal(report.exitCode, code, report.error);
  assert.equal(report.images, undefined);
  assert.equal(report.staging.receipts.length, 0);
}

async function replaceArchive(data, directory, bytes) {
  const artifact = data.artifacts[0];
  Object.assign(artifact, { size: bytes.length, sha256: hash(bytes), integrity: sri(bytes) });
  await writeFile(resolve(directory, artifact.archive), bytes);
}

test('strict JSON rejects duplicate decoded keys, syntax extensions and bounded nesting', () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"nested":{"x":0,"x":1}}',
    '{/*comment*/"a":1}',
    '{"a":1,}',
    `${'['.repeat(65)}0${']'.repeat(65)}`
  ]) {
    assert.throws(() => parseJson(Buffer.from(text)));
  }
  assert.deepEqual(parseJson(Buffer.from('{"a":{"x":1},"b":{"x":2}}')), { a: { x: 1 }, b: { x: 2 } });
  assert.throws(() => parseJson(Buffer.from([0xff])), /encoded data/);
});

test('B admission rejects unsafe/truncated/oversized actual archives before Docker', async (t) => {
  const fixture = await control(t);
  const badEntries = [
    { path: 'package/../../escape', data: 'bad' },
    { path: '/package/absolute', data: 'bad' },
    { path: 'package/back\\slash', data: 'bad' },
    { path: 'package/link', type: 'SymbolicLink', linkpath: '../../outside' },
    { path: 'package/link', type: 'Link', linkpath: '/etc/passwd' }
  ];
  for (const [index, entry] of badEntries.entries()) {
    await rejectMutation(
      fixture,
      index,
      async (data, directory) =>
        replaceArchive(data, directory, archive([{ path: 'package/package.json', data: JSON.stringify(data.artifacts[0].manifest) }, entry])),
      1
    );
  }
  await rejectMutation(
    fixture,
    'truncated',
    async (data, directory) => {
      const bytes = await readFile(resolve(directory, data.artifacts[0].archive));
      await replaceArchive(data, directory, bytes.subarray(0, bytes.length - 12));
    },
    1
  );
  await rejectMutation(fixture, 'expanded-limit', async (data, directory) => replaceArchive(data, directory, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1))), 1);
  await rejectMutation(
    fixture,
    'compressed-limit',
    async (data, directory) => {
      const file = await open(resolve(directory, data.artifacts[0].archive), 'r+');
      try {
        await file.truncate(32 * 1024 * 1024 + 1);
      } finally {
        await file.close();
      }
    },
    2
  );
});

test('B validates metadata, origin ambiguity, duplicate JSON and contained files', async (t) => {
  const fixture = await control(t);
  const cases = {
    'duplicate-manifest': (data) => JSON.stringify(data).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    'metadata-hash': async (data, directory) => writeFile(resolve(directory, 'registry/%40fixture%2Fdependency.json'), '{}'),
    'metadata-dist': async (data, directory) => {
      const path = resolve(directory, 'registry/%40fixture%2Fdependency.json');
      const metadata = JSON.parse(await readFile(path));
      metadata.versions['1.0.0'].dist.integrity = sri('wrong');
      const bytes = Buffer.from(JSON.stringify(metadata));
      await writeFile(path, bytes);
      data.registrySnapshots.find((s) => s.name === '@fixture/dependency').sha256 = hash(bytes);
    },
    'duplicate-metadata': async (data, directory) => {
      const path = resolve(directory, 'registry/%40fixture%2Fdependency.json');
      const bytes = Buffer.from((await readFile(path, 'utf8')).replace('"name":', '"name":"ignored","name":'));
      await writeFile(path, bytes);
      data.registrySnapshots.find((s) => s.name === '@fixture/dependency').sha256 = hash(bytes);
    },
    'ambiguous-edge': async (data, directory) => {
      const artifact = structuredClone(data.artifacts.find((a) => a.origin === 'fixture-registry'));
      await cp(resolve(directory, artifact.archive), resolve(directory, 'duplicate.tgz'));
      artifact.archive = 'duplicate.tgz';
      data.artifacts.push(artifact);
    },
    'missing-original': (data) => {
      data.artifacts = data.artifacts.filter((a) => a.origin === 'candidate');
    },
    'escaping-parent': async (data, directory) => {
      await symlink(fixture.output, resolve(directory, 'escape'));
      data.artifacts[0].archive = `escape/${data.artifacts[0].archive}`;
    },
    'invalid-hash': (data) => {
      data.artifacts[0].manifestSha256 = 'not-a-hash';
    },
    'snapshot-origin': (data) => {
      data.registrySnapshots.find((s) => s.name === '@fixture/dependency').origin = 'https://registry.npmjs.org/';
    },
    'wrong-size': (data) => {
      data.artifacts[0].size++;
    },
    'encoded-escape': (data) => {
      data.artifacts[0].archive = '%2e%2e%2foutside.tgz';
    }
  };
  for (const [name, mutate] of Object.entries(cases)) await rejectMutation(fixture, name, mutate, 2);
});

test('packed duplicate JSON keys and publishConfig redirects fail before any registry write', async (t) => {
  const fixture = await control(t);
  await rejectMutation(
    fixture,
    'packed-duplicate',
    async (data, directory) => {
      const pkg = JSON.stringify(data.artifacts[0].manifest).replace('"name":', '"name":"ignored","name":');
      await replaceArchive(
        data,
        directory,
        archive([
          { path: 'package/package.json', data: pkg },
          { path: 'package/dist/index.js', data: 'export const value=42;' },
          { path: 'package/dist/index.d.ts', data: 'export declare const value:number;' }
        ])
      );
    },
    2
  );
  for (const [index, publishConfig] of [
    { registry: 'https://registry.npmjs.org/' },
    { registry: 'http://127.0.0.1:4873/' },
    { access: 'restricted' },
    { provenance: true },
    { tag: 'latest' }
  ].entries()) {
    const other = await workspace([manifest('@fixture/target', { publishConfig })]);
    t.after(() => rm(other.root, { recursive: true, force: true }));
    assert.equal((await cli(other)).status, 0);
    await rejectMutation(other, `publish-${index}`, () => undefined, 1);
  }
});
