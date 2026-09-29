import { inspectOwned } from './topology-runner-ownership.mjs';

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

export async function waitForRabbit(docker, runner, name, receipt, { deadlineMs = 90_000, probeMs = 5_000, delayMs = 500 } = {}) {
  const deadline = Date.now() + deadlineMs;
  const readiness = { attempts: 0, lastProbe: null, status: 'waiting' };
  receipt.readiness = readiness;
  while (Date.now() < deadline && !runner.interrupted) {
    readiness.attempts++;
    try {
      const result = await docker(['exec', name, 'rabbitmq-diagnostics', '-q', 'ping'],
        { allowed: true, timeoutMs: probeMs, maxOutputBytes: 2048 });
      readiness.lastProbe = probeSummary(result, 'exit');
      if (result.code === 0) { readiness.status = 'ready'; return; }
    } catch (error) {
      if (runner.interrupted) break;
      readiness.lastProbe = probeSummary(error.probe, error.probe?.timedOut ? 'probe-timeout' : 'probe-error');
      if (!error.probe) throw new Error('Rabbit readiness probe could not start');
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  readiness.status = runner.interrupted ? 'interrupted' : 'deadline-exceeded';
  throw new Error(runner.interrupted ? 'Rabbit readiness interrupted by external signal' :
    `Rabbit readiness deadline exceeded (last probe: ${readiness.lastProbe?.status ?? 'none'})`);
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
