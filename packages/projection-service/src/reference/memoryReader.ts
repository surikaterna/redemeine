import type { ProjectionCompleteCommitRangeCapability, ProjectionCompleteCommitRangeReader,
  ProjectionCompleteCommitRangeRequest, ProjectionCompleteCommitRangeResult,
  ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { copyCommit } from './copyCommit';

export class ModelCommitReader implements ProjectionCompleteCommitRangeReader {
  readonly capability: ProjectionCompleteCommitRangeCapability = { completeCommitBoundaries: true, unslicedCommitEvents: true };
  readonly requests: ProjectionCompleteCommitRangeRequest[] = [];
  private readonly commits: readonly ProjectionSourceCommit[];

  constructor(commits: readonly ProjectionSourceCommit[], private readonly trace: string[]) {
    if (commits.length > 32) throw new Error('model:history_capacity');
    this.commits = commits.map(copyCommit);
  }

  async readCompleteRange(request: ProjectionCompleteCommitRangeRequest): Promise<ProjectionCompleteCommitRangeResult> {
    if (this.requests.length >= 128 || request.maxCommits !== 1) throw new Error('model:read_capacity');
    this.requests.push({ ...request });
    this.trace.push(`model:read:${request.throughSequence}`);
    const sequence = request.afterSequence === null ? 0 : request.afterSequence + 1;
    const commit = this.commits.find((item) => item.streamId === request.sourceId && item.commitSequence === sequence);
    if (!commit || sequence !== request.throughSequence) return { status: 'incomplete', reason: 'history_unavailable',
      details: 'model:point_read_only', continuationAfterSequence: request.afterSequence };
    const encodedByteLength = Buffer.byteLength(JSON.stringify(commit));
    if (encodedByteLength > request.maxBytes) return { status: 'oversized_commit', sourceId: commit.streamId,
      commitId: commit.commitId, commitSequence: sequence, encodedByteLength, continuationAfterSequence: request.afterSequence };
    return { status: 'complete', commits: [{ commit: copyCommit(commit), encodedByteLength }], encodedByteLength,
      continuationAfterSequence: sequence, hasMore: false };
  }
}
