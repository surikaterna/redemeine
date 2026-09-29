import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { OWNER_LABEL, ownedResources } from './topology-runner-ownership.mjs';
import { cleanupCookieHelper, cookieHelperArgs, helperOwnership, inspectCookieMetadata, parseCookieMetadata } from './topology-diagnostic-cookie.mjs';

const runId = 'topology-0123456789abcdef0123456789abcdef';
const names = { network: `${runId}-net`, volume: `${runId}-data`, container: runId };

function mock() {
  const main = ownedResources(names, runId);
  main.ids.container = 'main-id';
  main.ids.volume = names.volume;
  const helper = helperOwnership(main);
  const calls = [];
  let helperObject = null;
  let owner = runId;
  let failCreate = false;
  async function docker(args) {
    calls.push(args);
    const [kind, action, name] = args;
    if (kind === 'container' && action === 'inspect' && name === runId) return { code: 0,
      stdout: JSON.stringify({ Id: 'main-id', Name: `/${runId}`, Config: { Labels: { [OWNER_LABEL]: owner } } }) };
    if (kind === 'volume' && action === 'inspect') return { code: 0,
      stdout: JSON.stringify({ Name: names.volume, Labels: { [OWNER_LABEL]: runId } }) };
    if (kind === 'container' && action === 'inspect' && name === helper.names.container) return helperObject ?
      { code: 0, stdout: JSON.stringify(helperObject) } : { code: 1, stderr: `Error response from daemon: No such container: ${helper.names.container}` };
    if (kind === 'container' && action === 'inspect' && name === 'main-id') return { code: 0,
      stdout: JSON.stringify({ Status: 'exited', Running: false, ExitCode: 1 }) };
    if (kind === 'create') {
      helperObject = { Id: 'helper-id', Name: `/${helper.names.container}`, Config: { Labels: { [OWNER_LABEL]: runId } } };
      if (failCreate) throw new Error('audit interrupted');
      return { code: 0, stdout: 'helper-id' };
    }
    if (kind === 'start') return { code: 0,
      stdout: '999\n999\nrabbitmq:x:999:999:RabbitMQ:/var/lib/rabbitmq:/bin/sh\ndir:999:999:700\ncookie:999:999:400', stderr: '' };
    if (kind === 'rm') { helperObject = null; return { code: 0 }; }
    throw new Error(`unexpected ${kind} ${action}`);
  }
  return { main, helper, docker, calls, setOwner: (value) => { owner = value; },
    failHelperCreation: () => { failCreate = true; },
    foreignHelper: () => { helperObject = { Id: 'foreign-id', Name: `/${helper.names.container}`, Config: { Labels: { [OWNER_LABEL]: 'foreign' } } }; } };
}

test('helper has exact readonly volume, network none and only id/getent/stat; no cookie content commands', () => {
  const context = mock();
  const args = cookieHelperArgs(context.main, context.helper);
  assert.deepEqual(args.slice(0, 9), ['create', '--name', context.helper.names.container, '--label',
    `${OWNER_LABEL}=${runId}`, '--network', 'none', '--mount', `source=${names.volume},target=/var/lib/rabbitmq,readonly`]);
  assert.deepEqual(args.slice(9, 13), ['--entrypoint', '/bin/sh', RABBIT_IMAGE, '-c']);
  assert.match(args[13], /^id -u rabbitmq; id -g rabbitmq; getent passwd rabbitmq; stat -c /);
  assert.doesNotMatch(args[13], /\b(cat|od|hash|cp|chmod|chown|tee|dd|sed|awk|curl)\b/);
  assert.match(args[13], /stat -c 'cookie:%u:%g:%a' \/var\/lib\/rabbitmq\/\.erlang\.cookie$/);
});

test('helper interruption after creation before ID reply still cleans only owner-labeled helper', async () => {
  const context = mock();
  context.failHelperCreation();
  await assert.rejects(inspectCookieMetadata(context.docker, context.main, context.helper), /interrupted/);
  assert.deepEqual(context.helper.ids, {});
  assert.deepEqual(await cleanupCookieHelper(context.docker, context.helper), { absent: true, action: 'removed', removalCode: 0, id: 'helper-id' });
  assert.ok(context.calls.some((args) => args[0] === 'rm' && args.at(-1) === 'helper-id'));
});

test('owner-verified helper captures numeric-only receipt and is removed by ID', async () => {
  const context = mock();
  assert.deepEqual(await inspectCookieMetadata(context.docker, context.main, context.helper), {
    status: 'ok', rabbitUid: 999, rabbitGid: 999,
    directory: { uid: 999, gid: 999, mode: '700' }, cookie: { uid: 999, gid: 999, mode: '400' }
  });
  assert.deepEqual(await cleanupCookieHelper(context.docker, context.helper), { absent: true, action: 'removed', removalCode: 0, id: 'helper-id' });
  assert.ok(context.calls.find((args) => args[0] === 'rm' && args.at(-1) === 'helper-id'));
});

test('missing cookie and malformed response are sanitized without printing contents', () => {
  const absent = parseCookieMetadata({ code: 1, stdout: '999\n999\nrabbitmq:x:999:999:/home:/bin/sh\ndir:999:999:700',
    stderr: "stat: cannot statx '/var/lib/rabbitmq/.erlang.cookie': No such file or directory" });
  assert.deepEqual(absent, { status: 'cookie-missing', rabbitUid: 999, rabbitGid: 999, directory: { uid: 999, gid: 999, mode: '700' } });
  assert.deepEqual(parseCookieMetadata({ code: 1, stdout: 'secret-content', stderr: 'private-token' }), { status: 'identity-unavailable' });
  assert.doesNotMatch(JSON.stringify(absent), /statx|private-token|secret-content/);
});

test('foreign owner prevents helper creation and foreign helper collision is preserved', async () => {
  const context = mock();
  context.setOwner('foreign');
  await assert.rejects(inspectCookieMetadata(context.docker, context.main, context.helper), /identity not verified/);
  assert.equal(context.calls.some((args) => args[0] === 'create' || args[0] === 'start'), false);
  context.setOwner(runId);
  context.foreignHelper();
  await assert.rejects(inspectCookieMetadata(context.docker, context.main, context.helper), /collision/);
  assert.deepEqual(await cleanupCookieHelper(context.docker, context.helper), { absent: false, action: 'preserved-unverified' });
  assert.equal(context.calls.some((args) => args[0] === 'rm'), false);
});
