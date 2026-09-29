import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { OWNER_LABEL, ownedResources } from './topology-runner-ownership.mjs';
import { cleanupCookieHelper } from './topology-diagnostic-cookie.mjs';
import { cookiePrepArgs, prepOwnership, prepareCookieBeforeRabbit } from './topology-runner-cookie-prep.mjs';

const runId = 'topology-0123456789abcdef0123456789abcdef';
const names = { container: runId, volume: `${runId}-data`, network: `${runId}-net` };

function fake(code = 0) {
  const main = ownedResources(names, runId);
  main.ids.volume = names.volume;
  const helper = prepOwnership(main);
  const calls = [];
  let helperObject = null;
  let volumeOwner = runId;
  let createFailure = false;
  async function docker(args) {
    calls.push(args);
    const [kind, action, name] = args;
    if (kind === 'volume' && action === 'inspect') return { code: 0,
      stdout: JSON.stringify({ Name: names.volume, Labels: { [OWNER_LABEL]: volumeOwner } }) };
    if (kind === 'container' && action === 'inspect' && name === helper.names.container) return helperObject ?
      { code: 0, stdout: JSON.stringify(helperObject) } : { code: 1, stderr: `Error response from daemon: No such container: ${name}` };
    if (kind === 'container' && action === 'inspect' && name === 'helper-id') return { code: 0,
      stdout: JSON.stringify({ Status: 'exited', ExitCode: code, OOMKilled: false }) };
    if (kind === 'create') {
      helperObject = { Id: 'helper-id', Name: `/${helper.names.container}`, Config: { Labels: { [OWNER_LABEL]: runId } } };
      if (createFailure) throw new Error('audit interrupted');
      return { code: 0, stdout: 'helper-id' };
    }
    if (kind === 'start') return { code: 0, stdout: '', stderr: '' };
    if (kind === 'rm') { helperObject = null; return { code: 0 }; }
    throw new Error(`unexpected docker command: ${kind} ${action}`);
  }
  return { docker, main, helper, calls, wrongVolume: () => { volumeOwner = 'foreign'; }, failCreate: () => { createFailure = true; } };
}

test('root helper only mounts owned volume RW, checks copy-up and metadata, chowns -h exact cookie without output', () => {
  const context = fake();
  const args = cookiePrepArgs(context.main, context.helper);
  assert.deepEqual(args.slice(0, 14), ['create', '--name', context.helper.names.container, '--label', `${OWNER_LABEL}=${runId}`,
    '--network', 'none', '--mount', `source=${names.volume},target=/var/lib/rabbitmq`, '--user', '0:0',
    '--entrypoint', '/bin/sh', RABBIT_IMAGE]);
  assert.equal(args[14], '-c');
  const shell = args[15];
  assert.match(shell, /\[ -e "\$cookie" \] \|\| exit 42/);
  assert.match(shell, /regular file:1:0:0:400/);
  assert.match(shell, /regular file:1:100:101:400/);
  assert.match(shell, /chown -h 100:101 "\$cookie"/);
  assert.match(shell, /after=\$\(stat -c '%F:%h:%u:%g:%a' "\$cookie"\)/);
  assert.doesNotMatch(shell, /\b(cat|od|sha256sum|cp|chmod|chown -R|tee|dd|sed|awk|echo|printf)\b/);
  assert.equal(shell.match(/chown /g)?.length, 1);
});

test('copy-up-created root:root cookie and already-correct cookie require verified helper exit and cleanup before main start', async () => {
  for (const condition of ['copy-up-present-root', 'already-rabbit-owned']) {
    const context = fake(0);
    const receipt = {};
    assert.deepEqual(await prepareCookieBeforeRabbit(context.docker, context.main, context.helper, receipt),
      { status: 'prepared', rabbitUid: 100, rabbitGid: 101, mode: '0400', linkCount: 1 });
    assert.equal(receipt.cookiePrepCleanup.absent, true, condition);
    assert.deepEqual(context.calls.filter(([kind]) => kind === 'rm').map((args) => args.at(-1)), ['helper-id']);
    assert.equal(context.calls.some((args) => args.includes(names.container) && args[0] === 'run'), false);
  }
});

test('copy-up-absent, symlink, hardlink, wrong owner/mode and failed chown all stop before main broker start', async () => {
  for (const [condition, exitCode] of [
    ['copy-up-absent', 42], ['symlink', 43], ['hardlink', 43], ['wrong-owner', 43], ['wrong-mode', 43], ['chown-failed', 44]
  ]) {
    const context = fake(exitCode);
    const receipt = {};
    await assert.rejects(prepareCookieBeforeRabbit(context.docker, context.main, context.helper, receipt), /failed closed/, condition);
    assert.equal(receipt.cookiePrepCleanup.absent, true);
    assert.equal(context.calls.some(([kind]) => kind === 'run'), false);
    assert.doesNotMatch(JSON.stringify(receipt), /password|private|secret/);
  }
});

test('helper interrupted after Docker create but before ID reply is cleaned; foreign volume is never mounted', async () => {
  const interrupted = fake();
  interrupted.failCreate();
  const receipt = {};
  await assert.rejects(prepareCookieBeforeRabbit(interrupted.docker, interrupted.main, interrupted.helper, receipt), /failed closed/);
  assert.deepEqual(interrupted.helper.ids, {});
  assert.equal(receipt.cookiePrepCleanup.absent, true);
  const foreign = fake();
  foreign.wrongVolume();
  await assert.rejects(prepareCookieBeforeRabbit(foreign.docker, foreign.main, foreign.helper, {}), /failed closed/);
  assert.equal(foreign.calls.some(([kind]) => kind === 'create' || kind === 'start' || kind === 'rm'), false);
  assert.deepEqual(await cleanupCookieHelper(foreign.docker, foreign.helper), { absent: true, action: 'absent' });
});
