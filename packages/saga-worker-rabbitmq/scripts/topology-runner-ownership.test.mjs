import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupOwned, createOwned, inspectOwned, ownedResources, OWNER_LABEL, preflightOwned } from './topology-runner-ownership.mjs';

const runId = 'topology-0123456789abcdef0123456789abcdef';
const names = { network: `${runId}-net`, volume: `${runId}-data`, container: runId };

function absentMessage(kind, name = names[kind]) {
  return {
    network: `Error response from daemon: network ${name} not found`,
    volume: `Error response from daemon: get ${name}: no such volume`,
    container: `Error: No such container: ${name}`
  }[kind];
}

function mockDocker() {
  const resources = new Map();
  const calls = [];
  let onCreate = async () => undefined;
  function store(kind, owner = runId) {
    const name = names[kind];
    const id = kind === 'volume' ? name : `${kind}-id`;
    const labels = { [OWNER_LABEL]: owner };
    resources.set(kind, kind === 'container' ? { Id: id, Name: `/${name}`, Config: { Labels: labels } } :
      { Id: id, Name: name, Labels: labels });
  }
  async function docker(args) {
    calls.push(args);
    const [kind, action] = args;
    if (action === 'inspect') {
      const resource = resources.get(kind);
      return resource ? { code: 0, stdout: JSON.stringify(resource) } : { code: 1, stderr: absentMessage(kind) };
    }
    if (action === 'create' || kind === 'run') {
      const type = kind === 'run' ? 'container' : kind;
      if (resources.has(type)) throw new Error('Conflict: already exists');
      await onCreate(type, store);
      if (!resources.has(type)) store(type);
      return { code: 0, stdout: resources.get(type).Id };
    }
    const type = kind === 'rm' ? 'container' : kind;
    if (action === 'rm' || kind === 'rm') {
      const resource = resources.get(type);
      if (resource?.Id === args.at(-1)) resources.delete(type);
      return { code: 0 };
    }
    throw new Error(`unexpected docker command ${args.join(' ')}`);
  }
  return { docker, calls, resources, store, setOnCreate: (callback) => { onCreate = callback; } };
}

test('actual exact-name 404 formats are accepted only with exit 1', async () => {
  const state = ownedResources(names, runId);
  for (const kind of ['network', 'volume', 'container']) {
    const docker = async () => ({ code: 1, stderr: absentMessage(kind) });
    assert.equal(await inspectOwned(docker, state, kind), null);
    await assert.rejects(inspectOwned(async () => ({ code: 0, stderr: absentMessage(kind), stdout: '{}' }), state, kind), /identity/);
  }
});

test('wrong name, permission or daemon failure never becomes absence', async () => {
  const state = ownedResources(names, runId);
  for (const kind of ['network', 'volume', 'container']) {
    const wrong = absentMessage(kind, `${names[kind]}-foreign`);
    for (const stderr of [wrong, 'permission denied', 'Cannot connect to the Docker daemon']) {
      await assert.rejects(inspectOwned(async () => ({ code: 1, stderr }), state, kind), /cannot verify/);
    }
  }
  const special = ownedResources({ ...names, network: `${runId}-net.+` }, runId);
  await assert.rejects(inspectOwned(async () => ({ code: 1, stderr: absentMessage('network', `${runId}-netXXX`) }), special, 'network'), /cannot verify/);
});

test('exit-0 inspect accepts only exact identity/name and owner label', async () => {
  const mock = mockDocker();
  const state = ownedResources(names, runId);
  for (const kind of ['network', 'volume', 'container']) {
    mock.store(kind);
    assert.deepEqual(await inspectOwned(mock.docker, state, kind), {
      id: kind === 'volume' ? names.volume : `${kind}-id`, owned: true
    });
    mock.resources.get(kind).Name = 'wrong-name';
    await assert.rejects(inspectOwned(mock.docker, state, kind), /identity\/name mismatch/);
    mock.store(kind, 'foreign-owner');
    assert.equal((await inspectOwned(mock.docker, state, kind)).owned, false);
  }
});

test('exact Docker 404 postchecks prove no owned resources remain', async () => {
  const mock = mockDocker();
  const state = ownedResources(names, runId);
  await createSequence(mock, state);
  const receipt = await cleanupOwned(mock.docker, state);
  assert.equal(receipt.absent, true);
  assert.deepEqual(receipt.postCleanup.map(({ resource }) => resource), [null, null, null]);
});

function argumentsFor(kind) {
  const label = `${OWNER_LABEL}=${runId}`;
  return kind === 'container' ? ['run', '-d', '--name', names.container, '--label', label] :
    [kind, 'create', '--label', label, names[kind]];
}

