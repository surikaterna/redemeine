import { spawnSync } from 'node:child_process';
import ports from '../scripts/topology-owned-ports.cjs';

type Endpoints = { owner: string; restricted: string; management: string };
type Command = (args: string[]) => string;

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 65_536 });
  if (result.error || result.status !== 0) throw new Error('owned Rabbit port query failed');
  return result.stdout;
}

function withPort(value: string, port: number): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error('owned Rabbit endpoint invalid'); }
  if (parsed.hostname !== '127.0.0.1') throw new Error('owned Rabbit endpoint must be localhost');
  parsed.port = String(port);
  return parsed.toString();
}

export function refreshedEndpoints(current: Endpoints, name: string, id: string, runId: string,
  command: Command = docker): Endpoints {
  ports.ownedId(command(['container', 'inspect', name, '--format', '{{json .}}']), name, id, runId);
  const amqp = ports.mappedPort(command(['port', id, '5672/tcp']));
  const management = ports.mappedPort(command(['port', id, '15672/tcp']));
  return { owner: withPort(current.owner, amqp), restricted: withPort(current.restricted, amqp),
    management: withPort(current.management, management) };
}
