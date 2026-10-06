import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import semver from 'semver';
import ssri from 'ssri';
import { inspect } from './artifacts.mjs';
import { boundedRead, newSnapshot, snapshotFile } from './consumer-files.mjs';
import { reconstructGraph } from './consumer-graph.mjs';
import { checkArchiveJson, parseJson } from './consumer-json.mjs';
import { demand, digest, inputVerdict, manifestSchema, policySchema } from './consumer-schema.mjs';
import { fields } from './specs.mjs';
import { hash } from './workspace.mjs';

export async function loadInput(path, expected, output, policyBytes) {
  digest.parse(expected);
  const bytes = await boundedRead(path, 16 * 1024 * 1024);
  demand(hash(bytes) === expected, 'A manifest digest mismatch');
  const raw = parseJson(bytes);
  const verdict = inputVerdict(raw);
  // Incomplete A runs can lack provenance; they never reach schema admission or Docker.
  if (verdict === 2) return { manifest: raw, bytes, digest: expected, verdict };
  const manifest = manifestSchema.parse(raw);
  const policy = policySchema.parse(parseJson(policyBytes));
  demand(
    hash(policyBytes) === manifest.inputs['scripts/release/policy.json'] && isDeepStrictEqual(policy, manifest.policy),
    'A policy does not match trusted policy bytes'
  );
  if (verdict === 1) return { manifest, bytes, digest: expected, verdict };
  const snapshot = await newSnapshot(dirname(path), output);
  const copies = [];
  const artifacts = await validateArtifacts(manifest, snapshot, copies);
  const metadata = await validateMetadata(manifest, snapshot, copies);
  validateMembership(manifest);
  const graph = reconstructGraph(manifest, metadata);
  return { manifest, bytes, digest: expected, verdict, artifacts, graph, copies };
}

async function validateArtifacts(manifest, snapshot, copies) {
  const identities = new Map();
  for (const entry of manifest.artifacts) {
    const copy = await snapshotFile(snapshot, entry.archive, entry.sha256, 32 * 1024 * 1024);
    const report = { diagnostics: [] };
    const actual = await inspect(copy.bytes, entry.manifest, report, {});
    demand(actual && !report.diagnostics.length, 'Archive inspection failed', 1);
    await checkArchiveJson(copy.bytes);
    for (const key of ['manifest', 'manifestSha256', 'entries', 'size', 'sha256', 'integrity']) {
      demand(isDeepStrictEqual(actual[key], entry[key]), `Archive ${key} differs from A evidence`);
    }
    validatePublishConfig(actual.manifest);
    const key = `${actual.manifest.name}@${actual.manifest.version}`;
    const previous = identities.get(key);
    demand(!previous || previous.sha256 === actual.sha256, 'Same name/version has different original bytes', 1);
    if (previous) previous.origins.push(entry.origin);
    else identities.set(key, { ...entry, copy: copy.copy, origins: [entry.origin] });
    const { bytes: omitted, ...receipt } = copy;
    copies.push(receipt);
  }
  return [...identities.values()];
}

export function validatePublishConfig(manifest) {
  const config = manifest.publishConfig;
  demand(
    config === undefined || (Object.keys(config).every((key) => key === 'access') && config.access === 'public'),
    'Unsafe/unsupported packed publishConfig',
    1
  );
  for (const key of ['overrides', 'resolutions', 'packageExtensions', 'pnpm']) {
    demand(manifest[key] === undefined, `Unsupported packed ${key}`);
  }
}

