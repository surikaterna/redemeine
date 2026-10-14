import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { c } from 'tar';
import { authorize, loadChecked, publish, publishArgs } from './simple.mjs';
import { verifyFiles } from './simple-check.mjs';
import { execute, hash, metadata, pins, sri } from './workspace.mjs';

const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  RELEASE_APPROVED: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/never-requested',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-never-transmitted'
};
const policy = { holds: {} };
const noWrite = () => assert.fail('Public writes forbidden in tests');
const quiet = () => {};

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'release-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = resolve(directory, 'checked');
  await mkdir(output);
  await mkdir(resolve(directory, 'package'));
  await writeFile(resolve(directory, 'package/LICENSE'), await readFile(new URL('../../LICENSE', import.meta.url)));
  await writeFile(resolve(directory, 'package/index.js'), 'export {};');
  const artifacts = [];
  for (const name of ['first', 'second', 'third']) {
    const manifest = { name, version: '1.0.0', exports: './index.js' };
    await writeFile(resolve(directory, 'package/package.json'), JSON.stringify(manifest));
    const file = `${name}.tgz`;
    await c({ cwd: directory, file: resolve(output, file), gzip: true }, ['package']);
    const bytes = await readFile(resolve(output, file));
    artifacts.push({ manifest, file, sha256: hash(bytes), integrity: sri(bytes) });
  }
  const plan = { source: 'a'.repeat(40), pins, tag: 'pre', artifacts };
  const bytes = JSON.stringify(plan);
  await writeFile(resolve(output, 'plan.json'), bytes);
  const workspaces = artifacts.map(({ manifest }) => ({ name: manifest.name, version: manifest.version, manifest }));
  const context = { source: plan.source, planHash: hash(bytes), tag: plan.tag, approved: 'first@1.0.0 second@1.0.0 third@1.0.0' };
  return { output, plan, context, workspaces };
}

const remote = (artifact) => ({ ...artifact.manifest, dist: { integrity: artifact.integrity } });

test('OIDC main/manual approval requires every field and rejects token fallback without authentication calls', (t) => {
  t.mock.method(globalThis, 'fetch', noWrite);
  t.mock.method(childProcess, 'spawnSync', noWrite);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  authorize(env);
  for (const field of Object.keys(env)) {
    for (const value of [undefined, '', ' ']) assert.throws(() => authorize({ ...env, [field]: value }));
  }
  for (const change of [{ GITHUB_REF: 'refs/heads/other' }, { GITHUB_EVENT_NAME: 'push' }, { NPM_TOKEN: 'token' }, { NODE_AUTH_TOKEN: 'token' }]) {
    assert.throws(() => authorize({ ...env, ...change }));
  }
  assert.throws(() => authorize({ ...env, RELEASE_APPROVED: 'false' }), /Explicit release approval required/);
  assert.throws(() => authorize({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: '' }), /Missing GitHub OIDC request URL/);
});

test('metadata uses finite read-only npm argv; only explicit E404 is absence', () => {
  const good = { name: 'first', version: '1.0.0' };
  const exec = (command, args) => {
    assert.equal(command, 'npm');
    assert.deepEqual(args, ['view', 'first@1.0.0', '--json', '--registry', 'https://registry.npmjs.org/', '--fetch-retries=0', '--fetch-timeout=30000']);
    return { status: 0, stdout: JSON.stringify(good) };
  };
  assert.deepEqual(metadata('first', '1.0.0', exec), good);
  assert.equal(
    metadata('first', '1.0.0', () => ({ status: 1, stdout: '{"error":{"code":"E404"}}' })),
    null
  );
  for (const result of [
    { status: 1, stdout: '{"error":{"code":"E403"}}' },
    { status: 1, stdout: '{"error":{"code":"E500"}}' },
    { status: 0, stdout: 'null' },
    { status: 0, stdout: '[]' },
    { status: 0, stdout: 'bad' },
    { error: Error('timeout'), stdout: '' }
  ]) {
    assert.throws(() => metadata('first', '1.0.0', () => result));
  }
});

