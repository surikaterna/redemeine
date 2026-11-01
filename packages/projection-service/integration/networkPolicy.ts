import { assert, one, record } from './schema';
import { verifiedLoopbackPort } from './portDiagnostics';

export type Role = 'mongo' | 'rabbit' | 'producer' | 'projection' | 'key-init';
export function rolePorts(role: Role): readonly number[] { return role === 'mongo' ? [27017] : role === 'rabbit' ? [5672, 15672] : []; }

export function verifyBridge(value: Record<string, unknown>, id: string, name: string): void {
  assert((value.Id ?? value.ID) === id && value.Name === name && value.Driver === 'bridge' && value.Internal === false,
    'qualification_bridge_mismatch');
}

export function verifyNetworkMode(value: Record<string, unknown>, id: string, name: string): void {
  const mode = record(value.HostConfig).NetworkMode;
  assert(mode === id || mode === name, 'container_network_mode_mismatch');
}

export function verifyAttachment(value: Record<string, unknown>, id: string, name: string): void {
  verifyNetworkMode(value, id, name);
  const networks = record(record(value.NetworkSettings).Networks);
  assert(Object.keys(networks).length === 1 && Object.hasOwn(networks, name), 'container_network_attachment_mismatch');
  assert(record(networks[name]).NetworkID === id, 'container_network_identity_mismatch');
}

export function verifyDeclaredPorts(value: Record<string, unknown>, role: Role): void {
  const expected = rolePorts(role).map((port) => `${port}/tcp`);
  const raw = record(value.HostConfig).PortBindings;
  const ports = raw === null && expected.length === 0 ? {} : record(raw);
  assert(Object.keys(ports).length === expected.length && expected.every((key) => Object.hasOwn(ports, key)), 'declared_ports_mismatch');
  for (const key of expected) {
    const binding = one(ports[key]); const hostPort = binding.HostPort;
    assert(binding.HostIp === '127.0.0.1', 'nonloopback_port');
    assert(hostPort === '' || (typeof hostPort === 'string' && /^[0-9]{1,5}$/.test(hostPort)
      && Number(hostPort) >= 1024 && Number(hostPort) <= 65535), 'declared_host_port_invalid');
  }
}

export function verifyActivePorts(value: Record<string, unknown>, role: Role): void {
  const expected = rolePorts(role); const raw = record(value.NetworkSettings).Ports;
  const ports = raw === null && expected.length === 0 ? {} : record(raw);
  const hostPorts = expected.map((port) => verifiedLoopbackPort(value, port));
  assert(new Set(hostPorts).size === hostPorts.length, 'duplicate_active_host_port');
  for (const [key, bindings] of Object.entries(ports)) {
    assert(expected.some((port) => key === `${port}/tcp`) || bindings === null, 'unexpected_active_publication');
  }
}

export function validPortSpec(role: Role, ports: readonly number[]): boolean {
  const expected = rolePorts(role);
  return ports.length === expected.length && new Set(ports).size === ports.length && expected.every((port) => ports.includes(port));
}
