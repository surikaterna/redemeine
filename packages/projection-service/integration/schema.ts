import { QualificationError } from './plan';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new QualificationError('qualification_response_invalid');
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new QualificationError('qualification_response_invalid');
  return value;
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new QualificationError('qualification_response_invalid');
  return value;
}

export function one(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) throw new QualificationError('qualification_response_invalid');
  return record(value[0]);
}

export function assert(condition: boolean, reason: string): void {
  if (!condition) throw new QualificationError(reason);
}

export async function waitUntil(check: () => Promise<boolean>, milliseconds: number, signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!await check()) {
    if (signal.aborted || performance.now() >= deadline) throw new QualificationError('qualification_condition_deadline');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (signal.aborted) throw new QualificationError('qualification_stopping');
}

export function boundedJoin(task: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (joined: boolean) => { signal.removeEventListener('abort', abort); resolve(joined); };
    const abort = () => finish(false);
    task.then(() => finish(true), () => finish(false));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
