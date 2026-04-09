import type { Checkpoint } from '../types';

export type ProjectionShardLeaseTransitionReason =
  | 'bootstrap'
  | 'renewal'
  | 'expiry'
  | 'recovery'
  | 'scale-down'
  | 'scale-up'
  | 'rebalance';

export interface ProjectionShardOwnerIdentity {
  workerId: string;
  workerEpoch?: string;
}

export interface ProjectionShardLeaseIdentity {
  shardId: string;
  owner: ProjectionShardOwnerIdentity;
  leaseVersion: number;
}

export type ProjectionShardLeaseStatus = 'unowned' | 'active' | 'expired' | 'released';

export interface ProjectionShardLeaseTimeline {
  acquiredAt: string;
  renewBy: string;
  expiresAt: string;
}

/**
 * Snapshot of shard ownership + checkpoint state.
 *
 * Invariants:
 * - Only one `active` owner may exist per shard at a time.
 * - `checkpoint.sequence` is monotonically non-decreasing per shard.
 * - Ownership changes must increment `leaseVersion`.
 */
export interface ProjectionShardCheckpointLeaseState {
  shardId: string;
  status: ProjectionShardLeaseStatus;
  lease: ProjectionShardLeaseIdentity | null;
  checkpoint: Checkpoint;
  timeline?: ProjectionShardLeaseTimeline;
  updatedAt: string;
}

export interface ProjectionShardLeaseClaimRequest {
  shardId: string;
  contender: ProjectionShardOwnerIdentity;
  at: string;
  reason: ProjectionShardLeaseTransitionReason;
  expectedPreviousLeaseVersion?: number;
}

export interface ProjectionShardLeaseClaimed {
  status: 'claimed';
  state: ProjectionShardCheckpointLeaseState;
}

export interface ProjectionShardLeaseClaimRejected {
  status: 'rejected';
  state: ProjectionShardCheckpointLeaseState;
  reason: 'already-owned' | 'stale-observation' | 'not-expired';
}

export type ProjectionShardLeaseClaimResult = ProjectionShardLeaseClaimed | ProjectionShardLeaseClaimRejected;

export interface ProjectionShardLeaseRenewRequest {
  shardId: string;
  owner: ProjectionShardOwnerIdentity;
  leaseVersion: number;
  at: string;
}

export interface ProjectionShardLeaseRenewed {
  status: 'renewed';
  state: ProjectionShardCheckpointLeaseState;
}

export interface ProjectionShardLeaseRenewRejected {
  status: 'rejected';
  state: ProjectionShardCheckpointLeaseState;
  reason: 'owner-mismatch' | 'stale-lease' | 'not-active';
}

export type ProjectionShardLeaseRenewResult = ProjectionShardLeaseRenewed | ProjectionShardLeaseRenewRejected;

export interface ProjectionShardCheckpointCommitRequest {
  shardId: string;
  owner: ProjectionShardOwnerIdentity;
  leaseVersion: number;
  checkpoint: Checkpoint;
  committedAt: string;
}

export interface ProjectionShardCheckpointCommitted {
  status: 'committed';
  state: ProjectionShardCheckpointLeaseState;
}

export interface ProjectionShardCheckpointCommitRejected {
  status: 'rejected';
  state: ProjectionShardCheckpointLeaseState;
  reason: 'owner-mismatch' | 'stale-lease' | 'checkpoint-regression' | 'not-active';
}

export type ProjectionShardCheckpointCommitResult =
  | ProjectionShardCheckpointCommitted
  | ProjectionShardCheckpointCommitRejected;

export interface ProjectionShardLeaseAssignment {
  shardId: string;
  fromWorkerId: string | null;
  toWorkerId: string;
  mode: 'keep' | 'handoff' | 'takeover';
}

/**
 * Deterministic rebalance plan for worker-count transitions.
 *
 * Examples covered by conformance tests:
 * - Scale down from 4 workers to 2 workers.
 * - Scale up from 4 workers to 8 workers.
 */
export interface ProjectionShardLeaseRebalancePlan {
  reason: 'scale-down' | 'scale-up' | 'recovery' | 'rebalance';
  fromWorkerCount: number;
  toWorkerCount: number;
  assignments: ReadonlyArray<ProjectionShardLeaseAssignment>;
}

export interface ProjectionShardCheckpointLeaseContract {
  claimLease(request: ProjectionShardLeaseClaimRequest): Promise<ProjectionShardLeaseClaimResult>;
  renewLease(request: ProjectionShardLeaseRenewRequest): Promise<ProjectionShardLeaseRenewResult>;
  commitCheckpoint(request: ProjectionShardCheckpointCommitRequest): Promise<ProjectionShardCheckpointCommitResult>;
  readShardState(shardId: string): Promise<ProjectionShardCheckpointLeaseState | null>;
}
