import { mkdtemp, rm } from 'node:fs/promises';
import { OwnedDocker } from '../integration/docker';
import { Commands, type Executor } from '../integration/commands';
import { Receipts } from '../integration/receipts';
import { qualificationNetwork, resourceName } from '../integration/plan';
import { rolePorts, validPortSpec, verifyBridge, verifyAttachment, verifyNetworkMode,
  verifyDeclaredPorts, verifyActivePorts, type Role } from '../integration/networkPolicy';

const runId = '42bc8e7af193'; const id = 'b'.repeat(64); const name = resourceName(runId, 'network');
const labels = { 'redemeine.issue': 'redemeine-hpq1.1', 'redemeine.run': runId };
const roles: readonly Role[] = ['mongo', 'rabbit', 'producer', 'projection', 'key-init'];
const configured = { HostIp: '127.0.0.1', HostPort: '' };

function container(role: Role) {
  const declared: Record<string, unknown> = {}; const active: Record<string, unknown> = { '80/tcp': null };
  rolePorts(role).forEach((port, index) => {
    declared[`${port}/tcp`] = [configured]; active[`${port}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: String(49152 + index) }];
  });
  return { HostConfig: { NetworkMode: id, PortBindings: declared },
    NetworkSettings: { Networks: { [name]: { NetworkID: id } }, Ports: active } };
}

test.each([false, true])('network creation explicitly selects ownedbridge/NAT and refuses foreignlabels;foreign=%s', async (foreign) => {
  const root = await mkdtemp('/tmp/opencode/hpq1-bridge-test-'); const calls: string[][] = []; let created = false;
  const executor: Executor = async (_binary, args) => {
    calls.push([...args]);
    if (args[1] === 'create') { created = true; return { code: 0, signal: null, stderr: '', stdout: id }; }
    return { code: created ? 0 : 1, signal: null, stderr: created ? '' : 'No such network',
      stdout: created ? JSON.stringify([{ Id: id, Name: name, Driver: 'bridge', Internal: false,
        Labels: { ...labels, 'redemeine.run': foreign ? 'other' : runId } }]) : '' };
  };
  try {
    const receipt = new Receipts(root, runId); const docker = new OwnedDocker(new Commands(root, receipt, executor), receipt);
    if (foreign) await expect(docker.network(new AbortController().signal)).rejects.toThrow('resource_owner_mismatch');
    else {
      expect(await docker.network(new AbortController().signal)).toBe(id);
      expect(receipt.provenance.network).toEqual({ ...qualificationNetwork, id, name });
    }
    const create = calls.find((args) => args[1] === 'create');
    expect(create).toEqual(['network', 'create', '--driver', 'bridge', '--label', 'redemeine.issue=redemeine-hpq1.1',
      '--label', `redemeine.run=${runId}`, name]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([{ Internal: true }, { Driver: 'overlay' }, { Name: 'bridge' }, { Id: 'c'.repeat(64) }])('bridge metadata must match exact reviewed mode/name/identity: %j', (override) => {
  expect(() => verifyBridge({ Id: id, Name: name, Driver: 'bridge', Internal: false, ...override }, id, name)).toThrow('qualification_bridge_mismatch');
});

test.each(roles)('role%s allows only its declared ports, singleownedattachment and highloopback actualbindings', (role) => {
  const value = container(role);
  expect(validPortSpec(role, rolePorts(role))).toBe(true);
  expect(() => verifyDeclaredPorts(value, role)).not.toThrow(); expect(() => verifyAttachment(value, id, name)).not.toThrow();
  expect(() => verifyActivePorts(value, role)).not.toThrow();
  expect(() => verifyNetworkMode({ HostConfig: { NetworkMode: name } }, id, name)).not.toThrow();
});

test.each(['host', 'bridge', 'none', 'other-network'])('foreign/default/host network mode refused: %s', (mode) => {
  expect(() => verifyNetworkMode({ HostConfig: { NetworkMode: mode } }, id, name)).toThrow('container_network_mode_mismatch');
});

test.each([
  { [name]: { NetworkID: id }, extra: { NetworkID: id } },
  { bridge: { NetworkID: id } }, { [name]: { NetworkID: 'c'.repeat(64) } }, {}
])('runtimeattachment must be exactsingleownedname/ID: %j', (networks) => {
  const value = container('rabbit'); value.NetworkSettings.Networks = networks;
  expect(() => verifyAttachment(value, id, name)).toThrow();
});

test.each([
  { '5672/tcp': [configured] },
  { '5672/tcp': [configured], '15672/tcp': [configured, configured] },
  { '5672/tcp': [configured], '15672/tcp': [{ HostIp: '0.0.0.0', HostPort: '' }] },
  { '5672/tcp': [configured], '15672/tcp': [{ HostIp: '::', HostPort: '' }] },
  { '5672/tcp': [configured], '15672/tcp': [configured], '9999/tcp': [configured] }
])('declaredrabbit ports cannotomit/duplicate/wideninterface/addpublication: %j', (bindings) => {
  const value = container('rabbit'); value.HostConfig.PortBindings = bindings;
  expect(() => verifyDeclaredPorts(value, 'rabbit')).toThrow();
});

test.each([
  { '15672/tcp': null },
  { '15672/tcp': [{ HostIp: '127.0.0.1', HostPort: '1023' }] },
  { '15672/tcp': [{ HostIp: '::1', HostPort: '49153' }] },
  { '15672/tcp': [{ HostIp: '0.0.0.0', HostPort: '49153' }] },
  { '15672/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] },
  { '9999/tcp': [{ HostIp: '127.0.0.1', HostPort: '49154' }] }
])('actualports must be allocated/high/singleloopback/distinct/noextras: %j', (override) => {
  const value = container('rabbit'); Object.assign(value.NetworkSettings.Ports, override);
  expect(() => verifyActivePorts(value, 'rabbit')).toThrow();
});

test.each(['producer', 'projection', 'key-init'])('private role%s refuses even loopback declared publications', (role) => {
  if (role !== 'producer' && role !== 'projection' && role !== 'key-init') throw new Error('invalid_private_role');
  const value = container(role); value.HostConfig.PortBindings = { '27017/tcp': [configured] };
  expect(() => verifyDeclaredPorts(value, role)).toThrow('declared_ports_mismatch');
  expect(validPortSpec(role, [27017])).toBe(false);
});

test('port specs refuse duplicates/extras and policy honestly declares outbound NAT', () => {
  expect(validPortSpec('rabbit', [5672, 5672])).toBe(false); expect(validPortSpec('mongo', [27017, 15672])).toBe(false);
  expect(qualificationNetwork).toMatchObject({ mode: 'owned_bridge_loopback_nat', internal: false, egressAllowed: true });
});
