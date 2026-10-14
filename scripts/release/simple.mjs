/** biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Release commands run directly, never as cached Turbo tasks. */
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkArtifact, dependencyOrder, key, selectCandidates, verifyFiles } from './simple-check.mjs';
import { discover, hash, json, metadata, pins, prerequisites, registry, run } from './workspace.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export async function packOne(workspace, output, workspaces, policy, license) {
  const licensePath = resolve(workspace.path, 'LICENSE');
  const staging = await mkdtemp(resolve(output, 'pack-'));
  let added = false;
  try {
    try {
      await writeFile(licensePath, license, { flag: 'wx' });
      added = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    run('pnpm', ['pack', '--pack-destination', staging], workspace.path);
    const files = await readdir(staging);
    assert.equal(files.length, 1, 'Expected one pnpm archive');
    const file = files[0];
    assert.match(file, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.tgz$/);
    assert.ok(!(await readdir(output)).includes(file), 'Duplicate packed filename');
    const artifact = await checkArtifact(resolve(staging, file), workspace.manifest, workspaces, policy, license);
    await rename(resolve(staging, file), resolve(output, file));
    return { ...artifact, file };
  } finally {
    if (added) await rm(licensePath);
    await rm(staging, { recursive: true, force: true });
  }
}

export async function check(output, candidates, workspaces, policy, context) {
  await mkdir(output);
  const artifacts = [];
  const license = await readFile(resolve(root, 'LICENSE'));
  for (const workspace of candidates) artifacts.push(await packOne(workspace, output, workspaces, policy, license));
  const plan = { source: context.source, pins, tag: context.tag, artifacts: await dependencyOrder(artifacts, workspaces, metadata) };
  const bytes = `${JSON.stringify(plan, null, 2)}\n`;
  await writeFile(resolve(output, 'plan.json'), bytes);
  await verifyFiles(output, plan);
  console.log('Checked:', plan.artifacts.map(key).join(' '), 'plan SHA256:', hash(bytes));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `plan_sha256=${hash(bytes)}\n`);
  return plan;
}

export function publishArgs(file, tag) {
  return ['publish', file, '--ignore-scripts', '--access', 'public', '--provenance', '--tag', tag, '--registry', registry];
}

export function authorize(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Public writes only in the owned workflow');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.RELEASE_APPROVED, 'true', 'Explicit release approval required');
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim(), 'Missing GitHub OIDC request URL');
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim(), 'Missing GitHub OIDC request token');
  assert.ok(!env.NPM_TOKEN && !env.NODE_AUTH_TOKEN, 'Token fallback is forbidden');
}

export async function loadChecked(output, workspaces, policy, context) {
  const bytes = await readFile(resolve(output, 'plan.json'));
  assert.match(context.planHash || '', /^[a-f0-9]{64}$/, 'Missing qualification plan hash');
  assert.equal(hash(bytes), context.planHash, 'Changed plan');
  const plan = JSON.parse(bytes);
  assert.equal(plan.source, context.source, 'Changed source commit');
  assert.deepEqual(plan.pins, pins, 'Changed tool pins');
  assert.equal(plan.tag, context.tag, 'Changed channel');
  const candidates = selectCandidates(workspaces, policy, context.approved, context.tag, context.preMode);
  assert.deepEqual(plan.artifacts.map(key).sort(), candidates.map(key).sort(), 'Changed approval');
  await verifyFiles(output, plan);
  const license = await readFile(resolve(root, 'LICENSE'));
  for (const artifact of plan.artifacts) {
    const expected = candidates.find((w) => key(w) === key(artifact)).manifest;
    const checked = await checkArtifact(resolve(output, artifact.file), expected, workspaces, policy, license);
    assert.deepEqual(checked.manifest, artifact.manifest, 'Changed packed manifest');
  }
  return plan;
}

async function preflight(plan, readMetadata) {
  const matching = new Set();
  for (const artifact of plan.artifacts) {
    const remote = await readMetadata(artifact.manifest.name, artifact.manifest.version);
    if (remote === null) continue;
    assert.equal(remote.name, artifact.manifest.name, 'Existing version identity mismatch');
    assert.equal(remote.version, artifact.manifest.version, 'Existing version identity mismatch');
    assert.ok(remote.dist?.integrity?.split(/\s+/).includes(artifact.integrity), `Immutable version conflict: ${key(artifact)}`);
    matching.add(key(artifact));
  }
  return matching;
}

export async function publish(output, plan, workspaces, env = process.env, readMetadata = metadata, command = run, log = console.log) {
  authorize(env);
  await verifyFiles(output, plan);
  const ordered = await dependencyOrder(plan.artifacts, workspaces, readMetadata);
  assert.deepEqual(ordered.map(key), plan.artifacts.map(key), 'Changed dependency order');
  const matching = await preflight(plan, readMetadata);
  const summary = { published: [], skipped: [...matching], unknown: null, pending: plan.artifacts.map(key).filter((name) => !matching.has(name)) };
  for (const artifact of plan.artifacts) {
    if (matching.has(key(artifact))) continue;
    try {
      await command('npm', publishArgs(resolve(output, artifact.file), plan.tag), root);
    } catch (error) {
      summary.unknown = summary.pending.shift();
      log(JSON.stringify(summary));
      throw new Error(`Publication outcome UNKNOWN for ${key(artifact)}; stop and review before failed-job rerun`, { cause: error });
    }
    summary.published.push(summary.pending.shift());
    log(`Published ${key(artifact)}`);
  }
  log(JSON.stringify(summary));
  return summary;
}

async function contextFromSource() {
  const source = run('git', ['rev-parse', 'HEAD'], root);
  assert.match(source, /^[a-f0-9]{40}$/);
  if (process.env.GITHUB_ACTIONS === 'true') assert.equal(source, process.env.GITHUB_SHA, 'Event source mismatch');
  let preMode;
  try {
    preMode = (await json(resolve(root, '.changeset/pre.json'))).mode;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { source, preMode, approved: process.env.APPROVED_VERSIONS || '', tag: process.env.RELEASE_TAG, planHash: process.env.PLAN_SHA256 };
}

async function main() {
  const [operation, destination] = process.argv.slice(2);
  assert.ok(['approve', 'check', 'publish'].includes(operation), 'Usage: simple.mjs approve|check|publish OUTPUT');
  const policy = await prerequisites(root);
  const workspaces = await discover(root);
  const context = await contextFromSource();
  const candidates = selectCandidates(workspaces, policy, context.approved, context.tag, context.preMode);
  if (operation === 'approve') return console.log('Approved:', candidates.map(key).join(' '));
  assert.ok(destination, 'Output directory required');
  const output = resolve(destination);
  if (operation === 'check') return check(output, candidates, workspaces, policy, context);
  authorize();
  const plan = await loadChecked(output, workspaces, policy, context);
  return publish(output, plan, workspaces);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
