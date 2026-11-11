import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { portObservation, verifiedLoopbackPort } from '../integration/portDiagnostics';
import { OwnedDocker } from '../integration/docker';
import { Commands, type Executor } from '../integration/commands';
import { Receipts } from '../integration/receipts';

const id = 'a'.repeat(64); const runId = '87ab691c04de';
const binding = { HostIp: '127.0.0.1', HostPort: '49152' };
const labels = { 'redemeine.issue': 'redemeine-hpq1.1', 'redemeine.run': runId };
const networkId = 'b'.repeat(64); const networkName = `hpq1-${runId}-network`;

test.each([undefined, null, [], [binding, binding], ['invalid'], [{ HostIp: '127.0.0.1', HostPort: '' }],
  [{ HostIp: '0.0.0.0', HostPort: '49152' }], [{ HostIp: '::1', HostPort: '49152' }],
  [{ HostIp: '127.0.0.1', HostPort: '1e3' }], [{ HostIp: '127.0.0.1', HostPort: 49152 }],
  [{ HostIp: '127.0.0.1', HostPort: '0' }], [{ HostIp: '127.0.0.1', HostPort: '65536' }]])
('strict active binding refusal retains safe facts for %j without falling back to configured bindings', (active) => {
  const value = { NetworkSettings: { Ports: { '15672/tcp': active } }, HostConfig: { PortBindings: { '15672/tcp': [binding] } } };
  expect(() => verifiedLoopbackPort(value, 15672)).toThrow();
  expect(portObservation(id, value, 15672).configured).toMatchObject({ shape: 'array', count: 1 });
});

test.each([{}, { NetworkSettings: null }, { NetworkSettings: { Ports: null } }])('missing network structures have field-specific refusal: %j', (value) => {
  expect(() => verifiedLoopbackPort(value, 15672)).toThrow(/port_network_settings_invalid|port_active_ports_invalid/);
});

test('bounded allowlist excludes arbitrary text,env,URI,other ports,and extra binding fields', () => {
  const secret = 'secret-canary';
  const value = { Config: { Env: [secret] }, State: { Running: true, ExitCode: 0, Error: secret },
    HostConfig: { PortBindings: { '15672/tcp': [{ HostIp: secret, HostPort: secret, credentials: secret }] } },
    NetworkSettings: { Ports: { '15672/tcp': Array.from({ length: 100 }, () => ({ ...binding, extra: secret })), '9999/tcp': secret } } };
  const observation = portObservation(id, value, 15672);
  expect(observation.active).toMatchObject({ count: 100, entries: [{ hostIp: '127.0.0.1' }, { hostIp: '127.0.0.1' }] });
  expect(observation).toMatchObject({ running: true, exitCode: 0 });
  expect(JSON.stringify(observation)).not.toMatch(/secret-canary|credentials|9999|Env|Error/);
});

test.each([true, false])('OwnedDocker persists diagnostic before refusal only after owned inspection;foreign=%s', async (foreign) => {
  const root = await mkdtemp('/tmp/opencode/hpq1-port-diagnostic-');
  const executor: Executor = async () => ({ code: 0, signal: null, stderr: '', stdout: JSON.stringify([{ Id: id,
    Config: { Labels: { ...labels, 'redemeine.run': foreign ? 'foreign' : runId }, Env: ['secret-canary'] },
    NetworkSettings: { Networks: { [networkName]: { NetworkID: networkId } }, Ports: { '5672/tcp': [binding], '15672/tcp': null } },
    HostConfig: { NetworkMode: networkId, PortBindings: { '15672/tcp': [binding], '5672/tcp': [binding] } },
    State: { Running: true, ExitCode: 0 } }]) });
  try {
    const receipt = new Receipts(root, runId); receipt.resources.push({ kind: 'container', name: `hpq1-${runId}-rabbit`, id, removed: false });
    receipt.resources.push({ kind: 'network', name: networkName, id: networkId, removed: false });
    await expect(new OwnedDocker(new Commands(root, receipt, executor), receipt).port(id, 15672, new AbortController().signal))
      .rejects.toThrow(foreign ? 'resource_owner_mismatch' : 'port_active_binding_cardinality_invalid');
    expect(receipt.portObservations).toHaveLength(foreign ? 0 : 2);
    if (!foreign) {
      const saved = await readFile(join(root, 'receipt.json'), 'utf8');
      expect(saved).toContain('portObservations'); expect(saved).toContain('"shape": "null"'); expect(saved).not.toContain('secret-canary');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('valid single loopback active binding remains accepted', () => {
  expect(verifiedLoopbackPort({ NetworkSettings: { Ports: { '15672/tcp': [binding] } } }, 15672)).toBe(49152);
});