test('process seam proves exact file argv/provenance and guarded pnpm environment without executing npm', () => {
  const args = publishArgs('/tmp/checked.tgz', 'pre');
  assert.deepEqual(args, [
    'publish',
    '/tmp/checked.tgz',
    '--ignore-scripts',
    '--access',
    'public',
    '--provenance',
    '--tag',
    'pre',
    '--registry',
    'https://registry.npmjs.org/'
  ]);
  execute('npm', args, '/tmp', (command, actual, options) => {
    assert.equal(command, 'npm');
    assert.deepEqual(actual, args);
    assert.equal(options.timeout, 120000);
    return { status: 0, stdout: 'accepted' };
  });
  execute('pnpm', ['pack'], '/tmp', (command, actual, options) => {
    assert.equal(command, 'pnpm');
    assert.ok(actual.includes('--config.ignore-scripts=true') && actual.includes('--config.ignore-pnpmfile=true'));
    assert.equal(options.env.pnpm_config_ignore_scripts, 'true');
    assert.equal(options.env.pnpm_config_ignore_pnpmfile, 'true');
    assert.ok(!Object.keys(options.env).some((name) => /^npm_lifecycle_/i.test(name)));
    return { status: 0, stdout: '' };
  });
});

test('checked plan binds source, pins, approval, channel, hash and actual tar manifests', async (t) => {
  const { output, plan, context, workspaces } = await fixture(t);
  assert.deepEqual(await loadChecked(output, workspaces, policy, context), plan);
  for (const change of [{ planHash: undefined }, { planHash: 'b'.repeat(64) }, { source: 'b'.repeat(40) }, { tag: 'latest' }, { approved: 'first@1.0.0' }]) {
    await assert.rejects(loadChecked(output, workspaces, policy, { ...context, ...change }));
  }
  for (const change of [
    { pins: {} },
    { artifacts: [{ ...plan.artifacts[0], manifest: { ...plan.artifacts[0].manifest, dependencies: { x: '1.0.0' } } }, ...plan.artifacts.slice(1)] }
  ]) {
    const bytes = JSON.stringify({ ...plan, ...change });
    await writeFile(resolve(output, 'plan.json'), bytes);
    await assert.rejects(loadChecked(output, workspaces, policy, { ...context, planHash: hash(bytes) }));
  }
});

test('artifact allowlist rejects extra files, duplicates, traversal and symlink paths', async (t) => {
  const { output, plan } = await fixture(t);
  await verifyFiles(output, plan);
  for (const file of ['../escape.tgz', '/tmp/escape.tgz', 'first.tgz']) {
    const changed = structuredClone(plan);
    changed.artifacts[1].file = file;
    await assert.rejects(verifyFiles(output, changed));
  }
  await writeFile(resolve(output, 'extra'), 'unexpected');
  await assert.rejects(verifyFiles(output, plan), /Unexpected artifact files/);
  await rm(resolve(output, 'extra'));
  await rm(resolve(output, 'first.tgz'));
  await symlink('second.tgz', resolve(output, 'first.tgz'));
  await assert.rejects(verifyFiles(output, plan), /regular files/);
});

test('changed bytes/integrity and missing artifacts stop before registry requests or writes', async (t) => {
  const { output, plan, context, workspaces } = await fixture(t);
  const changed = structuredClone(plan);
  changed.artifacts[0].integrity = sri('different');
  await assert.rejects(publish(output, changed, workspaces, env, noWrite, noWrite, quiet), /Changed artifact integrity/);
  await writeFile(resolve(output, 'first.tgz'), 'changed');
  await assert.rejects(publish(output, plan, workspaces, env, noWrite, noWrite, quiet), /Changed artifact/);
  await rm(resolve(output, 'first.tgz'));
  await assert.rejects(loadChecked(output, workspaces, policy, context), /Unexpected artifact/);
  await rm(resolve(output, 'plan.json'));
  await assert.rejects(loadChecked(output, workspaces, policy, context), /ENOENT/);
});

