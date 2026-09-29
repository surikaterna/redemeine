import { spawn } from 'node:child_process';

/** The launched process is a fresh process group; only its descendants receive termination. */
export function runOwnedChild(command, args, options = {}) {
  const { timeoutMs = 120_000, graceMs = 2_000, cwd, env, capture = false, onSpawn } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, cwd, env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
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
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', () => { error = new Error('owned process failed to spawn'); });
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(reapTimer);
      signalGroup('SIGKILL');
      if (error) reject(error);
      else resolve({ code: code ?? 1, signal, timedOut, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    onSpawn?.(child);
  });
}
