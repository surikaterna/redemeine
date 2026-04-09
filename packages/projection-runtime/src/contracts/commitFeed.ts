export interface ProjectionCheckpoint {
  sequence: number;
  timestamp?: string;
}

export interface ProjectionCommit {
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  sequence: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface CommitFeedBatch {
  commits: ProjectionCommit[];
  nextCheckpoint: ProjectionCheckpoint;
}

export interface CommitFeedContract {
  readAfter(checkpoint: ProjectionCheckpoint, limit: number): Promise<CommitFeedBatch>;
}
