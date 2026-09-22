import type { ProjectionCompleteCommitRangeReader, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import { ProjectionMigrationStreamingDigest } from './digest';
import type {
  ProjectionMigrationManifest,
  ProjectionMigrationRangeJournal,
  ProjectionMigrationReplayPort,
  ProjectionMigrationSourceRange,
  ProjectionMigrationStatePort
} from './types';
import { projectionMigrationRangeKey } from './validate';

const MAX_COMMITS = 100;
const MAX_BYTES = 8 * 1024 * 1024;

export async function scanProjectionMigrationRange(
  reader: ProjectionCompleteCommitRangeReader,
  range: ProjectionMigrationSourceRange,
  visit?: (commit: ProjectionSourceCommit) => Promise<void>
): Promise<{ digest: `sha256:${string}`; count: number; bytes: number }> {
  const digest = new ProjectionMigrationStreamingDigest('redemeine:migration:complete-commits:v2');
  let afterSequence: number | null = range.firstSequence === 0 ? null : range.firstSequence - 1;
  let encodedBytes = 0;
  let expected = range.firstSequence;
  while ((afterSequence ?? -1) < range.lastSequence) {
    const result = await reader.readCompleteRange({
      sourceId: range.sourceId,
      afterSequence,
      throughSequence: range.lastSequence,
      maxCommits: MAX_COMMITS,
      maxBytes: MAX_BYTES
    });
    if (result.status !== 'complete' || result.commits.length === 0)
      throw new Error(`Complete bounded history unavailable for ${projectionMigrationRangeKey(range)}.`);
    for (const entry of result.commits) {
      if (entry.encodedByteLength > MAX_BYTES || entry.commit.streamId !== range.sourceId || entry.commit.commitSequence !== expected) {
        throw new Error(`Invalid or oversized commit in ${projectionMigrationRangeKey(range)}.`);
      }
      digest.update(entry.commit);
      encodedBytes += entry.encodedByteLength;
      expected += 1;
      if (visit) await visit(entry.commit);
    }
    afterSequence = result.continuationAfterSequence;
  }
  const observed = digest.finish();
  if (expected - 1 !== range.lastSequence || observed.count !== range.commitCount) throw new Error(`Incomplete range ${projectionMigrationRangeKey(range)}.`);
  return { ...observed, bytes: encodedBytes };
}

export async function verifyProjectionMigrationSources(
  manifest: ProjectionMigrationManifest,
  reader: ProjectionCompleteCommitRangeReader,
  states: ProjectionMigrationStatePort,
  now: () => string
): Promise<void> {
  const existing = new Map((await states.readJournal(manifest.migrationId)).map((row) => [row.rangeKey, row]));
  for (const range of manifest.sourceRanges) {
    const key = projectionMigrationRangeKey(range);
    const row = existing.get(key);
    if (
      row &&
      row.manifestDigest === manifest.manifestDigest &&
      row.expectedDigest === range.expectedDigest &&
      row.observedDigest === range.expectedDigest &&
      row.commitCount === range.commitCount
    )
      continue;
    if (row) throw new Error(`Migration journal conflict for ${key}.`);
    const observed = await scanProjectionMigrationRange(reader, range);
    if (observed.digest !== range.expectedDigest) throw new Error(`Source digest mismatch for ${key}.`);
    const journal: ProjectionMigrationRangeJournal = {
      migrationId: manifest.migrationId,
      manifestDigest: manifest.manifestDigest,
      rangeKey: key,
      expectedDigest: range.expectedDigest,
      observedDigest: observed.digest,
      commitCount: observed.count,
      encodedBytes: observed.bytes,
      verifiedAt: now()
    };
    if ((await states.writeJournal(journal)) === 'conflict') throw new Error(`Migration journal conflict for ${key}.`);
  }
  assertExactJournal(manifest, await states.readJournal(manifest.migrationId));
}

export function assertExactJournal(manifest: ProjectionMigrationManifest, rows: readonly ProjectionMigrationRangeJournal[]): void {
  const actual = new Map(rows.map((row) => [row.rangeKey, row]));
  if (actual.size !== manifest.sourceRanges.length || rows.length !== manifest.sourceRanges.length)
    throw new Error('Migration journal coverage is incomplete.');
  for (const range of manifest.sourceRanges) {
    const row = actual.get(projectionMigrationRangeKey(range));
    if (!row || row.manifestDigest !== manifest.manifestDigest || row.observedDigest !== range.expectedDigest || row.commitCount !== range.commitCount)
      throw new Error('Migration journal coverage mismatch.');
  }
}

export async function replayProjectionMigrationRanges(
  manifest: ProjectionMigrationManifest,
  reader: ProjectionCompleteCommitRangeReader,
  target: ProjectionMigrationReplayPort
): Promise<void> {
  for (const range of manifest.sourceRanges) {
    const observed = await scanProjectionMigrationRange(reader, range);
    if (observed.digest !== range.expectedDigest) throw new Error(`Source digest changed before replay for ${projectionMigrationRangeKey(range)}.`);
    const applied = await scanProjectionMigrationRange(reader, range, async (commit) => {
      const result = await target.process(commit, {
        migrationId: manifest.migrationId,
        manifestDigest: manifest.manifestDigest,
        sourceId: commit.streamId,
        expectedSequence: commit.commitSequence === 0 ? null : commit.commitSequence - 1,
        finalSequence: commit.commitSequence
      });
      if (result.status !== 'completed') throw new Error(result.reason ?? 'Projection migration replay failed.');
    });
    if (applied.digest !== range.expectedDigest || applied.count !== range.commitCount) {
      throw new Error(`Source digest changed during replay for ${projectionMigrationRangeKey(range)}.`);
    }
  }
}
