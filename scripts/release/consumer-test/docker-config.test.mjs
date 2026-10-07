import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { cli, manifest, repo, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';

const execute = promisify(execFile);
const moduleUrl = new URL('../consumer-docker.mjs', import.meta.url).href;
const imports = `import assert from 'node:assert/strict';
  import { readdirSync, statSync } from 'node:fs';
  import { docker, dockerRun, cleanup, tools } from ${JSON.stringify(moduleUrl)};`;

async function fakeDocker(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'docker-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = resolve(directory, 'calls.jsonl');
  const trap = resolve(directory, 'credential-trap');
  const home = resolve(directory, 'home');
  const ambient = resolve(directory, 'ambient');
  const temporary = resolve(directory, 'temporary');
  for (const path of [resolve(home, '.docker'), ambient, temporary]) await mkdir(path, { recursive: true });
  for (const path of [resolve(home, '.docker'), ambient]) {
    await writeFile(resolve(path, 'config.json'), JSON.stringify({ credsStore: 'trap', auths: { secret: { auth: 'DO_NOT_ADMIT' } } }));
  }
  await writeFile(resolve(directory, 'docker-credential-trap'), `#!/bin/sh\ntouch '${trap}'\n`, { mode: 0o755 });
  await writeFile(resolve(directory, 'docker'), fakeSource(log), { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    TMPDIR: temporary,
    HOME: home,
    DOCKER_CONFIG: ambient,
    DOCKER_CONTEXT: 'hostile',
    DOCKER_HOST: 'tcp://hostile:2375',
    SSH_AUTH_SOCK: '/hostile',
    DOCKER_AUTH_CONFIG: 'DO_NOT_ADMIT',
    NPM_TOKEN: 'DO_NOT_ADMIT',
    NODE_AUTH_TOKEN: 'DO_NOT_ADMIT'
  };
  return { directory, log, trap, temporary, env };
}

function fakeSource(log) {
  return `#!${process.execPath}
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const config = process.env.DOCKER_CONFIG || process.env.HOME + '/.docker';
    if (fs.existsSync(config + '/config.json')) {
      const settings = JSON.parse(fs.readFileSync(config + '/config.json'));
      if (settings.credsStore) cp.execFileSync('docker-credential-' + settings.credsStore);
    }
    const stat = fs.statSync(config);
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ config, args, env: process.env,
      uid: process.geteuid(), owner: stat.uid, mode: stat.mode & 0o777, entries: fs.readdirSync(config) }) + '\\n');
    fs.writeFileSync(config + '/probe-' + process.pid, 'writable');
    fs.unlinkSync(config + '/probe-' + process.pid);
    if (args[0] === 'fail') process.exit(7);
    if (args[0] === 'config') console.log(config);
  `;
}

async function child(fixture, body, prefix = '') {
  return execute(process.execPath, ['--input-type=module', '-e', `${prefix}\n${imports}\n${body}`], { env: fixture.env });
}

async function records(fixture) {
  return (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse);
}

async function assertRemoved(fixture) {
  assert.deepEqual(await readdir(fixture.temporary), []);
}

test('import is lazy; invalid temp parent rejects inside docker(), without ambient fallback', async (t) => {
  const fixture = await fakeDocker(t);
  fixture.env.TMPDIR = resolve(fixture.directory, 'missing', 'parent');
  const result = await child(fixture, `await assert.rejects(docker(['config']), { code: 'ENOENT' }); console.log('caught');`);
  assert.equal(result.stdout.trim(), 'caught');
  await assert.rejects(readFile(fixture.log), { code: 'ENOENT' });
});

test('concurrent callers/states share one private empty config; separate processes never share', async (t) => {
  const fixture = await fakeDocker(t);
  const body = `
    const states = [dockerRun('', {}), dockerRun('', {})];
    const configs = await Promise.all(Array.from({ length: 8 }, () => docker(['config'])));
    assert.equal(new Set(configs).size, 1);
    for (const state of states) {
      state.imageTags.push({ tag: state.id + ':node-' + tools.nodes[0].version });
      assert(await cleanup(state));
      assert(await cleanup(state));
    }
    assert.equal(await docker(['config']), configs[0]);
    await docker(['inspect', 'after-cleanup']);
    console.log(configs[0]);`;
  const children = await Promise.all([child(fixture, body), child(fixture, body)]);
  assert.notEqual(children[0].stdout, children[1].stdout);
  const calls = await records(fixture);
  assert.equal(new Set(calls.map((call) => call.config)).size, 2);
  for (const config of new Set(calls.map((call) => call.config))) assert.deepEqual(calls.find((call) => call.config === config).entries, []);
  for (const call of calls) {
    assert.equal(call.mode, 0o700);
    assert.equal(call.owner, call.uid);
    assert.deepEqual(
      call.entries.filter((entry) => !entry.startsWith('probe-')),
      []
    );
    assert.deepEqual(call.env, { PATH: fixture.env.PATH, HOME: '/nonexistent', DOCKER_CONFIG: call.config });
  }
  await assertRemoved(fixture);
  await assert.rejects(readFile(fixture.trap), { code: 'ENOENT' });
  // Positive controls prove both ambient config locations really contain executable helper traps.
  for (const useHome of [false, true]) {
    const env = { ...fixture.env };
    if (useHome) delete env.DOCKER_CONFIG;
    await execute(resolve(fixture.directory, 'docker'), ['config'], { env });
    await stat(fixture.trap);
    await rm(fixture.trap);
  }
});

test('Docker command failure retains its code and removes config after child exit', async (t) => {
  const fixture = await fakeDocker(t);
  await assert.rejects(child(fixture, `await assert.rejects(docker(['fail']), { code: 7 }); process.exitCode = 7;`), { code: 7 });
  assert.equal((await records(fixture))[0].args[0], 'fail');
  await assertRemoved(fixture);
});

for (const code of [0, 1, 2]) {
  test(`exit cleanup failure is visible and cannot turn exit ${code} into success`, async (t) => {
    const fixture = await fakeDocker(t);
    const prefix = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      fs.rmSync = () => { throw Error('injected removal failure'); }; syncBuiltinESMExports();`;
    await assert.rejects(child(fixture, `await docker(['config']); process.exitCode = ${code};`, prefix), (error) => {
      assert.equal(error.code, code || 1);
      assert.match(error.stderr, /Docker CLI config cleanup failed: injected removal failure/);
      return true;
    });
    assert.equal((await readdir(fixture.temporary)).length, 1);
  });
}

test('handled SIGTERM finishes Docker cleanup before config removal', async (t) => {
  const fixture = await fakeDocker(t);
  const body = `${imports}
    const state = dockerRun('', {});
    await docker(['config']);
    const timer = setInterval(() => {}, 1000);
    process.once('SIGTERM', async () => {
      assert(await cleanup(state)); await docker(['inspect', 'after-signal-cleanup']);
      clearInterval(timer); process.exitCode = 2;
    });
    console.log('ready');`;
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', body], { env: fixture.env });
  t.after(() => {
    if (processChild.exitCode === null) processChild.kill('SIGKILL');
  });
  const exit = new Promise((accept) => processChild.once('exit', (code, signal) => accept({ code, signal })));
  await new Promise((accept, reject) => {
    processChild.stdout.once('data', accept);
    processChild.once('error', reject);
    processChild.once('exit', () => reject(Error('Child exited before ready')));
  });
  processChild.kill('SIGTERM');
  assert.deepEqual(await exit, { code: 2, signal: null });
  assert.deepEqual((await records(fixture)).at(-1).args, ['inspect', 'after-signal-cleanup']);
  await assertRemoved(fixture);
});

test('consumer config setup failure remains exit2/incomplete with retained receipt', { timeout: 120000 }, async (t) => {
  const fake = await fakeDocker(t);
  const policyBytes = await readFile(resolve(repo, 'scripts/release/policy.json'));
  const fixture = await workspace([manifest('@fixture/config-setup')], JSON.parse(policyBytes));
  await writeFile(resolve(fixture.root, 'scripts/release/policy.json'), policyBytes);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal((await cli(fixture)).status, 0);
  const path = resolve(fixture.output, 'manifest.json');
  const output = resolve(fake.directory, 'qualification');
  await assert.rejects(
    execute(
      process.execPath,
      [resolve(repo, 'scripts/release/consumer.mjs'), '--manifest', path, '--manifest-sha256', hash(await readFile(path)), '--output', output],
      { env: { ...fake.env, TMPDIR: resolve(fake.directory, 'missing') } }
    ),
    { code: 2 }
  );
  const report = JSON.parse(await readFile(resolve(output, 'result.json'), 'utf8'));
  assert.equal(report.complete, false);
  assert.equal(report.exitCode, 2);
  assert.match(report.error, /ENOENT.*mkdtemp/);
  assert.equal(report.cleanup.complete, false);
  await assert.rejects(readFile(fake.log), { code: 'ENOENT' });
});

async function nonrootContext(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'docker-nonroot-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const node = resolve(directory, 'node');
  await copyFile(process.execPath, node);
  await chmod(node, 0o755);
  const work = resolve(directory, 'work');
  await mkdir(work, { mode: 0o700 });
  const uid = process.geteuid() === 0 ? 65534 : process.geteuid();
  const gid = process.geteuid() === 0 ? (await stat('/var/run/docker.sock')).gid : process.getegid();
  if (process.geteuid() === 0) await chown(work, uid, gid);
  return { node, work, uid, gid };
}

const nonrootBuild = `${imports}
  import { execFile } from 'node:child_process';
  import { writeFile } from 'node:fs/promises';
  import { promisify } from 'node:util';
  assert.notEqual(process.geteuid(), 0, 'Real build control must never run as root');
  await writeFile('Dockerfile', 'FROM scratch\\nCOPY marker /marker\\n');
  await writeFile('marker', 'nonroot Docker CLI build control');
  const state = dockerRun(process.cwd(), {});
  const tag = state.id + ':node-' + tools.nodes[0].version;
  state.imageTags.push({ tag });
  const args = ['build', '-t', tag, '.'];
  let before;
  try {
    await assert.rejects(promisify(execFile)('docker', args, {
      env: { PATH: process.env.PATH, HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' }
    }), (error) => { before = error.stderr; assert(before.includes('mkdir /nonexistent: permission denied')); return true; });
    await docker(args);
    assert(JSON.parse(await docker(['image', 'inspect', tag]))[0].Id);
  } finally {
    assert(await cleanup(state));
  }
  assert.equal(await docker(['image', 'ls', '-q', '--filter', 'reference=' + tag]), '');
  const configs = readdirSync(process.env.TMPDIR).filter((name) => name.startsWith('redemeine-docker-'));
  assert.equal(configs.length, 1);
  const config = process.env.TMPDIR + '/' + configs[0];
  const stat = statSync(config);
  assert.equal(stat.uid, process.geteuid()); assert.equal(stat.mode & 0o777, 0o700);
  console.log(JSON.stringify({ uid: process.geteuid(), gid: process.getegid(), config, before, build: 'passed', cleanup: state.report.cleanup }));`;

// Trusted host Docker-control test, not a consumer sandbox: no socket/config mounts or socket permission changes.
test('actual non-root Docker build fails with old config and succeeds with private config', { timeout: 120000 }, async (t) => {
  const context = await nonrootContext(t);
  const result = await execute(context.node, ['--input-type=module', '-e', nonrootBuild], {
    cwd: context.work,
    uid: context.uid,
    gid: context.gid,
    env: { PATH: process.env.PATH, TMPDIR: context.work },
    maxBuffer: 1024 * 1024
  });
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.uid, context.uid);
  assert.notEqual(proof.uid, 0);
  assert.equal(proof.build, 'passed');
  assert.equal(proof.cleanup.complete, true);
  await assert.rejects(stat(proof.config), { code: 'ENOENT' });
  console.log(`Non-root Docker proof: ${JSON.stringify(proof)}`);
});
