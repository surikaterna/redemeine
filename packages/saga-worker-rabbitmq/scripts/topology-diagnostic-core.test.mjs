import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { cleanupOwned, ownedResources, OWNER_LABEL } from './topology-runner-ownership.mjs';
import { awaitDiagnosticStartup, captureDiagnosticLogs, createDiagnosticResources, diagnosticRunArgs, writePrivateRaw } from './topology-diagnostic-core.mjs';

const runId = 'topology-0123456789abcdef0123456789abcdef';
const names = { container: runId, volume: `${runId}-data`, network: `${runId}-net` };

function fakeDocker() {
  const resources = new Map();
  const calls = [];
  let failCreate = '';
  const absent = (kind) => ({ code: 1, stderr: {
    network: `Error response from daemon: network ${names.network} not found`,
    volume: `Error response from daemon: get ${names.volume}: no such volume`,
    container: `Error response from daemon: No such container: ${names.container}`
  }[kind] });
  const store = (kind, owner = runId) => {
    const id = kind === 'volume' ? names.volume : `${kind}-id`;
    const labels = { [OWNER_LABEL]: owner };
    resources.set(kind, kind === 'container' ? { Id: id, Name: `/${names.container}`, Config: { Labels: labels } } :
      { Id: id, Name: names[kind], Labels: labels });
  };
  async function docker(args) {
    calls.push(args);
    const [kind, command] = args;
    if (command === 'inspect' && names[kind] === args[2]) return resources.has(kind) ?
      { code: 0, stdout: JSON.stringify(resources.get(kind)) } : absent(kind);
    if (kind === 'pull') return { code: 0 };
    if (command === 'create' || kind === 'run') {
      const type = kind === 'run' ? 'container' : kind;
      if (resources.has(type)) throw new Error('Conflict: already exists');
      if (type === failCreate) { store(type); throw new Error('audit interrupted'); }
      store(type);
      return { code: 0, stdout: resources.get(type).Id };
    }
    const type = kind === 'rm' ? 'container' : kind;
    if (command === 'rm' || kind === 'rm') {
      if (resources.get(type)?.Id === args.at(-1)) resources.delete(type);
      return { code: 0 };
    }
    throw new Error(`unexpected command ${kind} ${command}`);
  }
  return { docker, calls, resources, store, failAt: (kind) => { failCreate = kind; } };
}

test('diagnostic run flags exactly match pinned topology container and never invoke Jest', () => {
  const args = diagnosticRunArgs(names, runId);
  assert.deepEqual(args, ['run', '-d', '--name', names.container, '--label', `${OWNER_LABEL}=${runId}`, '--network', names.network,
    '--mount', `source=${names.volume},target=/var/lib/rabbitmq`,
    '-e', 'RABBITMQ_DEFAULT_USER=topology_owner', '-e', 'RABBITMQ_DEFAULT_PASS=topology_owner_password',
    '-p', '127.0.0.1::5672', '-p', '127.0.0.1::15672', RABBIT_IMAGE]);
  assert.ok(!args.some((item) => /jest|test:topology:real/.test(item)));
});

test('preexisting container collision stops before pull, preserves foreign resources', async () => {
  const fake = fakeDocker();
  fake.store('container', 'foreign-owner');
  const ownership = ownedResources(names, runId);
  await assert.rejects(createDiagnosticResources(fake.docker, ownership), /collision/);
  const cleanup = await cleanupOwned(fake.docker, ownership);
  assert.equal(cleanup.absent, false);
  assert.equal(fake.resources.get('container').Config.Labels[OWNER_LABEL], 'foreign-owner');
  assert.equal(fake.calls.some(([command]) => command === 'pull' || command === 'rm'), false);
});

test('interrupt after volume create before ID reply cleans only owned partial resources', async () => {
  const fake = fakeDocker();
  fake.failAt('volume');
  const ownership = ownedResources(names, runId);
  await assert.rejects(createDiagnosticResources(fake.docker, ownership), /interrupted/);
  assert.deepEqual(ownership.ids, { network: 'network-id' });
  assert.equal((await cleanupOwned(fake.docker, ownership)).absent, true);
  assert.equal(fake.resources.size, 0);
});

test('nonzero ping then owner-verified exited state stops diagnostic wait', async () => {
  const ownership = ownedResources(names, runId);
  ownership.ids.container = 'container-id';
  const fake = fakeDocker();
  fake.store('container');
  const docker = async (args) => {
    if (args[0] === 'exec') return { code: 1, stdout: '', stderr: 'ERROR secret=private' };
    if (args[0] === 'container' && args[2] === 'container-id') return { code: 0, stdout: JSON.stringify({ Status: 'exited', Running: false, ExitCode: 1, OOMKilled: false }) };
    return fake.docker(args);
  };
  const receipt = {};
  await awaitDiagnosticStartup(docker, { interrupted: false }, ownership, receipt, { deadlineMs: 100 });
  assert.equal(receipt.startup.status, 'exited');
  assert.equal(receipt.startup.lastProbe.code, 1);
  assert.equal(receipt.startup.state.exitCode, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /private/);
});

test('raw startup logs are 4KiB max, private, exclusive and withheld for unverified ownership', async () => {
  const directory = mkdtempSync('/tmp/opencode/topology-diagnostic-offline-');
  try {
    const path = join(directory, 'startup.log');
    const fake = fakeDocker();
    fake.store('container');
    const ownership = ownedResources(names, runId);
    ownership.ids.container = 'container-id';
    const docker = async (args) => {
      if (args[0] === 'container' && args[2] === 'container-id') return { code: 0, stdout: JSON.stringify({ Status: 'exited', Running: false, ExitCode: 1 }) };
      if (args[0] === 'logs') return { code: 0, stdout: `permission denied password=private ${'x'.repeat(160)}\n`.repeat(200), stderr: '' };
      return fake.docker(args);
    };
    const captured = await captureDiagnosticLogs(docker, ownership, path);
    assert.equal(captured.bytes, 4096);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(readFileSync(path, 'utf8'), /private/);
    assert.equal(captured.cause, 'file-permission-denied');
    assert.doesNotMatch(JSON.stringify(captured), /private/);
    await assert.rejects(captureDiagnosticLogs(docker, ownership, path), { code: 'EEXIST' });
    fake.store('container', 'foreign-owner');
    const before = fake.calls.length;
    await assert.rejects(captureDiagnosticLogs(docker, ownership, join(directory, 'foreign.log')), /identity not verified/);
    assert.equal(fake.calls.length, before + 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
