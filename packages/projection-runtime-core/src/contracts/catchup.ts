import type { Checkpoint, EventBatch } from '../types';

export interface ProjectionCatchupPollingAdapter {
  poll(cursor: Checkpoint, batchSize: number): Promise<EventBatch>;
}
