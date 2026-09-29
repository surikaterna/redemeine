export const childPhases = ['unknown', 'module-init', 'mongo-connect', 'amqp-connect', 'consumer-channel',
  'topology', 'publisher', 'partition-index', 'registration', 'worker-start', 'ready', 'worker-running'] as const;
export type CrashChildPhase = typeof childPhases[number];
export type ChildErrorClass = 'unknown' | 'timeout' | 'network' | 'configuration' | 'operation' | 'exit';
export interface ChildError {
  readonly kind: 'error';
  readonly phase: CrashChildPhase;
  readonly errorClass: ChildErrorClass;
  readonly code: number | null;
}

export function isChildError(value: unknown): value is ChildError {
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'error') return false;
  if (Object.keys(value).length !== 4 ||
      Object.keys(value).some(key => !['kind', 'phase', 'errorClass', 'code'].includes(key))) return false;
  if (!('phase' in value) || !childPhases.includes(value.phase as CrashChildPhase) ||
      !('errorClass' in value) || !['unknown', 'timeout', 'network', 'configuration', 'operation', 'exit'].includes(String(value.errorClass))) {
    return false;
  }
  return 'code' in value && (value.code === null || typeof value.code === 'number' &&
    Number.isSafeInteger(value.code) && value.code >= 0 && value.code <= 999);
}

export function childError(phase: CrashChildPhase, error: unknown): ChildError {
  const name = error instanceof Error ? error.name : '';
  const errorClass = name === 'AbortError' || name === 'TimeoutError' ? 'timeout' :
    name === 'MongoServerSelectionError' || name === 'AmqpConnectionError' ? 'network' :
    name === 'TypeError' ? 'configuration' : 'operation';
  const rawCode = typeof error === 'object' && error !== null && 'replyCode' in error ? error.replyCode :
    typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) && rawCode >= 0 && rawCode <= 999 ? rawCode : null;
  return { kind: 'error', phase, errorClass, code };
}

export class ChildStages {
  phase: CrashChildPhase = 'module-init';
  async run<T>(phase: CrashChildPhase, operation: () => T | Promise<T>): Promise<T> {
    this.phase = phase;
    return operation();
  }
  failure(error: unknown): ChildError { return childError(this.phase, error); }
}

export class ChildStartupFailure extends Error {
  constructor(readonly evidence: ChildError) {
    super(evidence.phase === 'unknown' ? 'child exited before IPC' : 'child reported a safe startup failure');
    this.name = 'ChildStartupFailure';
  }
}
