import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { x } from 'tar';
import { cli, manifest, put, repo, rootManifest, workspace } from './fixtures.mjs';

const sources = ['default-and-global-config', 'workspace-custom-and-global', 'lowercase-env-paths', 'uppercase-env-paths'];
const workflowEnvironment = {
  pnpm_config_ignore_pnpmfile: 'true',
  npm_config_ignore_pnpmfile: 'true',
  pnpm_config_ignore_scripts: 'true',
  npm_config_ignore_scripts: 'true',
  pnpm_config_verify_deps_before_run: 'false'
};
const workflowGuards = ['--config.ignore-pnpmfile=true', '--config.ignore-scripts=true'];

async function hookFixture(t, source) {
  const outside = await mkdtemp(resolve(tmpdir(), 'release-hook-paths-'));
  const marker = resolve(outside, 'pnpmfile.jsonl');
  const lifecycleMarker = resolve(outside, 'lifecycle-ran');
  const lifecycle = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(lifecycleMarker)}, 'ran')`)}`;
  const fixture = await workspace([manifest('@fixture/hooks', { scripts: { prepack: lifecycle, prepare: lifecycle, postpack: lifecycle } })]);
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const paths = { local: resolve(fixture.root, '.pnpmfile.cjs'), custom: resolve(outside, 'custom.cjs'), global: resolve(outside, 'global.cjs') };
  for (const [name, path] of Object.entries(paths)) {
    await put(
      path,
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify({name:${JSON.stringify(name)}, argv:process.argv})+'\\n'); module.exports={hooks:{readPackage:pkg=>pkg}};\n`
    );
  }
  const env = {
    XDG_CONFIG_HOME: resolve(outside, 'config'),
    pnpm_config_ignore_pnpmfile: 'false',
    PNPM_CONFIG_IGNORE_PNPMFILE: 'false',
    npm_config_ignore_pnpmfile: 'false',
    NPM_CONFIG_IGNORE_PNPMFILE: 'false',
    pnpm_config_ignore_scripts: 'false',
    PNPM_CONFIG_IGNORE_SCRIPTS: 'false',
    npm_config_ignore_scripts: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'false'
  };
  const settings = await configurePaths(source, paths, env);
  const yaml = await readFile(resolve(fixture.root, 'pnpm-workspace.yaml'), 'utf8');
  await put(resolve(fixture.root, 'pnpm-workspace.yaml'), `${yaml}ignorePnpmfile: false\nignoreScripts: false\n${settings}`);
  return { fixture, marker, lifecycleMarker, env, names: source === sources[0] ? ['local', 'global'] : ['custom', 'global'] };
}

async function configurePaths(source, paths, env) {
  if (source === 'default-and-global-config') {
    await put(resolve(env.XDG_CONFIG_HOME, 'pnpm/config.yaml'), `globalPnpmfile: ${JSON.stringify(paths.global)}\n`);
    return '';
  }
  if (source === 'workspace-custom-and-global') return `pnpmfile: ${JSON.stringify(paths.custom)}\nglobalPnpmfile: ${JSON.stringify(paths.global)}\n`;
  if (source === 'lowercase-env-paths') {
    env.pnpm_config_pnpmfile = paths.custom;
    env.pnpm_config_global_pnpmfile = paths.global;
  } else {
    env.PNPM_CONFIG_PNPMFILE = paths.custom;
    env.PNPM_CONFIG_GLOBAL_PNPMFILE = paths.global;
  }
  return '';
}

async function proveHooksAreActive(state) {
  const { fixture, marker, env, names } = state;
  const output = resolve(fixture.root, 'control-pack');
  await mkdir(output);
  const commands = [
    [fixture.root, ['--version']],
    [fixture.root, ['list', '--recursive', '--depth', '-1', '--json']],
    [resolve(fixture.root, 'nested/group/p0'), ['pack', '--pack-destination', output, '--json']]
  ];
  for (const [cwd, args] of commands) {
    const control = spawnSync('pnpm', [...args, '--config.ignore-scripts=true'], {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ...env, pnpm_config_ignore_scripts: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true' }
    });
    assert.equal(control.status, 0, control.stderr + control.stdout);
  }
  const executions = (await readFile(marker, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const name of names) {
    const matching = executions.filter((entry) => entry.name === name);
    assert.equal(matching.length, 3, `${name} must demonstrably execute for unguarded version, list and pack`);
    for (const command of ['--version', 'list', 'pack']) assert(matching.some((entry) => entry.argv.includes(command)));
  }
  await rm(marker);
}

for (const source of sources) {
  test(`gate suppresses actual pnpmfile and lifecycle execution: ${source}`, async (t) => {
    const state = await hookFixture(t, source);
    await proveHooksAreActive(state);
    await assert.rejects(access(state.lifecycleMarker), { code: 'ENOENT' });
    const result = await cli(state.fixture, [], state.env);
    assert.equal(result.status, 0, result.stderr);
    const invocations = result.report.invocations.filter((entry) => entry.command === 'pnpm');
    assert.equal(invocations.length, 3);
    for (const invocation of invocations) {
      assert(invocation.args.includes('--config.ignore-pnpmfile=true'));
      assert(invocation.args.includes('--config.ignore-scripts=true'));
      assert.equal(invocation.ignorePnpmfile, true);
      assert.equal(invocation.ignoreScripts, true);
      assert.equal(invocation.enforcedEnvironment.pnpm_config_ignore_pnpmfile, 'true');
      assert.equal(invocation.enforcedEnvironment.pnpm_config_ignore_scripts, 'true');
    }
    assert.deepEqual(result.report.workspaces.map((entry) => entry.name).sort(), ['@fixture/hooks', 'fixture-root', 'fixture-website']);
    assert.equal(result.report.artifacts.length, 1);
    await assert.rejects(access(state.marker), { code: 'ENOENT' });
    await assert.rejects(access(state.lifecycleMarker), { code: 'ENOENT' });
  });
}

async function workflowCommands(state, guarded) {
  const { fixture, env } = state;
  if (guarded) {
    const workflow = await readFile(resolve(repo, '.github/workflows/release-artifact-audit.yml'), 'utf8');
    for (const [key, value] of Object.entries(workflowEnvironment)) assert(workflow.includes(`  ${key}: '${value}'`));
    const invocations = [...workflow.matchAll(/run: (pnpm .+)/g)].map((match) => match[1]);
    assert.equal(invocations.length, 6);
    for (const invocation of invocations) assert(invocation.startsWith(`pnpm ${workflowGuards.join(' ')} `), invocation);
  }
  const commands = [
    ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'],
    ['run', 'probe'],
    ['exec', 'node', '--version']
  ];
  for (const args of commands) {
    const result = spawnSync('pnpm', [...(guarded ? workflowGuards : []), ...args], {
      cwd: fixture.root,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ...env, ...(guarded ? workflowEnvironment : {}) }
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    if (guarded) assert.equal(await readFile(state.marker, 'utf8').catch(() => ''), '', `guarded ${args.join(' ')}`);
  }
}

function prepareWorkflowLock(state, guarded) {
  // Hook-enabled and hook-disabled installs require different pnpmfile checksums.
  const result = spawnSync('pnpm', [...(guarded ? workflowGuards : []), 'install', '--no-frozen-lockfile', '--ignore-scripts', '--offline'], {
    cwd: state.fixture.root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...state.env, ...(guarded ? workflowEnvironment : {}) }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

async function proveImplicitInstall(state) {
  prepareWorkflowLock(state, true);
  const result = spawnSync('pnpm', [...workflowGuards, 'run', 'probe'], {
    cwd: state.fixture.root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...state.env, ...workflowEnvironment, pnpm_config_verify_deps_before_run: 'install' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const executions = (await readFile(state.marker, 'utf8')).trim().split('\n').map(JSON.parse);
  assert(executions.length > 0);
  assert(executions.every((entry) => entry.argv.includes('install') && !entry.argv.includes('--config.ignore-pnpmfile=true')));
  await access(state.lifecycleMarker);
  await rm(state.marker);
  await rm(state.lifecycleMarker);
}

for (const source of sources) {
  test(`workflow install/run/exec suppress pnpmfiles: ${source}`, async (t) => {
    const state = await hookFixture(t, source);
    await put(resolve(state.fixture.root, 'package.json'), {
      name: 'fixture-root',
      private: true,
      version: '1.0.0',
      packageManager: rootManifest.packageManager,
      scripts: { probe: 'node --version' }
    });
    prepareWorkflowLock(state, false);
    await rm(state.marker, { force: true });
    await workflowCommands(state, false);
    const executions = (await readFile(state.marker, 'utf8')).trim().split('\n').map(JSON.parse);
    for (const name of state.names) {
      for (const command of ['install', 'run', 'exec']) assert(executions.some((entry) => entry.name === name && entry.argv.includes(command)));
    }
    await rm(state.marker);
    if (source === sources[0]) await proveImplicitInstall(state);
    const setup = spawnSync('corepack', ['install'], {
      cwd: state.fixture.root,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ...state.env, ...workflowEnvironment }
    });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    await assert.rejects(access(state.marker), { code: 'ENOENT' });
    prepareWorkflowLock(state, true);
    assert.equal(await readFile(state.marker, 'utf8').catch(() => ''), '', 'guarded lock preparation');
    await workflowCommands(state, true);
    await assert.rejects(access(state.marker), { code: 'ENOENT' });
    await assert.rejects(access(state.lifecycleMarker), { code: 'ENOENT' });
  });
}

for (const suffix of ['#present', '?present', '%23present']) {
  test(`actual packed URL target ${suffix} fails the gate and Node resolution`, async (t) => {
    const target = `./dist/missing.js${suffix}`;
    const fixture = await workspace([manifest('@fixture/url-target', { type: 'module', exports: target })]);
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await put(resolve(fixture.root, 'nested/group/p0', target), 'export const value = 1;\n');
    const result = await cli(fixture);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.report.complete, true);
    assert(result.report.diagnostics.some((entry) => entry.code === 'CONTENT' && entry.field === 'exports' && /Unsupported URL/.test(entry.message)));
    const artifact = result.report.artifacts[0];
    assert(artifact.entries.some((entry) => entry.path === `package/${target.slice(2)}`));
    const consumer = resolve(fixture.root, 'consumer');
    await mkdir(consumer);
    await x({ cwd: consumer, file: resolve(fixture.output, artifact.archive) });
    const resolution = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', 'import("@fixture/url-target").catch(e=>{console.error(e.code+": "+e.message);process.exitCode=1})'],
      {
        cwd: resolve(consumer, 'package'),
        encoding: 'utf8',
        timeout: 120000
      }
    );
    assert.equal(resolution.status, 1, resolution.stderr);
    assert.match(resolution.stderr, /ERR_MODULE_NOT_FOUND/);
  });
}
