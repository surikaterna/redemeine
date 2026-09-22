import type { ProjectionCompleteCommitRangeReader, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { projectionMigrationDigest } from './digest';
import type { ProjectionMigrationManifest, ProjectionMigrationReplayEvidence } from './types';

export interface ProjectionMigrationReplayPort {
  loadAppliedSequence(sourceId: string): Promise<number | null>;
  /** Atomically apply the complete commit and record its migration-only source sequence. */
  applyCompleteCommit(commit: ProjectionSourceCommit): Promise<void>;
  snapshotDigests(): Promise<{ stateDigest: `sha256:${string}`; linkDigest: `sha256:${string}` }>;
}

export interface ProjectionMigrationReplayOptions {
  readonly maxCommitsPerRead?: number;
  readonly maxBytesPerRead?: number;
  readonly now?: () => string;
}

export async function replayProjectionMigrationRanges(manifest: ProjectionMigrationManifest, reader: ProjectionCompleteCommitRangeReader,
  target: ProjectionMigrationReplayPort, options: ProjectionMigrationReplayOptions = {}): Promise<ProjectionMigrationReplayEvidence> {
  if (!reader.capability.completeCommitBoundaries || !reader.capability.unslicedCommitEvents) throw new Error('Complete unsliced commit replay capability is required.');
  for (const range of manifest.sourceCommitRanges) await replayRange(reader, target, range, options);
  const snapshot = await target.snapshotDigests();
  return { replayedRangesDigest: manifest.authoritativeSourceDigest, ...snapshot, completedAt: (options.now ?? (() => new Date().toISOString()))() };
}

async function replayRange(reader: ProjectionCompleteCommitRangeReader, target: ProjectionMigrationReplayPort,
  range: ProjectionMigrationManifest['sourceCommitRanges'][number], options: ProjectionMigrationReplayOptions): Promise<void> {
  const appliedThrough = await target.loadAppliedSequence(range.sourceId);
  if (appliedThrough !== null && (appliedThrough < range.firstSequence - 1 || appliedThrough > range.lastSequence)) {
    throw new Error(`Migration replay checkpoint is outside the declared range for ${range.sourceId}.`);
  }
  const commitDigests: string[] = [];
  await visitRange(reader, range, options, async (commit) => { commitDigests.push(projectionMigrationDigest(commit)); });
  if (commitDigests.length !== range.commitCount || projectionMigrationDigest(commitDigests) !== range.rangeDigest) {
    throw new Error(`Authoritative commit range digest mismatch for ${range.sourceId}.`);
  }
  await visitRange(reader, range, options, async (commit) => {
    if (appliedThrough === null || commit.commitSequence > appliedThrough) await target.applyCompleteCommit(commit);
  });
}

async function visitRange(reader: ProjectionCompleteCommitRangeReader, range: ProjectionMigrationManifest['sourceCommitRanges'][number],
  options: ProjectionMigrationReplayOptions, visit: (commit: ProjectionSourceCommit) => Promise<void>): Promise<void> {
  let afterSequence: number | null = range.firstSequence === 0 ? null : range.firstSequence - 1;
  let expectedSequence = range.firstSequence;
  while ((afterSequence ?? -1) < range.lastSequence) {
    const result = await reader.readCompleteRange({ sourceId: range.sourceId, afterSequence, throughSequence: range.lastSequence,
      maxCommits: options.maxCommitsPerRead ?? 100, maxBytes: options.maxBytesPerRead ?? 8 * 1024 * 1024 });
    if (result.status !== 'complete' || result.commits.length === 0) throw new Error(`Complete commit history unavailable for ${range.sourceId}.`);
    for (const entry of result.commits) {
      if (entry.commit.streamId !== range.sourceId || entry.commit.commitSequence !== expectedSequence) {
        throw new Error(`Noncontiguous commit history for ${range.sourceId}.`);
      }
      await visit(entry.commit);
      expectedSequence += 1;
    }
    afterSequence = result.continuationAfterSequence;
  }
  if (expectedSequence - 1 !== range.lastSequence) throw new Error(`Incomplete commit history for ${range.sourceId}.`);
}