test('batch matching skips only identical SHA512 bytes, preserving artifacts and not moving tags', async (t) => {
  const { output, plan, workspaces } = await fixture(t);
  const before = await readFile(resolve(output, 'first.tgz'));
  const result = await publish(output, plan, workspaces, env, (name) => remote(plan.artifacts.find((a) => a.manifest.name === name)), noWrite, quiet);
  assert.equal(result.skipped.length, 3);
  assert.deepEqual(result.published, []);
  assert.deepEqual(await readFile(resolve(output, 'first.tgz')), before);
});

test('a late immutable conflict or missing strong integrity anywhere prevents ALL batch writes', async (t) => {
  const { output, plan, workspaces } = await fixture(t);
  for (const integrity of [undefined, 'sha1-weak', sri('different')]) {
    const read = (name) => (name === 'third' ? { ...remote(plan.artifacts[2]), dist: { integrity } } : null);
    await assert.rejects(publish(output, plan, workspaces, env, read, noWrite, quiet), /Immutable version conflict/);
  }
  await assert.rejects(
    publish(output, plan, workspaces, env, () => ({ name: 'wrong' }), noWrite, quiet),
    /identity mismatch/
  );
});

test('npm exit zero is final success: all reads precede first write, with no subsequent GET or polling', async (t) => {
  const { output, plan, workspaces } = await fixture(t);
  const events = [];
  const read = (name) => {
    events.push(`read:${name}`);
    return null;
  };
  const command = (name, args) => {
    assert.equal(name, 'npm');
    events.push(`publish:${args[1]}`);
  };
  const result = await publish(output, plan, workspaces, env, read, command, quiet);
  assert.deepEqual(events.slice(0, 3), ['read:first', 'read:second', 'read:third']);
  assert.ok(events.slice(3).every((event) => event.startsWith('publish:')));
  assert.equal(events.length, 6);
  assert.equal(result.published.length, 3);
});

test('unknown second command stops once; same original artifacts on rerun skip accepted bytes and publish pending', async (t) => {
  const { output, plan, workspaces } = await fixture(t);
  const calls = [];
  const logs = [];
  const command = (name, args) => {
    calls.push(args);
    if (calls.length === 2) throw Error('network response lost');
  };
  await assert.rejects(
    publish(
      output,
      plan,
      workspaces,
      env,
      () => null,
      command,
      (line) => logs.push(line)
    ),
    /UNKNOWN for second/
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(logs.at(-1)), { published: ['first@1.0.0'], skipped: [], unknown: 'second@1.0.0', pending: ['third@1.0.0'] });
  const result = await publish(
    output,
    plan,
    workspaces,
    env,
    (name) => (name === 'third' ? null : remote(plan.artifacts.find((a) => a.manifest.name === name))),
    (name, args) => calls.push(args),
    quiet
  );
  assert.deepEqual(result.skipped, ['first@1.0.0', 'second@1.0.0']);
  assert.deepEqual(result.published, ['third@1.0.0']);
  assert.equal(calls.length, 3);
});

async function releaseWorkflow() {
  // Reuse Jest's locked YAML parser, not another direct release dependency.
  let require = createRequire(import.meta.url);
  for (const name of ['jest', 'jest-cli', 'jest-config']) require = createRequire(require.resolve(name));
  const text = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  return { text, workflow: require('js-yaml').load(text) };
}

