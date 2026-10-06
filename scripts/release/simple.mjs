/** biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Release commands run directly, never as cached Turbo tasks. */
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { cleanup, createContainer, docker, dockerRun, inspectOwned, network, provision } from './consumer-docker.mjs';
import { stage, startRegistry } from './quarantine.mjs';
import { registryClient } from './registry.mjs';
import { checkArtifact, chooseVersion, dependencyOrder, eligible, key, ownedEdges, selectCandidates, verifyFiles } from './simple-check.mjs';
import { discover, hash, json, prerequisites, run } from './workspace.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const report = { root, diagnostics: [], invocations: [], registrySnapshots: [], artifacts: [] };
const registry = 'https://registry.npmjs.org/';
const pnpm = (cwd, args) => run(report, cwd, 'pnpm', ['--config.verify-deps-before-run=false', ...args]);

async function packOne(workspace, output, workspaces, policy) {
  const license = await readFile(resolve(root, 'LICENSE'));
  const licensePath = resolve(workspace.path, 'LICENSE');
  let added = false;
  const before = await readdir(output);
  try {
    try {
      await writeFile(licensePath, license, { flag: 'wx' });
      added = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    pnpm(workspace.path, ['pack', '--pack-destination', output]);
  } finally {
    if (added) await rm(licensePath);
  }
  const files = (await readdir(output)).filter((file) => file.endsWith('.tgz') && !before.includes(file));
  assert.equal(files.length, 1, 'Expected one new pnpm archive');
  const artifact = await checkArtifact(resolve(output, files[0]), workspace.manifest, workspaces, policy, license);
  return { ...artifact, file: files[0], candidate: true };
}

async function existingArtifact(name, version, client, output, workspaces, policy) {
  const found = await client.artifact(name, version, [name]);
  assert.ok(found);
  assert.deepEqual(report.diagnostics, []);
  const file = `${encodeURIComponent(name)}-${version}.tgz`;
  await copyFile(resolve(output, found.archive), resolve(output, file));
  const checked = await checkArtifact(resolve(output, file), found.manifest, workspaces, policy, await readFile(resolve(root, 'LICENSE')));
  return { ...checked, file, candidate: false };
}

async function collect(output, workspaces, policy) {
  const client = await registryClient(policy, null, output, report);
  const artifacts = [];
  const { candidates, skipped } = await selectCandidates(workspaces, policy, client);
  for (const workspace of candidates) artifacts.push(await packOne(workspace, output, workspaces, policy));
  // Only walk owned edges; npm's isolated installs resolve external dependencies for real.
  for (let index = 0; index < artifacts.length; index++) {
    for (const [name, range] of ownedEdges(artifacts[index], workspaces, policy)) {
      const version = chooseVersion(name, range, artifacts, await client.metadata(name), policy);
      if (!artifacts.some((a) => a.manifest.name === name && a.manifest.version === version)) {
        artifacts.push(await existingArtifact(name, version, client, output, workspaces, policy));
      }
    }
  }
  return { artifacts: dependencyOrder(artifacts, workspaces, policy), skipped };
}

async function consumer(state, image, connection, plan) {
  const job = resolve(state.output, `job-${image.version}`);
  await mkdir(job);
  await copyFile(new URL('./simple-consume.mjs', import.meta.url), resolve(job, 'consume.mjs'));
  await copyFile(new URL('./fixtures/testing-consumer.ts', import.meta.url), resolve(job, 'testing-consumer.ts'));
  await writeFile(resolve(job, 'job.json'), JSON.stringify({
    endpoint: connection.endpoint, artifacts: plan.artifacts, owned: plan.owned, roots: plan.artifacts.filter((a) => a.candidate)
  }));
  const id = await createContainer(state, image.id, connection.internal, ['--memory', '2g', '--entrypoint', 'node'], ['/job/consume.mjs']);
  await docker(['cp', job, `${id}:/job`]);
  await inspectOwned(state, id, connection.internal, image.id);
  await docker(['start', id]);
  const exit = await docker(['wait', id], 600000);
  await docker(['cp', `${id}:/job/.`, job]);
  const result = await json(resolve(job, 'result.json'));
  console.log(`Node ${image.version}: ${result.roots.length} isolated roots; exit ${exit}`);
  assert.equal(exit, '0', result.error);
}

async function smoke(output, plan, publicRegistry = false) {
  if (!plan.artifacts.some((a) => a.candidate)) return;
  const directory = resolve(output, publicRegistry ? 'public-consumers' : 'local-consumers');
  await mkdir(directory);
  const evidence = {};
  const state = dockerRun(directory, evidence);
  try {
    const images = (await provision(state)).sort((a, b) => b.version.localeCompare(a.version));
    const connection = publicRegistry
      ? { endpoint: registry, internal: await network(state, false) }
      : await startRegistry(state, { graph: { owned: plan.owned } }, true);
    if (!publicRegistry) {
      const artifacts = plan.artifacts.map((a) => ({ ...a, copy: resolve(output, a.file), origins: [a.candidate ? 'candidate' : 'registry'] }));
      await stage(state, { artifacts }, { order: artifacts.map(key) }, connection, images[0]);
    }
    for (const image of images) await consumer(state, image, connection, plan);
  } finally {
    const cleaned = await cleanup(state);
    await writeFile(resolve(directory, 'report.json'), JSON.stringify(evidence, null, 2));
    assert.ok(cleaned, 'Local registry cleanup failed');
  }
}

async function check(output, policy, workspaces) {
  await mkdir(output);
  const { artifacts, skipped } = await collect(output, workspaces, policy);
  const plan = { artifacts, skipped, owned: { names: workspaces.map((w) => w.name), scopes: policy.internalScopes } };
  console.log('Candidates (approval must match exactly):', artifacts.filter((a) => a.candidate).map(key).join(' '));
  console.log('Already published (no mutation):', skipped.join(' '));
  await smoke(output, plan);
  await verifyFiles(output, plan);
  await writeFile(resolve(output, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const files = ['plan.json', ...artifacts.map((a) => a.file)];
  const sums = await Promise.all(files.map(async (file) => `${hash(await readFile(resolve(output, file)))}  ${file}`));
  await writeFile(resolve(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  await writeFile(resolve(output, 'checks.json'), JSON.stringify(report, null, 2));
}

export function approve(plan, approved, tag) {
  const candidates = plan.artifacts.filter((a) => a.candidate);
  assert.ok(candidates.length, 'No unpublished candidates');
  assert.deepEqual(approved.trim().split(/\s+/).sort(), candidates.map(key).sort(), 'Approval must list the exact candidate versions');
  assert.ok(tag === 'pre' || tag === 'latest', 'Choose pre or latest explicitly');
  if (tag === 'latest') assert.ok(candidates.every((a) => !semver.prerelease(a.manifest.version)), 'Exit Changesets prerelease mode before stable publication');
}

export function publishArgs(file, tag) {
  return ['publish', file, '--ignore-scripts', '--access', 'public', '--provenance=false', '--tag', tag, '--registry', registry];
}

function authorize() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Public writes only in the owned workflow');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.RELEASE_APPROVED, 'true', 'Protected npm-release approval required');
  assert.ok(process.env.NODE_AUTH_TOKEN, 'Missing owner-provided NPM_TOKEN');
}

async function loadChecked(output, policy, workspaces) {
  const plan = await json(resolve(output, 'plan.json'));
  const files = ['plan.json', ...plan.artifacts.map((a) => a.file)];
  await verifyFiles(output, plan);
  const sums = await Promise.all(files.map(async (file) => `${hash(await readFile(resolve(output, file)))}  ${file}`));
  assert.equal(await readFile(resolve(output, 'SHA256SUMS'), 'utf8'), `${sums.join('\n')}\n`);
  for (const artifact of plan.artifacts) {
    await checkArtifact(resolve(output, artifact.file), artifact.manifest, workspaces, policy, await readFile(resolve(root, 'LICENSE')));
    if (artifact.candidate) assert.ok(eligible(workspaces, policy).some((w) => w.name === artifact.manifest.name && w.version === artifact.manifest.version));
  }
  assert.deepEqual(dependencyOrder(plan.artifacts, workspaces, policy).map(key), plan.artifacts.map(key));
  return plan;
}

async function remoteClient(output, policy, operation) {
  const directory = resolve(output, operation);
  await mkdir(directory);
  return registryClient(policy, null, directory, report);
}

async function publish(output, plan, policy) {
  authorize();
  approve(plan, process.env.APPROVED_VERSIONS || '', process.env.RELEASE_TAG);
  const client = await remoteClient(output, policy, 'before-publish');
  const candidates = plan.artifacts.filter((a) => a.candidate);
  for (const artifact of candidates) {
    assert.ok(!(await client.metadata(artifact.manifest.name)).versions[artifact.manifest.version], `Version appeared after qualification: ${key(artifact)}; stop for manual review`);
  }
  for (const artifact of candidates) {
    await verifyFiles(output, plan);
    run(report, root, 'npm', publishArgs(resolve(output, artifact.file), process.env.RELEASE_TAG));
  }
}

async function verifyPublic(output, plan, policy) {
  const client = await remoteClient(output, policy, 'after-publish');
  for (const artifact of plan.artifacts) {
    const remote = await client.artifact(artifact.manifest.name, artifact.manifest.version, [key(artifact)]);
    assert.equal(remote?.sha256, artifact.sha256, `Public bytes differ: ${key(artifact)}`);
  }
  assert.deepEqual(report.diagnostics, []);
  await smoke(output, plan, true);
}

async function promote(output, plan, policy) {
  authorize();
  approve(plan, process.env.APPROVED_VERSIONS || '', process.env.RELEASE_TAG);
  const requested = (process.env.PROMOTE_LATEST || '').trim().split(/\s+/).filter(Boolean);
  assert.ok(requested.length && new Set(requested).size === requested.length, 'Explicit unique latest versions required');
  assert.ok(requested.every((entry) => plan.artifacts.some((a) => a.candidate && key(a) === entry)), 'Promotion outside approved candidates');
  const client = await remoteClient(output, policy, 'before-promotion');
  for (const entry of requested) {
    const artifact = plan.artifacts.find((a) => key(a) === entry);
    const remote = await client.artifact(artifact.manifest.name, artifact.manifest.version, [entry]);
    assert.equal(remote?.sha256, artifact.sha256);
  }
  assert.deepEqual(report.diagnostics, []);
  for (const entry of requested) run(report, root, 'npm', ['dist-tag', 'add', entry, 'latest', '--registry', registry]);
  const after = await remoteClient(output, policy, 'after-promotion');
  for (const entry of requested) {
    const { name, version } = plan.artifacts.find((a) => key(a) === entry).manifest;
    assert.equal((await after.metadata(name))['dist-tags']?.latest, version, `Latest tag readback failed: ${name}`);
  }
}

async function main() {
  const [operation, destination] = process.argv.slice(2);
  assert.ok(['check', 'publish', 'verify-public', 'promote'].includes(operation) && destination, 'Usage: simple.mjs check|publish|verify-public|promote OUTPUT');
  process.env.pnpm_config_verify_deps_before_run = 'false';
  const policy = await prerequisites(root, report);
  assert.equal(process.versions.node, '24.20.0');
  assert.equal(report.tools.npm, '11.19.0');
  const workspaces = await discover(root, policy, report);
  const output = resolve(destination);
  if (operation === 'check') return check(output, policy, workspaces);
  const plan = await loadChecked(output, policy, workspaces);
  if (operation === 'publish') return publish(output, plan, policy);
  if (operation === 'verify-public') return verifyPublic(output, plan, policy);
  return promote(output, plan, policy);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
