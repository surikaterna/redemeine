import { isCanonicalProjectionUuid, validateProjectionSourceCommit } from './sourceCommit';
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
  /** Immutable accepted-state boundary shared by ordering and definition dispatch. */
  startAnchor: number;
  strategyScope: readonly ProjectionCutoverStrategyScope[];
}

export interface ProjectionCutoverStrategyScope {
  readonly projectionName: string;
  readonly generation: string;
  readonly strategy: 'in_document' | 'own_record' | 'none';
  /** Operator-declared immutable one-source/one-target direct routing; required for legacy in-document adoption. */
  readonly stableSingleTarget: boolean;
}

export interface ProjectionSourceCoverageAdvance {
  queueBindingId: string;
  sourceId: string;
  expectedSequence: number | null;
  sequence: number;
}

export interface ProjectionSourceOrderPort {
  readonly acceptedBaseline?: true;
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
  maxCommits: number;
  maxBytes: number;
}

export interface ProjectionEncodedSourceCommit {
  commit: ProjectionSourceCommit;
  /** Exact encoded wire bytes measured by the source adapter; core never estimates this value. */
  encodedByteLength: number;
}

export interface ProjectionCompleteCommitRange {
  status: 'complete';
  commits: readonly ProjectionEncodedSourceCommit[];
  encodedByteLength: number;
  continuationAfterSequence: number | null;
  hasMore: boolean;
}

export interface ProjectionIncompleteCommitRange {
  status: 'incomplete';
  reason: 'partial_commit' | 'sliced_boundary' | 'history_unavailable';
  details: string;
  continuationAfterSequence: number | null;
}

export interface ProjectionOversizedCommitRange {
  status: 'oversized_commit';
  sourceId: string;
  commitSequence: number;
  commitId: string;
  encodedByteLength: number;
  /** An oversized commit is never returned or folded, so continuation cannot advance. */
  continuationAfterSequence: number | null;
}

export type ProjectionCompleteCommitRangeResult =
  | ProjectionCompleteCommitRange
  | ProjectionIncompleteCommitRange
  | ProjectionOversizedCommitRange;

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

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateRangeRequest(request: ProjectionCompleteCommitRangeRequest): string[] {
  const issues: string[] = [];
  if (!isCanonicalProjectionUuid(request.sourceId)) issues.push('request.sourceId');
  if (!isPositiveSafeInteger(request.maxCommits)) issues.push('request.maxCommits');
  if (!isPositiveSafeInteger(request.maxBytes)) issues.push('request.maxBytes');
  if (!Number.isSafeInteger(request.throughSequence) || request.throughSequence < 0) issues.push('request.throughSequence');
  if (request.afterSequence !== null
    && (!Number.isSafeInteger(request.afterSequence) || request.afterSequence < 0)) issues.push('request.afterSequence');
  if (request.afterSequence !== null && request.throughSequence <= request.afterSequence) issues.push('request.range');
  return issues;
}

function validateOversizedCommit(
  request: ProjectionCompleteCommitRangeRequest,
  result: ProjectionOversizedCommitRange
): string[] {
  const expected = request.afterSequence === null ? 0 : request.afterSequence + 1;
  const issues = ['oversized_commit'];
  if (result.sourceId !== request.sourceId) issues.push('oversized_commit.sourceId');
  if (result.commitSequence !== expected) issues.push('oversized_commit.commitSequence');
  if (!isCanonicalProjectionUuid(result.commitId)) issues.push('oversized_commit.commitId');
  if (!isPositiveSafeInteger(result.encodedByteLength)
    || result.encodedByteLength <= request.maxBytes) issues.push('oversized_commit.encodedByteLength');
  if (result.continuationAfterSequence !== request.afterSequence) issues.push('oversized_commit.continuation');
  return issues;
}

export function validateCompleteCommitRange(
  request: ProjectionCompleteCommitRangeRequest,
  result: ProjectionCompleteCommitRangeResult
): ProjectionCompleteCommitRangeValidation {
  const issues = validateRangeRequest(request);
  if (result.status === 'incomplete') {
    if (result.continuationAfterSequence !== request.afterSequence) issues.push('incomplete.continuation');
    return { valid: false, issues: [...issues, result.reason] };
  }
  if (result.status === 'oversized_commit') {
    return { valid: false, issues: [...issues, ...validateOversizedCommit(request, result)] };
  }
  let expected = request.afterSequence === null ? 0 : request.afterSequence + 1;
  let encodedByteLength = 0;
  if (result.commits.length === 0 && result.hasMore) issues.push('empty_page');
  if (result.commits.length > request.maxCommits) issues.push('max_commits');
  for (const entry of result.commits) {
    const { commit } = entry;
    if (!validateProjectionSourceCommit(commit).valid) issues.push(`commit[${commit.commitSequence}]`);
    if (commit.streamId !== request.sourceId) issues.push(`source[${commit.commitSequence}]`);
    if (commit.commitSequence !== expected) issues.push(`sequence[${commit.commitSequence}]`);
    if (commit.commitSequence > request.throughSequence) issues.push(`boundary[${commit.commitSequence}]`);
    if (!isPositiveSafeInteger(entry.encodedByteLength)) issues.push(`bytes[${commit.commitSequence}]`);
    encodedByteLength += entry.encodedByteLength;
    expected = commit.commitSequence + 1;
  }
  const continuation = result.commits.at(-1)?.commit.commitSequence ?? request.afterSequence;
  if (!Number.isSafeInteger(encodedByteLength)) issues.push('encoded_bytes_overflow');
  if (!Number.isSafeInteger(result.encodedByteLength) || result.encodedByteLength < 0) {
    issues.push('encoded_bytes_report');
  }
  if (result.encodedByteLength !== encodedByteLength) issues.push('encoded_bytes_mismatch');
  if (result.encodedByteLength > request.maxBytes) issues.push('max_bytes');
  if (result.continuationAfterSequence !== continuation) issues.push('continuation');
  if (!result.hasMore && expected <= request.throughSequence) issues.push('range_coverage');
  if (result.hasMore && expected > request.throughSequence) issues.push('has_more');
  return { valid: issues.length === 0, issues };
}