test('workflow binds same-run artifact/hash and isolates manual main OIDC after all qualification gates', async () => {
  const { text, workflow: w } = await releaseWorkflow();
  assert.deepEqual(Object.keys(w.jobs).sort(), ['publish', 'qualify', 'version']);
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.deepEqual(w.jobs.publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(w.jobs.qualify.permissions, undefined);
  for (const job of Object.values(w.jobs)) assert.equal(job.environment, undefined);
  assert.equal(w.jobs.publish.if, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.publish == true");
  assert.equal(w.jobs.qualify.if, "github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')");
  assert.deepEqual(Object.entries(w.jobs).filter(([, job]) => job.permissions?.['id-token'] === 'write').map(([name]) => name), ['publish']);
  assert.equal(w.jobs.publish.needs, 'qualify');
  assert.deepEqual(Object.keys(w.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs).sort(), ['approved_versions', 'publish', 'tag']);
  assert.equal(w.on.workflow_dispatch.inputs.publish.type, 'boolean');
  assert.equal(w.on.workflow_dispatch.inputs.publish.required, true);
  assert.equal(w.on.workflow_dispatch.inputs.publish.default, false);
  assert.match(w.on.workflow_dispatch.inputs.publish.description, /false.*qualifies\/uploads only.*true.*registry writes/);
  assert.equal(w.on.workflow_dispatch.inputs.approved_versions.required, true);
  assert.equal(w.on.workflow_dispatch.inputs.tag.default, 'pre');
  assert.equal(w.concurrency['cancel-in-progress'], false);
  assert.doesNotMatch(text, /NPM_TOKEN|NODE_AUTH_TOKEN|registry-url|dist-tag|verify-public|promote|Docker|docker|environment:/);
  assert.match(text, /artifact-ids: \$\{\{ needs.qualify.outputs.artifact_id \}\}/);
  assert.match(text, /PLAN_SHA256: \$\{\{ needs.qualify.outputs.plan_sha256 \}\}/);
  const qualify = w.jobs.qualify.steps;
  assert.doesNotMatch(JSON.stringify(qualify), /inputs\.publish/);
  assert.ok(qualify.every((s) => !/simple\.mjs\s+publish\b|\bnpm\s+(?:publish|stage)\b/.test(s.run ?? '')));
  assert.equal(qualify.find((s) => s.id === 'upload').if, "github.event_name == 'workflow_dispatch'");
  assert.equal(qualify.find((s) => s.id === 'upload').with.name, 'checked-packages');
  const approveIndex = qualify.findIndex((s) => s.run === 'node scripts/release/simple.mjs approve');
  assert.ok(approveIndex < qualify.findIndex((s) => s.run === 'pnpm -r build'));
  assert.equal(qualify[approveIndex].if, "github.event_name == 'workflow_dispatch'");
  assert.ok(qualify.some((s) => s.run === 'pnpm run lint && pnpm run typecheck && pnpm test && pnpm run test:release:simple'));
  const pack = qualify.find((s) => s.id === 'pack');
  assert.equal(pack.env.APPROVED_VERSIONS, `\${{ inputs.approved_versions }}`);
  assert.equal(pack.if, "github.event_name == 'workflow_dispatch'");
  const commands = w.jobs.publish.steps.filter((s) => s.run?.startsWith('node scripts/release/simple.mjs'));
  assert.equal(commands.length, 1);
  assert.match(commands[0].run, / publish /);
  assert.equal(commands[0].env.RELEASE_APPROVED, 'true');
  assert.ok(w.jobs.publish.steps.every((s) => !/pnpm -r build|release:check/.test(s.run)));
  for (const use of text.matchAll(/uses: ([^\s]+)/g)) assert.match(use[1], /@[a-f0-9]{40}$/);
  const { scripts } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    Object.keys(scripts).filter((name) => name.includes('release')),
    ['release:check-simple', 'test:release:simple']
  );
});

test('both hosts enforce npm11.21/Node24.20; Changesets version job remains normal CLI2 path', async () => {
  const { workflow: w } = await releaseWorkflow();
  for (const name of ['qualify', 'publish']) {
    const steps = w.jobs[name].steps;
    const install = steps.find((s) => s.run?.includes('npm install --global'));
    assert.deepEqual(install.run.trim().split('\n'), [
      'npm install --global npm@11.21.0 --ignore-scripts --registry=https://registry.npmjs.org',
      'npm --version',
      'test "$(npm --version)" = 11.21.0'
    ]);
    assert.equal(steps.find((s) => s.uses?.startsWith('actions/setup-node@')).with['node-version'], '24.20.0');
  }
  assert.deepEqual(w.jobs.version.steps.find((s) => s.uses?.startsWith('changesets/action@')).with, {
    version: 'pnpm run version:packages',
    createGithubReleases: false
  });
  assert.equal(w.jobs.version.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
});
