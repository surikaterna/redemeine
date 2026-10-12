import { isIP } from 'node:net';
import { assert, isRecord } from './schema';

export function valueShape(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function field(value: unknown, key: string): unknown { return isRecord(value) ? value[key] : undefined; }

function bindingsObservation(value: unknown) {
  if (!Array.isArray(value)) return { shape: valueShape(value) };
  return { shape: 'array', count: value.length, entries: value.slice(0, 2).map((entry: unknown) => {
    const ip = field(entry, 'HostIp'); const port = field(entry, 'HostPort');
    return { shape: valueShape(entry), hostIpShape: valueShape(ip), hostPortShape: valueShape(port),
      ...(typeof ip === 'string' && isIP(ip) ? { hostIp: ip } : {}),
      ...(typeof port === 'string' && /^[0-9]{0,5}$/.test(port) ? { hostPort: port } : {}) };
  }) };
}

export function portObservation(id: string, value: Record<string, unknown>, port: number) {
  const network = value.NetworkSettings; const host = value.HostConfig; const state = value.State;
  const active = field(network, 'Ports'); const configured = field(host, 'PortBindings'); const key = `${port}/tcp`;
  const running = field(state, 'Running'); const exit = field(state, 'ExitCode');
  return { id, requestedPort: port, networkSettingsShape: valueShape(network), activePortsShape: valueShape(active),
    hostConfigShape: valueShape(host), configuredPortsShape: valueShape(configured),
    active: bindingsObservation(field(active, key)), configured: bindingsObservation(field(configured, key)),
    stateShape: valueShape(state), runningShape: valueShape(running), exitCodeShape: valueShape(exit),
    ...(typeof running === 'boolean' ? { running } : {}),
    ...(typeof exit === 'number' && Number.isSafeInteger(exit) && exit >= 0 && exit <= 255 ? { exitCode: exit } : {}) };
}

export type PortObservation = ReturnType<typeof portObservation>;

export function verifiedLoopbackPort(value: Record<string, unknown>, port: number): number {
  const network = value.NetworkSettings; assert(isRecord(network), 'port_network_settings_invalid');
  const ports = field(network, 'Ports'); assert(isRecord(ports), 'port_active_ports_invalid');
  const bindings = field(ports, `${port}/tcp`);
  assert(Array.isArray(bindings) && bindings.length === 1, 'port_active_binding_cardinality_invalid');
  const binding: unknown = Array.isArray(bindings) ? bindings[0] : undefined;
  assert(isRecord(binding), 'port_active_binding_invalid');
  assert(field(binding, 'HostIp') === '127.0.0.1', 'nonloopback_port');
  const raw = field(binding, 'HostPort');
  assert(typeof raw === 'string' && /^[0-9]{1,5}$/.test(raw), 'port_host_port_shape_invalid');
  const hostPort = Number(raw); assert(Number.isInteger(hostPort) && hostPort >= 1024 && hostPort <= 65535, 'invalid_host_port');
  return hostPort;
}
