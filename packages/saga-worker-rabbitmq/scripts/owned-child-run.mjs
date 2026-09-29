import { spawn } from 'node:child_process';

/** The launched process is a fresh process group; only its descendants receive termination. */
export function runOwnedChild(command, args, options = {}) {
  const { timeoutMs = 120_000, graceMs = 2_000, cwd, env, capture = false, onSpawn,
    withholdOutput = false, maxOutputBytes = 4_096 } = options;
  if (withholdOutput && !capture) throw new TypeError('withheld child output must be piped');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 65_536) {
    throw new TypeError('child output budget must be bounded');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, cwd, env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let error = null;
    let done = false;
    let forceTimer;
    let reapTimer;
    const signalGroup = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (failure) {
        if (failure?.code !== 'ESRCH') error = new Error('owned process group termination failed');
      }
    };
    const force = () => signalGroup('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      forceTimer = setTimeout(() => {
        force();
        reapTimer = setTimeout(() => {
          if (!done) { done = true; reject(new Error('owned process group did not close after SIGKILL')); }
        }, 5_000);
      }, graceMs);
    }, timeoutMs);
    child.stdout?.on('data', chunk => {
      if (!withholdOutput) stdout += chunk.subarray(0, Math.max(0, maxOutputBytes - stdoutBytes)).toString();
      stdoutBytes = Math.min(maxOutputBytes + 1, stdoutBytes + chunk.length);
    });
    child.stderr?.on('data', chunk => {
      if (!withholdOutput) stderr += chunk.subarray(0, Math.max(0, maxOutputBytes - stderrBytes)).toString();
      stderrBytes = Math.min(maxOutputBytes + 1, stderrBytes + chunk.length);
    });
    child.on('error', () => { error = new Error('owned process failed to spawn'); });
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(reapTimer);
      signalGroup('SIGKILL');
      if (error) reject(error);
      else resolve({ code: code ?? 1, signal, timedOut, stdout: stdout.trim(), stderr: stderr.trim(),
        output: { stdoutBytes, stderrBytes, stdoutTruncated: stdoutBytes > maxOutputBytes,
          stderrTruncated: stderrBytes > maxOutputBytes, maxBytes: maxOutputBytes } });
    });
    onSpawn?.(child);
  });
}
