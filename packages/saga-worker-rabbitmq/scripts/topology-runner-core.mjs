import { spawn } from 'node:child_process';

export const RABBIT_IMAGE = 'rabbitmq:4.1.4-management-alpine@sha256:5cbd7145b0306399ad68422c3350b6cbd1bb95704b39f5896480e5b6d4238a04';

export function createCommandRunner(cwd) {
  const active = new Set();
  const signalEscalations = new Map();
  let interrupted = false;
  let completed = false;
  let terminationFailure;
  function terminate(child, signal) {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') terminationFailure = error; }
  }
  function interrupt() {
    if (completed || interrupted) return;
    interrupted = true;
    for (const child of active) {
      terminate(child, 'SIGTERM');
      const escalation = setTimeout(() => terminate(child, 'SIGKILL'), 3000);
      signalEscalations.set(child, escalation);
    }
  }
  function run(command, args, { env = process.env, allowed = false, timeoutMs = 90_000, cleanup = false } = {}) {
    if (interrupted && !cleanup) return Promise.reject(new Error('audit interrupted'));
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      active.add(child);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let spawnError;
      let escalation;
      const deadline = setTimeout(() => { timedOut = true; terminate(child, 'SIGTERM');
        escalation = setTimeout(() => terminate(child, 'SIGKILL'), 3000); }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { spawnError = error; });
      child.on('close', (code) => {
        active.delete(child);
        clearTimeout(deadline);
        clearTimeout(escalation);
        clearTimeout(signalEscalations.get(child));
        signalEscalations.delete(child);
        if (spawnError) reject(spawnError);
        else if (timedOut || (interrupted && !cleanup)) reject(new Error(`${command} timed out or interrupted`));
        else if (code === 0 || allowed) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        else reject(new Error(`${command} operation failed (${code}): ${stderr.trim()}`));
      });
    });
  }
  function complete() {
    completed = true;
    return !interrupted;
  }
  return { run, interrupt, complete, get interrupted() { return interrupted; }, get terminationFailure() { return terminationFailure; } };
}

export async function requireCleanHead(run) {
  const sha = (await run('git', ['rev-parse', 'HEAD'])).stdout;
  if (!/^[0-9a-f]{40}$/.test(sha) || (await run('git', ['status', '--porcelain'])).stdout) {
    throw new Error('Real audit requires a clean, committed Git HEAD');
  }
  return sha;
}

export function recordAuditFailure(receipt, phase, error) {
  const message = error instanceof Error ? error.message : String(error);
  receipt[`${phase}Error`] = message;
  receipt.failure ??= message;
  receipt.exitCode = 1;
}

export function scenarioReport(report) {
  const scenarios = report.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({
    name: [...test.ancestorTitles, test.title].join(' > '), status: test.status,
    durationMs: test.duration ?? null, failures: test.failureMessages
  })));
  const passed = scenarios.filter(({ status }) => status === 'passed').length;
  const failed = scenarios.filter(({ status }) => status !== 'passed').length;
  return { scenarios, counts: { passed, failed, total: scenarios.length } };
}
