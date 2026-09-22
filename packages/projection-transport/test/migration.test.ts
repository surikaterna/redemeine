import { describe, expect, it } from '@jest/globals';
import type { ProjectionCompleteCommitRangeReader, ProjectionQueueRegistryManifest, ProjectionSha256Digest, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import {
  ProjectionMigrationEngine, ProjectionMigrationStreamingDigest, projectionMigrationDigest, projectionMigrationManifestPayload,
  projectionMigrationSourceDescriptorDigest, replayProjectionMigrationRanges, verifyProjectionMigrationSources,
  scanProjectionMigrationRange, validateProjectionMigrationManifest, type ProjectionMigrationActivationPort, type ProjectionMigrationManifest,
  type ProjectionMigrationRangeJournal, type ProjectionMigrationSnapshot, type ProjectionMigrationState, type ProjectionMigrationStatePort
} from '../src';

const SOURCE_A = '01234567-89ab-4def-8123-456789abcdef';
const SOURCE_B = '11234567-89ab-4def-8123-456789abcdef';
const digest = (value: unknown): ProjectionSha256Digest => projectionMigrationDigest(value);
const commit = (sourceId: string, sequence: number): ProjectionSourceCommit => ({ streamId: sourceId,
  commitId: `${sourceId.slice(0, 8)}-0000-4000-8000-${String(sequence).padStart(12, '0')}`, commitSequence: sequence,
  events: [{ eventId: `${sourceId.slice(0, 8)}-0000-4000-9000-${String(sequence).padStart(12, '0')}`, eventIndex: 0,
    streamVersion: sequence, aggregateType: 'Account', aggregateId: sourceId, type: 'Changed', payload: { sequence },
    timestamp: '2026-09-22T00:00:00.000Z' }] });

function commitDigest(commits: readonly ProjectionSourceCommit[]): ProjectionSha256Digest {
  const stream = new ProjectionMigrationStreamingDigest('redemeine:migration:complete-commits:v2');
  for (const value of commits) stream.update(value);
  return stream.finish().digest;
}

function registry(queueId: string, generation: string, anchors: Readonly<Record<string, number>>): ProjectionQueueRegistryManifest {
  return { version: 1, manifestId: digest(`${queueId}:manifest`), queueId, registryGeneration: generation,
    identity: { version: 1, normalizedDefinitionRegistryDigest: digest(`${queueId}:definitions`),
      normalizedRuntimeConfigurationDigest: digest(`${queueId}:config`), executableCodeArtifactDigest: digest(`${queueId}:code`) },
    definitions: [{ projectionName: 'accounts', generation, definitionHash: digest(`${queueId}:definition`), sourceSelectors: ['Account'] }],
    sourceStartAnchors: anchors };
}

function manifest(strategy: ProjectionMigrationManifest['destinationStrategies'][string] = 'none'): ProjectionMigrationManifest {
  const ranges = [
    { sourceId: SOURCE_A, firstSequence: 0, lastSequence: 1, commitCount: 2, expectedDigest: commitDigest([commit(SOURCE_A, 0), commit(SOURCE_A, 1)]) },
    { sourceId: SOURCE_B, firstSequence: 0, lastSequence: 0, commitCount: 1, expectedDigest: commitDigest([commit(SOURCE_B, 0)]) }
  ];
  const payload = { version: 2 as const, migrationId: 'accounts-v2', projectionName: 'accounts', oldGeneration: 'v1', newGeneration: 'v2',
    destinationStrategies: { accounts: strategy }, streamIdentity: 'immutable_uuid_no_reset' as const,
    oldRegistry: registry('old-queue', 'v1', { [SOURCE_A]: 0, [SOURCE_B]: 0 }),
    newRegistry: registry('new-queue', 'v2', { [SOURCE_A]: 2, [SOURCE_B]: 1 }), sourceRanges: ranges,
    authoritativeSourceDigest: projectionMigrationSourceDescriptorDigest(ranges) };
  return { ...payload, manifestDigest: projectionMigrationDigest(projectionMigrationManifestPayload(payload), 'redemeine:migration:manifest:v2') };
}

function alternateManifest(): ProjectionMigrationManifest {
  const value = manifest();
  const payload = { ...value, newRegistry: { ...value.newRegistry, manifestId: digest('alternate-new-registry') } };
  return { ...payload, manifestDigest: projectionMigrationDigest(projectionMigrationManifestPayload(payload), 'redemeine:migration:manifest:v2') };
}

class MemoryStates implements ProjectionMigrationStatePort {
  state: ProjectionMigrationState | null = null; journals = new Map<string, ProjectionMigrationRangeJournal>(); writes = 0;
  async load(): Promise<ProjectionMigrationState | null> { return this.state; }
  async compareAndSet(expected: number | null, state: ProjectionMigrationState): Promise<boolean> {
    if ((this.state?.revision ?? null) !== expected) return false; this.state = state; this.writes += 1; return true;
  }
  async readJournal(): Promise<readonly ProjectionMigrationRangeJournal[]> { return [...this.journals.values()]; }
  async writeJournal(row: ProjectionMigrationRangeJournal): Promise<'written' | 'matches' | 'conflict'> {
    const existing = this.journals.get(row.rangeKey); if (existing) return JSON.stringify(existing) === JSON.stringify(row) ? 'matches' : 'conflict';
    this.journals.set(row.rangeKey, row); return 'written';
  }
}

function reader(corruptSource?: string): ProjectionCompleteCommitRangeReader {
  return { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true }, readCompleteRange: async (request) => {
    if (request.sourceId === corruptSource) return { status: 'incomplete', reason: 'history_unavailable', details: 'corrupt', continuationAfterSequence: request.afterSequence };
    const values = Array.from({ length: request.throughSequence - (request.afterSequence ?? -1) }, (_, index) => commit(request.sourceId, (request.afterSequence ?? -1) + index + 1));
    return { status: 'complete', commits: values.map((value) => ({ commit: value, encodedByteLength: 100 })), encodedByteLength: values.length * 100,
      continuationAfterSequence: request.throughSequence, hasMore: false };
  } };
}