async function createSequence(mock, state, kinds = ['network', 'volume', 'container']) {
  await preflightOwned(mock.docker, state);
  for (const kind of kinds) await createOwned(mock.docker, state, kind, argumentsFor(kind));
}

test('normal owned cleanup verifies labels and IDs, removes only owned objects in dependency order', async () => {
  const mock = mockDocker();
  const state = ownedResources(names, runId);
  await createSequence(mock, state);
  assert.deepEqual(state.ids, { network: 'network-id', volume: names.volume, container: 'container-id' });
  const result = await cleanupOwned(mock.docker, state);
  assert.equal(result.absent, true);
  assert.deepEqual(result.actions.map(({ kind }) => kind), ['container', 'volume', 'network']);
  assert.equal(mock.resources.size, 0);
});

test('partial network creation followed by failure cleans network only', async () => {
  const mock = mockDocker();
  const state = ownedResources(names, runId);
  mock.setOnCreate(async (kind) => { if (kind === 'volume') throw new Error('volume creation failed'); });
  await assert.rejects(createSequence(mock, state, ['network', 'volume']), /volume creation failed/);
  assert.equal((await cleanupOwned(mock.docker, state)).absent, true);
  assert.deepEqual(mock.calls.filter((args) => args.includes('rm')), [['network', 'rm', 'network-id']]);
});

test('container collision after owned network/volume leaves colliding container untouched', async () => {
  const mock = mockDocker();
  const state = ownedResources(names, runId);
  mock.setOnCreate(async (kind, store) => { if (kind === 'volume') store('container', 'someone-else'); });
  await assert.rejects(createSequence(mock, state), /collision/);
  assert.equal((await cleanupOwned(mock.docker, state)).absent, false);
  assert.equal(mock.resources.get('container').Config.Labels[OWNER_LABEL], 'someone-else');
  assert.equal(mock.calls.some((args) => args[0] === 'rm'), false);
});

test('late create collision is preserved even when another resource advertises the run label', async () => {
  const mock = mockDocker();
  const state = ownedResources(names, runId);
  mock.setOnCreate(async (kind, store) => {
    if (kind === 'container') { store(kind); throw new Error('Conflict: already in use'); }
  });
  await assert.rejects(createSequence(mock, state), /Conflict/);
  assert.equal(state.collisions.has('container'), true);
  assert.equal((await cleanupOwned(mock.docker, state)).absent, false);
  assert.equal(mock.resources.has('container'), true);
  assert.equal(mock.calls.some((args) => args[0] === 'rm'), false);
});

test('three preexisting names fail preflight without any deletion, regardless of owner label', async () => {
  const mock = mockDocker();
  for (const kind of ['network', 'volume', 'container']) mock.store(kind);
  const state = ownedResources(names, runId);
  await assert.rejects(preflightOwned(mock.docker, state), /collision/);
  assert.equal((await cleanupOwned(mock.docker, state)).absent, false);
  assert.equal(mock.calls.some((args) => args.includes('rm')), false);
  assert.equal(mock.resources.size, 3);
});

test('signal after creation but before ID return recovers labeled object safely', async () => {
  const mock = mockDocker();
  const state = ownedResources(names, runId);
  mock.setOnCreate(async (kind, store) => { store(kind); throw new Error('audit interrupted'); });
  await assert.rejects(createSequence(mock, state, ['network']), /interrupted/);
  assert.deepEqual(state.ids, {});
  assert.equal((await cleanupOwned(mock.docker, state)).absent, true);
  assert.equal(mock.resources.size, 0);
});

test('mismatched label or identity is preserved, never removed', async () => {
  const mock = mockDocker();
  const state = ownedResources(names, runId);
  await createSequence(mock, state, ['network']);
  mock.store('network', 'someone-else');
  assert.deepEqual(await inspectOwned(mock.docker, state, 'network'), { id: 'network-id', owned: false });
  assert.equal((await cleanupOwned(mock.docker, state)).absent, false);
  assert.equal(mock.resources.has('network'), true);
  assert.equal(mock.calls.some((args) => args.includes('rm')), false);
  const alternate = mockDocker();
  const second = ownedResources(names, runId);
  await createSequence(alternate, second, ['network']);
  alternate.resources.get('network').Id = 'replaced-id';
  assert.equal((await cleanupOwned(alternate.docker, second)).absent, false);
  assert.equal(alternate.resources.get('network').Id, 'replaced-id');
  assert.equal(alternate.calls.some((args) => args.includes('rm')), false);
});
