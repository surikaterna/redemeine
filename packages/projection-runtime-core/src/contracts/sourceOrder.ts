import { validateProjectionSourceCommit } from './sourceCommit';
import type { ProjectionSourceCommit } from './sourceCommit';

export interface ProjectionSourceCoverage {
  queueBindingId: string;
  sourceId: string;
  /** Last durably covered transport sequence; null means no coverage, while zero is valid. */
  sequence: number | null;
}

export interface ProjectionSourceDispatchAdmission {
  /** Coverage is observational ordering metadata and can never suppress dispatch. */
  dispatch: true;
  coverage: ProjectionSourceCoverage;
}

export interface ProjectionSourceCoverageAdvance {
  queueBindingId: string;
  sourceId: string;
  expectedSequence: number | null;
  sequence: number;
}

export interface ProjectionSourceOrderPort {
  admitForDispatch(commit: ProjectionSourceCommit, queueBindingId: string): Promise<ProjectionSourceDispatchAdmission>;
  advanceCoverage(request: ProjectionSourceCoverageAdvance): Promise<ProjectionSourceCoverage>;
}

export interface ProjectionCompleteCommitRangeCapability {
  completeCommitBoundaries: true;
  unslicedCommitEvents: true;
}

export interface ProjectionCompleteCommitRangeRequest {
  sourceId: string;
  afterSequence: number | null;
  throughSequence: number;
  maxCommits?: number;
}

export interface ProjectionCompleteCommitRange {
  status: 'complete';
  commits: readonly ProjectionSourceCommit[];
  hasMore: boolean;
}

export interface ProjectionIncompleteCommitRange {
  status: 'incomplete';
  reason: 'partial_commit' | 'sliced_boundary' | 'history_unavailable';
  details: string;
}

export type ProjectionCompleteCommitRangeResult =
  | ProjectionCompleteCommitRange
  | ProjectionIncompleteCommitRange;

export interface ProjectionCompleteCommitRangeReader {
  readonly capability: ProjectionCompleteCommitRangeCapability;
  readCompleteRange(request: ProjectionCompleteCommitRangeRequest): Promise<ProjectionCompleteCommitRangeResult>;
}

export interface ProjectionCompleteCommitRangeValidation {
  valid: boolean;
  issues: readonly string[];
}

export function isCompleteCommitRangeCapability(candidate: unknown): candidate is ProjectionCompleteCommitRangeCapability {
  if (!candidate || typeof candidate !== 'object') return false;
  const capability = candidate as Record<string, unknown>;
  return capability.completeCommitBoundaries === true && capability.unslicedCommitEvents === true;
}

export function validateCompleteCommitRange(
  request: ProjectionCompleteCommitRangeRequest,
  result: ProjectionCompleteCommitRangeResult
): ProjectionCompleteCommitRangeValidation {
  if (result.status === 'incomplete') return { valid: false, issues: [result.reason] };
  const issues: string[] = [];
  let expected = request.afterSequence === null ? 0 : request.afterSequence + 1;
  for (const commit of result.commits) {
    if (!validateProjectionSourceCommit(commit).valid) issues.push(`commit[${commit.commitSequence}]`);
    if (commit.streamId !== request.sourceId) issues.push(`source[${commit.commitSequence}]`);
    if (commit.commitSequence !== expected) issues.push(`sequence[${commit.commitSequence}]`);
    if (commit.commitSequence > request.throughSequence) issues.push(`boundary[${commit.commitSequence}]`);
    expected = commit.commitSequence + 1;
  }
  if (!result.hasMore && expected <= request.throughSequence) issues.push('range_coverage');
  return { valid: issues.length === 0, issues };
}
