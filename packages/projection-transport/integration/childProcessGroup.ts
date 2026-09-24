import type { ChildProcess } from 'node:child_process';

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForGroupExit(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (groupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !groupAlive(pid);
}

/** The detached direct child is a process-group leader; signal descendants even if it exited first. */
export async function reapChildGroup(child: ChildProcess, graceMs: number, timedOut = false): Promise<void> {
  const pid = child.pid;
  if (!pid) { if (timedOut) child.kill('SIGTERM'); return; }
  if (!groupAlive(pid)) return;
  signalGroup(pid, 'SIGTERM');
  if (await waitForGroupExit(pid, graceMs)) return;
  signalGroup(pid, 'SIGKILL');
  if (!await waitForGroupExit(pid, 2_000)) throw new Error(`Process group ${pid} did not exit after SIGKILL.`);
}
