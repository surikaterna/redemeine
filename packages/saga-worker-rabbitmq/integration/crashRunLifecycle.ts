import { PhaseEvidence, safeFailure, type FailureEvidence } from './crashPhaseEvidence';

export interface LifecycleResult { readonly success: boolean; readonly cleanupFailure: FailureEvidence | null }

/** Teardown and receipt always run; first safe failure evidence is never replaced. */
export async function runCrashLifecycle<T>(run: () => Promise<T>, cleanup: () => Promise<void>,
  receipt: (result: LifecycleResult) => Promise<void>, phases: PhaseEvidence): Promise<T> {
  let failed = false;
  let result: T | undefined;
  try { result = await run(); } catch (error) {
    failed = true;
    phases.fail(error);
  }
  let cleanupFailure: FailureEvidence | null = null;
  try { await phases.run('cleanup', cleanup, 25_000); } catch (error) {
    cleanupFailure = safeFailure('cleanup', error);
    failed = true;
  }
  try { await phases.run('receipt', () => receipt({ success: !failed, cleanupFailure })); } catch {
    failed = true;
  }
  if (failed) throw new Error('owned crash scenario failed; inspect sanitized receipt');
  return result!;
}
