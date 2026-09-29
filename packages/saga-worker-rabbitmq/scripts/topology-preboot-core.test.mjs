import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { cleanupOwned, ownedResources, OWNER_LABEL } from './topology-runner-ownership.mjs';
import { cleanupCookieHelper, createPrebootResources, helperOwnership, inspectPreboot, parsePrebootMetadata,
  prebootContainerArgs, prebootHelperArgs } from './topology-preboot-core.mjs';

const runId = 'topology-0123456789abcdef0123456789abcdef';
const names = { container: runId, volume: `${runId}-data`, network: `${runId}-net` };
const absent = (kind, name) => ({ code: 1, stderr: kind === 'volume' ?
  `Error response from daemon: get ${name}: no such volume` : kind === 'network' ?
    `Error response from daemon: network ${name} not found` : `Error response from daemon: No such container: ${name}` });

function fake(cookie = 'cookie:regular file:1:0:0:400', exitCode = 0) {
  const objects = new Map();
  const calls = [];
  const main = ownedResources(names, runId);
  const helper = helperOwnership(main);
  let interruptKind;
  const stored = (kind, name, owner = runId) => {
    const id = kind === 'volume' ? name : `${name}-id`;
    const labels = { [OWNER_LABEL]: owner };
    objects.set(name, kind === 'container' ? { Id: id, Name: `/${name}`, Config: { Labels: labels } } :
      { Name: name, Labels: labels });
    return id;
  };
  async function docker(args) {
    calls.push(args);
    const [kind, command, name] = args;
    if (command === 'inspect' && args.includes('{{json .}}')) return objects.has(name) ?
      { code: 0, stdout: JSON.stringify(objects.get(name)) } : absent(kind, name);
    if (kind === 'pull') return { code: 0 };
    if (kind === 'volume' && command === 'create') return { code: 0, stdout: stored('volume', args.at(-1)) };
    if (kind === 'create') {
      const target = args[args.indexOf('--name') + 1];
      const id = stored('container', target);
      if (interruptKind === target) throw new Error('interrupted after create');
      return { code: 0, stdout: id };
    }
    if (kind === 'container' && command === 'inspect' && args.includes('{{json .State}}')) return { code: 0,
      stdout: JSON.stringify({ Status: name === `${runId}-id` ? 'created' : 'exited', Running: false, ExitCode: exitCode }) };
    if (kind === 'start') return { code: cookie ? 0 : 1,
      stdout: `100\n101\ndir:directory:2:100:101:1777${cookie ? `\n${cookie}` : ''}`,
      stderr: cookie ? '' : "stat: can't stat '/var/lib/rabbitmq/.erlang.cookie': No such file or directory" };
    if (kind === 'rm' || (kind === 'volume' && command === 'rm')) { const entry = [...objects].find(([, object]) =>
      (object.Id ?? object.Name) === args.at(-1));
      if (entry) objects.delete(entry[0]); return { code: 0 }; }
    throw new Error('unexpected Docker operation');
  }
  return { docker, calls, objects, main, helper, stored, interruptOn: (name) => { interruptKind = name; } };
}

test('preboot creates main but never starts it, helper only is started with network none and readonly volume', async () => {
  const context = fake();
  assert.deepEqual(prebootContainerArgs(context.main), ['create', '--name', runId, '--label', `${OWNER_LABEL}=${runId}`,
    '--network', 'none', '--mount', `source=${names.volume},target=/var/lib/rabbitmq`, RABBIT_IMAGE]);
  const args = prebootHelperArgs(context.main, context.helper);
  assert.deepEqual(args.slice(0, 9), ['create', '--name', context.helper.names.container, '--label', `${OWNER_LABEL}=${runId}`,
    '--network', 'none', '--mount', `source=${names.volume},target=/var/lib/rabbitmq,readonly`]);
  assert.deepEqual(args.slice(9, 13), ['--entrypoint', '/bin/sh', RABBIT_IMAGE, '-c']);
  assert.match(args[13], /^id -u rabbitmq; id -g rabbitmq; stat -c/);
  assert.doesNotMatch(args[13], /\b(cat|od|sha256sum|cp|chmod|chown|tee|dd|sed|awk|echo|printf)\b/);
  await createPrebootResources(context.docker, context.main);
  const result = await inspectPreboot(context.docker, context.main, context.helper);
  assert.equal(result.main.status, 'created');
  assert.deepEqual(context.calls.filter(([kind]) => kind === 'start').map((args) => args.at(-1)), [`${runId}-helper-id`]);
  assert.equal((await cleanupCookieHelper(context.docker, context.helper)).absent, true);
  assert.equal((await cleanupOwned(context.docker, context.main)).absent, true);
});

test('copy-up absent cookie is valid data, not diagnostic failure or invented bytes', async () => {
  const context = fake(null);
  await createPrebootResources(context.docker, context.main);
  const result = await inspectPreboot(context.docker, context.main, context.helper);
  assert.deepEqual(result.metadata, { status: 'cookie-absent', cookieExists: false, rabbitUid: 100, rabbitGid: 101,
    directory: { type: 'directory', links: 2, uid: 100, gid: 101, mode: '1777' } });
  assert.equal((await cleanupCookieHelper(context.docker, context.helper)).absent, true);
  assert.equal((await cleanupOwned(context.docker, context.main)).absent, true);
});

test('regular, symlink and hardlink metadata are numeric/type only; unknown errors fail closed', () => {
  for (const [line, regular, nonSymlink, links] of [
    ['cookie:regular file:1:0:0:400', true, true, 1], ['cookie:symbolic link:1:0:0:777', false, false, 1],
    ['cookie:regular file:2:100:101:400', true, true, 2]
  ]) {
    const metadata = parsePrebootMetadata({ code: 0, stdout: `100\n101\ndir:directory:2:100:101:1777\n${line}` });
    assert.equal(metadata.cookieExists, true);
    assert.deepEqual([metadata.regular, metadata.nonSymlink, metadata.cookie.links], [regular, nonSymlink, links]);
    assert.doesNotMatch(JSON.stringify(metadata), /contents|password|secret/);
  }
  assert.deepEqual(parsePrebootMetadata({ code: 1, stdout: '100\n101\ndir:directory:2:100:101:1777', stderr: 'permission denied' }).cookieExists, null);
});

test('foreign collision and interrupted partial main creation preserve foreign and clean owned only', async () => {
  const foreign = fake();
  foreign.stored('container', runId, 'other');
  await assert.rejects(createPrebootResources(foreign.docker, foreign.main), /collision/);
  assert.equal((await cleanupOwned(foreign.docker, foreign.main)).absent, false);
  assert.equal(foreign.objects.get(runId).Config.Labels[OWNER_LABEL], 'other');
  const interrupted = fake();
  interrupted.interruptOn(runId);
  await assert.rejects(createPrebootResources(interrupted.docker, interrupted.main), /interrupted/);
  assert.equal((await cleanupCookieHelper(interrupted.docker, interrupted.helper)).absent, true);
  assert.equal((await cleanupOwned(interrupted.docker, interrupted.main)).absent, true);
  assert.equal(interrupted.objects.size, 0);
});
