import type { ProjectionCheckpoint, ProjectionCommit } from './contracts/commitFeed';

export interface EventBatch {
  events: ProjectionCommit[];
  nextCursor: ProjectionCheckpoint;
}

export interface IEventSubscription {
  poll(cursor: ProjectionCheckpoint, batchSize: number): Promise<EventBatch>;
  subscribe?(aggregateType: string, aggregateIds: string[]): Promise<void>;
  unsubscribe?(aggregateType: string, aggregateIds: string[]): Promise<void>;
}
