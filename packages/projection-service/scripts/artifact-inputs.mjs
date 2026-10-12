import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const protectedManifest = '92a2b19da875987c819ff3283845839323a9652d522f8d00f0d62ebd5ca0da5e';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const gitBlob = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export async function verifyRuntime() {
  const manifest = await readFile('scripts/protected-runtime.manifest', 'utf8');
  if (sha256(manifest) !== protectedManifest) throw new Error('protected_manifest_mismatch');
  for (const line of manifest.trimEnd().split('\n')) {
    const [expected, path] = line.split('  ');
    if (gitBlob(await readFile(resolve('../..', path))) !== expected) throw new Error('protected_runtime_changed');
  }
}

export async function inputHashes(directory) {
  const meta = JSON.parse(await readFile(`${directory}/metafile-esm.json`, 'utf8'));
  if (directory === 'dist-worker' && Object.keys(meta.inputs).some((path) => /src\/(reference\/|fixtureRegistry|referenceRegistry|infrastructure\/mongoFixtures)|\/integration\/|\/test\//.test(path))) {
    throw new Error('worker_fixture_dependency');
  }
  const entries = [];
  for (const path of Object.keys(meta.inputs).sort()) entries.push([path, sha256(await readFile(path))]);
  return Object.fromEntries(entries);
}
