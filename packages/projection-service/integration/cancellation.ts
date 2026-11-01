import { budgets, QualificationError } from './plan';

export type Unjoined = (operation: string) => void;

export function assertCurrent(signal: AbortSignal, deadline: number): void {
  if (signal.aborted || performance.now() >= deadline) throw new QualificationError('qualification_cancelled_or_elapsed');
}

function lateValue<T>(value: T, cleanup: ((value: T) => Promise<unknown>) | undefined, label: string, unjoined: Unjoined): void {
  if (!cleanup) return;
  try { void cleanup(value).catch(() => unjoined(`${label}_late_cleanup`)); }
  catch { unjoined(`${label}_late_cleanup`); }
}

/** Cancellation settles this waiter, not the operation; late rejection/acquisition remains observed. */
export function within<T>(label: string, operation: () => Promise<T>, signal: AbortSignal, deadline: number,
  unjoined: Unjoined, lateCleanup?: (value: T) => Promise<unknown>): Promise<T> {
  try { assertCurrent(signal, deadline); } catch (error) { unjoined(`${label}_not_started`); return Promise.reject(error); }
  const task = Promise.resolve().then(() => { assertCurrent(signal, deadline); return operation(); });
  return new Promise((resolve, reject) => {
    let settled = false;
    const clear = () => { clearTimeout(timer); signal.removeEventListener('abort', refuse); };
    const refuse = () => {
      if (settled) return;
      settled = true; clear(); unjoined(label); reject(new QualificationError('qualification_cancelled_or_elapsed'));
    };
    const timer = setTimeout(refuse, Math.max(0, deadline - performance.now()));
    task.then((value) => {
      if (!settled && (signal.aborted || performance.now() >= deadline)) refuse();
      if (settled) { lateValue(value, lateCleanup, label, unjoined); return; }
      settled = true; clear(); resolve(value);
    }, (error: unknown) => {
      if (settled) { unjoined(`${label}_late_rejection`); return; }
      settled = true; clear(); reject(error);
    });
    signal.addEventListener('abort', refuse, { once: true }); if (signal.aborted) refuse();
  });
}

export async function independentlyCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>, signal: AbortSignal,
  deadline: number, unjoined: Unjoined, cleanupMs: number = budgets.cleanupMs): Promise<T> {
  try { return await within('runner_work', work, signal, deadline, unjoined); }
  finally { await within('runner_cleanup', cleanup, new AbortController().signal, performance.now() + cleanupMs, unjoined); }
}

export function finalProcessGuard(code: number, forceExit: (code: number) => void, report: () => void): void {
  const timer = setTimeout(() => { report(); forceExit(code === 0 ? 1 : code); }, 2000);
  timer.unref();
}
