import type { IBaseEvent, IPersistencePartition } from 'tapeworm';
import type { SagaCommitReader } from './IndexedSagaCommitReader';

export interface TapewormSagaEvent extends IBaseEvent {
  readonly payload: unknown;
  readonly headers?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateTapewormSagaTurnRepositoryOptions {
  readonly partition: IPersistencePartition<TapewormSagaEvent>;
  readonly partitionId: string;
  readonly reader: SagaCommitReader;
}

export const tapewormSagaTurnIndexRequirements = Object.freeze([
  Object.freeze({ keys: Object.freeze({ id: 1 }), unique: true }),
  Object.freeze({ keys: Object.freeze({ streamId: 1, commitSequence: 1 }), unique: true })
]);