const snapshot: ProjectionMigrationSnapshot = { documents: { count: 1, digest: digest('documents') }, links: { count: 1, digest: digest('links') },
  progress: { count: 1, digest: digest('progress') } };

describe('P1-r9 projection migration', () => {
  it.each(['in_document', 'own_record', 'none'] as const)('accepts rebuild-only seq0 manifest for %s', (strategy) => {
    expect(validateProjectionMigrationManifest(manifest(strategy))).toEqual([]);
  });

  it('rejects in-place/same generation, unknown, unsorted, bad anchors, and configured bounds', () => {
    const value = manifest();
    expect(validateProjectionMigrationManifest({ ...value, mode: 'in_place' })).toContain('manifest.mode.unknown');
    expect(validateProjectionMigrationManifest({ ...value, newGeneration: value.oldGeneration })).toContain('freshGeneration');
    expect(validateProjectionMigrationManifest({ ...value, sourceRanges: [...value.sourceRanges].reverse() })).toContain('sourceRanges[1].order');
    expect(validateProjectionMigrationManifest({ ...value, newRegistry: { ...value.newRegistry, sourceStartAnchors: { [SOURCE_A]: 0 } } })).toContain('newRegistry.sourceStartAnchors.coverage');
    expect(validateProjectionMigrationManifest(value, 8 * 1024 * 1024 + 1)).toContain('manifest.unsupportedBound');
    expect(validateProjectionMigrationManifest({ ...value, sourceRanges: Array.from({ length: 10_001 }, () => value.sourceRanges[0]) })).toContain('sourceRanges.unsupportedBound');
  });

  it('uses constant-size streaming digest state with deterministic length framing', () => {
    const one = new ProjectionMigrationStreamingDigest('vector'); one.update({ b: 2, a: 1 });
    const two = new ProjectionMigrationStreamingDigest('vector'); two.update({ a: 1, b: 2 });
    const vector = one.finish(); expect(vector).toEqual(two.finish());
    expect(vector.digest).toBe('sha256:66770a2ed231945e52885136e46be1c8a4a48e4788972650fa456b513fa11cb6');
    const long = new ProjectionMigrationStreamingDigest('vector');
    for (let index = 0; index < 10_000; index += 1) long.update(index);
    expect(Object.keys(long)).toHaveLength(3);
  });

  it('globally verifies all sources before replay and resumes exact journal rows', async () => {
    const states = new MemoryStates(); const value = manifest(); let applies = 0;
    await expect(verifyProjectionMigrationSources(value, reader(SOURCE_B), states, () => '2026-09-22T00:00:00.000Z')).rejects.toThrow('unavailable');
    expect(states.journals.size).toBe(1); expect(applies).toBe(0);
    await verifyProjectionMigrationSources(value, reader(), states, () => '2026-09-22T00:00:00.000Z');
    expect(states.journals.size).toBe(2);
    await replayProjectionMigrationRanges(value, reader(), { process: async () => { applies += 1; return { status: 'completed' }; } });
    expect(applies).toBe(3);
  });

  it('pins every source read to 100 commits and 8 MiB and rejects oversized history', async () => {
    const range = manifest().sourceRanges[1]!; let observedRequest: { maxCommits: number; maxBytes: number } | undefined;
    const oversized: ProjectionCompleteCommitRangeReader = { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
      readCompleteRange: async (request) => { observedRequest = request; return { status: 'oversized_commit', sourceId: request.sourceId,
        commitSequence: 0, commitId: 'oversized', encodedByteLength: request.maxBytes + 1, continuationAfterSequence: request.afterSequence }; } };
    await expect(scanProjectionMigrationRange(oversized, range)).rejects.toThrow('unavailable');
    expect(observedRequest).toMatchObject({ maxCommits: 100, maxBytes: 8 * 1024 * 1024 });
  });

  it('enforces phases, manifest identity, trusted snapshots, and preactivation-only rollback', async () => {
    const states = new MemoryStates(); const active: ProjectionMigrationActivationPort = { activate: async (_manifest, state) => {
      const next = { ...state, revision: state.revision + 1, phase: 'activated' as const }; states.state = next; return next;
    }, verifyActive: async () => true };
    const engine = new ProjectionMigrationEngine({ states, preflight: { inspect: async () => [] }, sourceReader: reader(),
      replay: { process: async () => ({ status: 'completed' }) }, snapshot: { read: async () => snapshot }, activation: active,
      now: () => '2026-09-22T00:00:00.000Z' });
    const value = manifest(); expect((await engine.preflight(value, true)).mutated).toBe(false);
    await engine.preflight(value); await engine.verifySources(value); await engine.replay(value);
    const conflicting = { ...value, manifestDigest: digest('other') };
    expect((await engine.activate(conflicting)).reasons).toContain('manifestDigest.mismatch');
    await engine.activate(value); expect((await engine.verify(value)).phase).toBe('verified');
    expect((await engine.rollback(value)).reasons).toContain('postActivationForwardRebuildRequired');
  });

  it('rejects migrationId manifest reuse in every phase', async () => {
    const original = manifest(); const alternate = alternateManifest();
    const preflightStates = new MemoryStates(); preflightStates.state = { migrationId: original.migrationId,
      manifestDigest: original.manifestDigest, revision: 0, phase: 'preflighted' };
    const preflightEngine = new ProjectionMigrationEngine({ states: preflightStates, preflight: { inspect: async () => [] }, sourceReader: reader(),
      replay: { process: async () => ({ status: 'completed' }) }, snapshot: { read: async () => snapshot },
      activation: { activate: async () => null, verifyActive: async () => true } });
    expect((await preflightEngine.preflight(alternate)).reasons).toContain('migrationId.manifestConflict');
    const phases = ['preflighted', 'sources_verified', 'sources_replayed', 'activated', 'verified'] as const;
    for (const phase of phases) {
      const states = new MemoryStates(); states.state = { migrationId: original.migrationId, manifestDigest: original.manifestDigest, revision: 1, phase,
        ...(phase === 'sources_replayed' || phase === 'activated' || phase === 'verified' ? { replaySnapshot: snapshot } : {}) };
      const engine = new ProjectionMigrationEngine({ states, preflight: { inspect: async () => [] }, sourceReader: reader(),
        replay: { process: async () => ({ status: 'completed' }) }, snapshot: { read: async () => snapshot },
        activation: { activate: async () => null, verifyActive: async () => true } });
      const result = phase === 'preflighted' ? await engine.verifySources(alternate)
        : phase === 'sources_verified' ? await engine.replay(alternate)
          : phase === 'sources_replayed' ? await engine.activate(alternate)
            : phase === 'activated' ? await engine.verify(alternate) : await engine.rollback(alternate);
      expect(result.reasons).toContain('manifestConflictOrMissing');
    }
  });
});
