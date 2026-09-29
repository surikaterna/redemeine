import { inspectOwned } from './topology-runner-ownership.mjs';
import appReady from './topology-app-ready.cjs';

const { waitForRabbitApp } = appReady;

export function redactDiagnostic(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  const categories = lines.slice(-12).map((line) => {
    if (/connection refused|econnrefused/i.test(line)) return 'connection-refused';
    if (/node.*down|nodedown|epmd/i.test(line)) return 'node-unavailable';
    if (/timeout|timed out/i.test(line)) return 'timeout';
    if (/boot.*fail|fail.*boot/i.test(line)) return 'boot-failure';
    if (/error|failed/i.test(line)) return 'error';
    if (/warn/i.test(line)) return 'warning';
    if (/start|ready|rabbitmq/i.test(line)) return 'startup';
    return 'other-redacted';
  });
  return { lineCount: lines.length, categories };
}

function probeSummary(result, status) {
  return { status, code: result?.code ?? null, stdout: redactDiagnostic(result?.stdout), stderr: redactDiagnostic(result?.stderr) };
}

async function probe(docker, name, command, timeoutMs) {
  try {
    const result = await docker(['exec', name, 'rabbitmq-diagnostics', '-q', command],
      { allowed: true, timeoutMs, maxOutputBytes: 2048 });
    return { summary: probeSummary(result, 'exit'), code: result.code };
  } catch (error) {
    if (!error.probe) throw new Error('Rabbit readiness probe could not start');
    return { summary: probeSummary(error.probe, error.probe.timedOut ? 'probe-timeout' : 'probe-error'), code: null };
  }
}

async function containerExited(docker, ownership) {
  const id = ownership.ids.container;
  if (typeof id !== 'string' || !id) throw new Error('Rabbit owned container ID unavailable');
  const reply = await docker(['container', 'inspect', id, '--format', '{{json .State}}'],
    { allowed: true, timeoutMs: 5_000, maxOutputBytes: 4096 });
  if (reply.code !== 0) throw new Error('Rabbit owned container state unavailable');
  return ['exited', 'dead'].includes(JSON.parse(reply.stdout).Status);
}

export async function waitForRabbit(docker, runner, ownership, receipt, { deadlineMs = 90_000, probeMs = 5_000, delayMs = 500 } = {}) {
  const readiness = { attempts: 0, lastProbe: null, ping: null, application: null, status: 'waiting' };
  receipt.readiness = readiness;
  try {
    await waitForRabbitApp({ probe: (command, timeoutMs) => probe(docker, ownership.names.container, command, timeoutMs),
      isExited: () => containerExited(docker, ownership), interrupted: () => runner.interrupted,
      onAttempt: () => { readiness.attempts++; }, onProbe: (command, result) => {
        readiness.lastProbe = result.summary;
        if (command === 'ping') readiness.ping = result.summary;
        else readiness.application = result.summary;
      }, deadlineMs, probeMs, delayMs });
    readiness.status = 'ready';
  } catch (error) {
    readiness.status = runner.interrupted ? 'interrupted' : /exited/.test(error.message) ? 'exited' : 'deadline-exceeded';
    throw error;
  }
}

function knownState(value) {
  const states = ['created', 'running', 'exited', 'paused', 'restarting', 'dead'];
  return states.includes(value) ? value : 'unknown';
}

export async function captureReadinessDiagnostics(docker, ownership) {
  const verified = await inspectOwned(docker, ownership, 'container');
  if (!verified?.owned || (ownership.ids.container && ownership.ids.container !== verified.id)) {
    return { status: 'unverified-owner', logs: 'withheld' };
  }
  const result = await docker(['container', 'inspect', verified.id, '--format', '{{json .State}}'],
    { allowed: true, cleanup: true, timeoutMs: 5_000, maxOutputBytes: 4096 });
  if (result.code !== 0) return { status: 'state-inspect-failed', logs: 'withheld' };
  const state = JSON.parse(result.stdout);
  const details = { id: verified.id, status: knownState(state.Status), running: state.Running === true,
    exitCode: Number.isSafeInteger(state.ExitCode) ? state.ExitCode : null,
    health: ['healthy', 'unhealthy', 'starting'].includes(state.Health?.Status) ? state.Health.Status : 'unavailable' };
  const logs = await docker(['logs', '--tail', '80', verified.id],
    { allowed: true, cleanup: true, timeoutMs: 5_000, maxOutputBytes: 4096 });
  return { status: 'verified-owner', container: details, logs: { code: logs.code,
    stdout: redactDiagnostic(logs.stdout), stderr: redactDiagnostic(logs.stderr) } };
}
