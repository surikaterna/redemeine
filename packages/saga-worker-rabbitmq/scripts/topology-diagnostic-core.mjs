import { closeSync, openSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { createOwned, inspectOwned, OWNER_LABEL, preflightOwned } from './topology-runner-ownership.mjs';
import { redactDiagnostic } from './topology-runner-readiness.mjs';

export function diagnosticRunArgs(names, runId) {
  return ['run', '-d', '--name', names.container, '--label', `${OWNER_LABEL}=${runId}`, '--network', names.network,
    '--mount', `source=${names.volume},target=/var/lib/rabbitmq`,
    '-e', 'RABBITMQ_DEFAULT_USER=topology_owner', '-e', 'RABBITMQ_DEFAULT_PASS=topology_owner_password',
    '-p', '127.0.0.1::5672', '-p', '127.0.0.1::15672', RABBIT_IMAGE];
}

export async function createDiagnosticResources(docker, ownership) {
  await preflightOwned(docker, ownership);
  await docker(['pull', RABBIT_IMAGE]);
  const label = `${OWNER_LABEL}=${ownership.runId}`;
  await createOwned(docker, ownership, 'network', ['network', 'create', '--label', label, ownership.names.network]);
  await createOwned(docker, ownership, 'volume', ['volume', 'create', '--label', label, ownership.names.volume]);
  await createOwned(docker, ownership, 'container', diagnosticRunArgs(ownership.names, ownership.runId));
}

export async function verifiedContainerState(docker, ownership) {
  const inspected = await inspectOwned(docker, ownership, 'container');
  if (!inspected?.owned || (ownership.ids.container && ownership.ids.container !== inspected.id)) {
    throw new Error('owned container identity not verified');
  }
  const result = await docker(['container', 'inspect', inspected.id, '--format', '{{json .State}}'],
    { allowed: true, cleanup: true, timeoutMs: 5_000, maxOutputBytes: 2048 });
  if (result.code !== 0) throw new Error('owned container state unavailable');
  const state = JSON.parse(result.stdout);
  const status = ['created', 'running', 'exited', 'paused', 'restarting', 'dead'].includes(state.Status) ? state.Status : 'unknown';
  return { id: inspected.id, status, running: state.Running === true,
    exitCode: Number.isSafeInteger(state.ExitCode) ? state.ExitCode : null, oomKilled: state.OOMKilled === true,
    health: ['healthy', 'unhealthy', 'starting'].includes(state.Health?.Status) ? state.Health.Status : 'unavailable' };
}

export async function awaitDiagnosticStartup(docker, runner, ownership, receipt, { deadlineMs = 60_000, probeMs = 5_000, delayMs = 500 } = {}) {
  const deadline = Date.now() + deadlineMs;
  receipt.startup = { attempts: 0, lastProbe: null, status: 'waiting' };
  while (Date.now() < deadline && !runner.interrupted) {
    receipt.startup.attempts++;
    try {
      const ping = await docker(['exec', ownership.names.container, 'rabbitmq-diagnostics', '-q', 'ping'],
        { allowed: true, timeoutMs: probeMs, maxOutputBytes: 2048 });
      receipt.startup.lastProbe = { status: 'exit', code: ping.code,
        stdout: redactDiagnostic(ping.stdout), stderr: redactDiagnostic(ping.stderr) };
      if (ping.code === 0) { receipt.startup.status = 'ready'; break; }
    } catch (error) {
      if (runner.interrupted) break;
      receipt.startup.lastProbe = { status: error.probe?.timedOut ? 'probe-timeout' : 'probe-error',
        code: error.probe?.code ?? null, stderr: redactDiagnostic(error.probe?.stderr) };
    }
    const state = await verifiedContainerState(docker, ownership);
    if (state.status === 'exited' || state.status === 'dead') { receipt.startup.status = 'exited'; break; }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (receipt.startup.status === 'waiting') receipt.startup.status = runner.interrupted ? 'interrupted' : 'deadline-exceeded';
  receipt.startup.state = await verifiedContainerState(docker, ownership);
  return receipt.startup;
}

export function diagnosticCause(text) {
  if (/permission denied|eacces/i.test(text)) return 'file-permission-denied';
  if (/address already in use|eaddrinuse/i.test(text)) return 'address-already-in-use';
  if (/no space left|enospc/i.test(text)) return 'disk-space-exhausted';
  if (/cookie.*mismatch|mismatch.*cookie/i.test(text)) return 'erlang-cookie-mismatch';
  return 'undetermined';
}

export function writePrivateRaw(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); }
  finally { closeSync(fd); }
}

export async function captureDiagnosticLogs(docker, ownership, path, write = writePrivateRaw) {
  const state = await verifiedContainerState(docker, ownership);
  const result = await docker(['logs', '--tail', '80', state.id],
    { allowed: true, cleanup: true, timeoutMs: 5_000, maxOutputBytes: 4096 });
  if (result.code !== 0) throw new Error('owned container logs unavailable');
  const boundedLines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).slice(-80).join('\n');
  const bytes = Buffer.from(boundedLines).subarray(-4096);
  write(path, bytes);
  const text = bytes.toString('utf8');
  return { state, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    stdout: redactDiagnostic(result.stdout), stderr: redactDiagnostic(result.stderr), cause: diagnosticCause(text) };
}