function validateMembership(manifest) {
  const names = new Set();
  const paths = new Set();
  for (const workspace of manifest.workspaces) {
    demand(!names.has(workspace.name) && !paths.has(workspace.sourcePath), 'Duplicate workspace');
    names.add(workspace.name);
    paths.add(workspace.sourcePath);
    const expected = Object.hasOwn(manifest.policy.holds, workspace.name) ? 'held-audit' : 'candidate';
    if (workspace.selection !== 'private') demand(workspace.selection === expected, 'Workspace hold policy mismatch');
    const matches = manifest.artifacts.filter(
      (a) =>
        a.sourcePath === workspace.sourcePath &&
        a.manifest.name === workspace.name &&
        a.manifest.version === workspace.version &&
        a.origin === workspace.selection
    );
    demand(matches.length === Number(workspace.selection !== 'private'), 'Incomplete/duplicate workspace artifact inventory');
  }
  for (const artifact of manifest.artifacts.filter((a) => ['candidate', 'held-audit'].includes(a.origin))) {
    demand(
      manifest.workspaces.some(
        (w) =>
          w.name === artifact.manifest.name &&
          w.sourcePath === artifact.sourcePath &&
          w.selection === artifact.origin &&
          w.version === artifact.manifest.version
      ),
      'Uninventoried local artifact'
    );
  }
}

async function validateMetadata(manifest, snapshot, copies) {
  const snapshots = new Map();
  for (const item of manifest.registrySnapshots) {
    demand(!snapshots.has(item.name), 'Duplicate registry snapshot');
    demand(item.missing === (item.sha256 === null), 'Contradictory registry snapshot');
    if (item.missing) {
      demand(!item.versions.length, 'Missing registry has versions');
      snapshots.set(item.name, { versions: {} });
      continue;
    }
    const copy = await snapshotFile(snapshot, `registry/${encodeURIComponent(item.name)}.json`, item.sha256, 16 * 1024 * 1024);
    const data = parseJson(copy.bytes);
    demand(data.name === item.name && data.versions && isDeepStrictEqual(Object.keys(data.versions), item.versions), 'Registry snapshot mismatch');
    for (const [version, entry] of Object.entries(data.versions)) {
      demand(semver.valid(version) === version && entry.name === item.name && entry.version === version, 'Registry metadata identity mismatch');
    }
    snapshots.set(item.name, data);
    const { bytes: omitted, ...receipt } = copy;
    copies.push(receipt);
  }
  for (const artifact of manifest.artifacts) {
    demand(snapshots.has(artifact.manifest.name), 'Missing registry snapshot for artifact');
    if (['registry', 'fixture-registry'].includes(artifact.origin)) {
      const recorded = manifest.registrySnapshots.find((item) => item.name === artifact.manifest.name);
      demand(recorded.origin === (artifact.origin === 'registry' ? manifest.policy.registry : 'fixture'), 'Registry snapshot origin mismatch');
      await bindRegistryArtifact(artifact, snapshots, snapshot);
    } else if (snapshots.get(artifact.manifest.name).versions[artifact.manifest.version]) {
      demand(
        manifest.artifacts.some(
          (a) =>
            ['registry', 'fixture-registry'].includes(a.origin) &&
            a.manifest.name === artifact.manifest.name &&
            a.manifest.version === artifact.manifest.version
        ),
        'Omitted original registry identity'
      );
    }
  }
  return snapshots;
}

async function bindRegistryArtifact(artifact, snapshots, snapshot) {
  const metadata = snapshots.get(artifact.manifest.name)?.versions[artifact.manifest.version];
  demand(metadata?.dist?.integrity === artifact.registryIntegrity && metadata.dist.tarball === artifact.tarball, 'Registry dist mismatch');
  demand(
    artifact.package === artifact.manifest.name &&
      artifact.version === artifact.manifest.version &&
      artifact.chain?.length > 0 &&
      artifact.sourcePath === undefined,
    'Registry artifact origin identity mismatch'
  );
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
  if (metadata.files !== undefined) keys.push('files');
  for (const key of keys) demand(isDeepStrictEqual(metadata[key], artifact.manifest[key]), 'Registry packed metadata mismatch');
  const copy = resolve(snapshot.output, `${[...snapshot.paths].indexOf(artifact.archive) + 1}.bin`);
  demand(ssri.checkData(await boundedRead(copy, 32 * 1024 * 1024), artifact.registryIntegrity, { strict: true }), 'Registry integrity mismatch');
  if (artifact.origin === 'registry') {
    const url = new URL(artifact.tarball);
    demand(url.origin === 'https://registry.npmjs.org' && !url.username && !url.password, 'Unsafe original registry URL');
  }
}
