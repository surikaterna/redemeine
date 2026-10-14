import EventEmitter from 'events';
import PQueueExport from 'p-queue';
type PQueue = import('p-queue', { with: { 'resolution-mode': 'require' } }).default;
type PQueueConstructor = typeof import('p-queue', { with: { 'resolution-mode': 'require' } }).default;

// v6 exposes exports.default: native ESM and transpiled CJS unwrap it differently.
function queueConstructor(value: PQueueConstructor | { default: PQueueConstructor }): PQueueConstructor {
  return typeof value === 'function' ? value : value.default;
}

// The order and concrete PQueue type preserve legacy generic/nominal assignability.
type Task<R> = (() => PromiseLike<R>) | (() => R);
export interface QueueOptions { concurrency?: number }

export class Queue extends EventEmitter {
  _queue: PQueue;

  constructor(options?: QueueOptions) {
    super();
    const Constructor = queueConstructor(PQueueExport);
    this._queue = new Constructor({ concurrency: options?.concurrency || 1 });
  }

  queueCommand<Result = unknown>(fn: Task<Result>): Promise<Result> {
    return this._queue.add(fn);
  }

  isProcessing(): boolean {
    return this._queue.size > 0;
  }

  empty(): Promise<void> {
    return this._queue.onIdle();
  }
}
