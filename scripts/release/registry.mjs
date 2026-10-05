import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import semver from 'semver';
import ssri from 'ssri';
import { inspect, safePath } from './artifacts.mjs';
import { fields } from './specs.mjs';
import { diagnostic, hash, json, object } from './workspace.mjs';

async function get(url, registry, limit) {
  const parsed = new URL(url);
  if (parsed.origin !== new URL(registry).origin || parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Registry URL outside permitted anonymous HTTPS origin');
  const response = await fetch(parsed, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: { accept: 'application/json, application/octet-stream' }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry HTTP ${response.status}: ${parsed.pathname}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('Registry response size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function registryClient(policy, fixture, output, report) {
  const metadata = new Map();
  const artifacts = new Map();
  const fixtureIndex = fixture ? await json(resolve(fixture, 'index.json')) : null;
  if (fixture && !object(fixtureIndex)) throw new Error('Invalid fixture registry index');
  const directory = resolve(output, 'registry');
  await mkdir(directory);
  const state = { policy, fixture, fixtureIndex, directory, report, metadata, artifacts };
  return {
    metadata: (name) => loadMetadata(state, name),
    artifact: (name, version, chain) => loadArtifact(state, name, version, chain)
  };
}

async function fixtureBytes(state, path) {
  if (!safePath(path)) throw new Error('Invalid fixture file path');
  const bytes = await readFile(resolve(state.fixture, path));
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Fixture size limit');
  return bytes;
}

async function loadMetadata(state, name) {
  if (state.metadata.has(name)) return state.metadata.get(name);
  const { fixture, fixtureIndex, policy, report } = state;
  const bytes = fixture
    ? await fixtureBytes(state, fixtureIndex[name])
    : await get(`${policy.registry}${encodeURIComponent(name)}`, policy.registry, 16 * 1024 * 1024);
  const data = bytes ? JSON.parse(bytes.toString('utf8')) : { name, versions: {}, auditMissing: true };
  if (!object(data) || data.name !== name || !object(data.versions)) throw new Error(`Registry metadata identity/shape mismatch: ${name}`);
  for (const [version, manifest] of Object.entries(data.versions)) {
    if (semver.valid(version) !== version || !object(manifest) || manifest.name !== name || manifest.version !== version)
      throw new Error(`Registry version identity mismatch: ${name}@${version}`);
  }
  const snapshot = {
    name,
    origin: fixture ? 'fixture' : policy.registry,
    missing: bytes === null,
    sha256: bytes ? hash(bytes) : null,
    versions: Object.keys(data.versions)
  };
  report.registrySnapshots.push(snapshot);
  if (bytes) await writeFile(resolve(state.directory, `${encodeURIComponent(name)}.json`), bytes);
  state.metadata.set(name, data);
  return data;
}

function comparable(manifest, metadata) {
  const keys = [
    'name',
    'version',
    'private',
    ...fields,
    'peerDependenciesMeta',
    'main',
    'module',
    'types',
    'typings',
    'exports',
    'bin',
    'engines',
    'overrides',
    'resolutions',
    'publishConfig'
  ];
  // npm omits this pack-only selector; distribution is always checked in the archive.
  if (metadata.files !== undefined) keys.push('files');
  return canonical(Object.fromEntries(keys.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]])));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

async function loadArtifact(state, name, version, chain) {
  const key = `${name}@${version}`;
  if (state.artifacts.has(key)) return state.artifacts.get(key);
  const metadata = await loadMetadata(state, name);
  const expected = metadata.versions[version];
  if (!expected || !object(expected.dist) || typeof expected.dist.integrity !== 'string' || typeof expected.dist.tarball !== 'string')
    throw new Error(`Missing registry version/dist integrity: ${key}`);
  const bytes = state.fixture ? await fixtureBytes(state, expected.dist.tarball) : await get(expected.dist.tarball, state.policy.registry, 32 * 1024 * 1024);
  if (!bytes || !ssri.checkData(bytes, expected.dist.integrity, { error: false, strict: true }))
    throw new Error(`Registry integrity mismatch/missing strong integrity: ${key}`);
  const filename = `${encodeURIComponent(name)}-${version}.tgz`;
  await writeFile(resolve(state.directory, filename), bytes);
  const context = { package: name, version, origin: state.fixture ? 'fixture-registry' : 'registry', chain };
  const artifact = await inspect(bytes, expected, state.report, context);
  if (!artifact) {
    state.artifacts.set(key, null);
    return null;
  }
  if (JSON.stringify(comparable(artifact.manifest, expected)) !== JSON.stringify(comparable(expected, expected)))
    diagnostic(state.report, 'REGISTRY_MANIFEST_MISMATCH', `Registry metadata differs from original tarball: ${key}`, context, true);
  const result = { ...artifact, ...context, archive: `registry/${filename}`, registryIntegrity: expected.dist.integrity, tarball: expected.dist.tarball };
  state.artifacts.set(key, result);
  state.report.artifacts.push(result);
  return result;
}
