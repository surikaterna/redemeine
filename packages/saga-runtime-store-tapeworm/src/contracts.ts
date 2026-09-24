import type { IBaseEvent, IPersistencePartition } from 'tapeworm';

export interface TapewormSagaEvent extends IBaseEvent {
  readonly payload: unknown;
  readonly headers?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface TapewormPartitionReadiness {
  readonly partitionOpened: true;
  readonly uniqueCommitIdIndexReady: true;
  readonly uniqueStreamSequenceIndexReady: true;
}

export interface CreateTapewormSagaTurnRepositoryOptions {
  readonly partition: IPersistencePartition<TapewormSagaEvent>;
  readonly partitionId: string;
  readonly readiness: TapewormPartitionReadiness;
}

export const tapewormSagaTurnIndexRequirements = Object.freeze([
  Object.freeze({ keys: Object.freeze({ id: 1 }), unique: true }),
  Object.freeze({ keys: Object.freeze({ streamId: 1, commitSequence: 1 }), unique: true })
]);
