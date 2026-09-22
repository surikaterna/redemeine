import { describe, expect, it } from '@jest/globals';
import type { ProjectionCompleteCommitRangeReader, ProjectionQueueRegistryManifest, ProjectionSha256Digest, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import {
  ProjectionMigrationEngine, projectionMigrationDigest, projectionMigrationManifestPayload, replayProjectionMigrationRanges, validateProjectionMigrationManifest,
  type ProjectionMigrationManifest, type ProjectionMigrationRegistryPort, type ProjectionMigrationState, type ProjectionMigrationStatePort
} from '../src';

const SOURCE_ID = '01234567-89ab-4def-8123-456789abcdef';
const digest = (label: string): ProjectionSha256Digest => projectionMigrationDigest(label);
const commits: readonly ProjectionSourceCommit[] = [0, 1].map((sequence) => ({ streamId: SOURCE_ID, commitId: `commit-${sequence}`, commitSequence: sequence,
  events: [{ eventId: `event-${sequence}`, eventIndex: 0, streamVersion: sequence, aggregateType: 'Account', aggregateId: 'a-1', type: 'Changed', payload: {},
    timestamp: '2026-09-22T00:00:00.000Z' }] })) as ProjectionSourceCommit[];

function registry(queueId: string, generation: string, anchor = 0): ProjectionQueueRegistryManifest {
  return {
    version: 1, manifestId: digest(`${queueId}-manifest`), queueId, registryGeneration: generation,
    identity: { version: 1, normalizedDefinitionRegistryDigest: digest(`${queueId}-definitions`),
      normalizedRuntimeConfigurationDigest: digest(`${queueId}-config`), executableCodeArtifactDigest: digest(`${queueId}-code`) },
    definitions: [{ projectionName: 'accounts', generation, definitionHash: digest(`${queueId}-definition`), sourceSelectors: ['Account'] }],
    sourceStartAnchors: { [SOURCE_ID]: anchor }
  };
}

function manifest(overrides: Partial<ProjectionMigrationManifest> = {}): ProjectionMigrationManifest {
  const ranges = [{ sourceId: SOURCE_ID, firstSequence: 0, lastSequence: 1, commitCount: 2, completeCommitBoundaries: true as const,
    rangeDigest: projectionMigrationDigest(commits.map(projectionMigrationDigest)) }];
  const boundary = projectionMigrationDigest(ranges);
  const payload = {
    version: 1 as const, migrationId: 'accounts-v2', mode: 'rebuild' as const, oldRegistry: registry('old-queue', 'v1'), newRegistry: registry('new-queue', 'v2'),
    projectionName: 'accounts', oldGeneration: 'v1', newGeneration: 'v2', oldStrategy: 'in_document' as const, newStrategy: 'in_document' as const,
    streamIdentity: 'immutable_uuid_no_reset' as const, transportStartAnchors: { [SOURCE_ID]: 0 }, sourceCommitRanges: ranges,
    authoritativeBoundaryDigest: boundary, authoritativeSourceDigest: boundary, snapshot: null, executableCodeDigest: digest('code'),
    runtimeConfigDigest: digest('config'), retainOldArtifacts: true, ...overrides
  };
  return { ...payload, manifestDigest: projectionMigrationDigest(projectionMigrationManifestPayload(payload)) };
}

class MemoryStates implements ProjectionMigrationStatePort {
  state: ProjectionMigrationState | null = null;
  failNext = false;
  writes = 0;
  async load(): Promise<ProjectionMigrationState | null> { return this.state; }
  async compareAndSet(expected: number | null, state: ProjectionMigrationState): Promise<boolean> {
    if (this.failNext) { this.failNext = false; return false; }
    if ((this.state?.revision ?? null) !== expected) return false;
    this.state = state; this.writes += 1; return true;
  }
}

class MemoryRegistry implements ProjectionMigrationRegistryPort {
  result: 'bound' | 'matches' | 'conflict' = 'bound';
  calls = 0;
  async adopt(): Promise<'bound' | 'matches' | 'conflict'> { this.calls += 1; return this.result; }
}

const quiescePayload = { oldQueueDepth: 0 as const, oldActiveWriters: 0 as const, newActiveWriters: 0 as const, drainedAt: '2026-09-22T00:00:00.000Z' };
const quiesced = { ...quiescePayload, digest: projectionMigrationDigest(quiescePayload) };
const replay = (value: ProjectionMigrationManifest) => ({ replayedRangesDigest: value.authoritativeSourceDigest, stateDigest: digest('rebuilt-state'),
  linkDigest: digest('rebuilt-links'), completedAt: '2026-09-22T00:30:00.000Z' });

describe('projection migration', () => {
  it('dry-runs without mutation and handles sequence zero as a real anchor', async () => {
    const states = new MemoryStates();
    const result = await new ProjectionMigrationEngine(states, new MemoryRegistry()).preflight(manifest(), true);
    expect(result).toMatchObject({ status: 'ok', mutated: false, phase: null });
    expect(states.writes).toBe(0);
  });

  it('rejects corrupt, unknown, partial, scalar-cursor-like, and unprovable manifests', () => {
    const valid = manifest();
    const corrupt = { ...valid, manifestDigest: digest('wrong'), legacyCursor: 4 };
    expect(validateProjectionMigrationManifest(corrupt)).toEqual(expect.arrayContaining(['manifest.legacyCursor.unknown', 'manifestDigest.mismatch']));
    const partial = manifest({ sourceCommitRanges: [{ ...valid.sourceCommitRanges[0]!, completeCommitBoundaries: false }] as never });
    expect(validateProjectionMigrationManifest(partial)).toContain('sourceCommitRanges[0].completeCommitBoundaries');
    const missing = manifest({ sourceCommitRanges: [] });
    expect(validateProjectionMigrationManifest(missing)).toEqual(expect.arrayContaining(['sourceCommitRanges.coverage', 'authoritativeSourceDigest.mismatch']));
  });

  it.each([
    ['in_document', 'own_record'], ['own_record', 'in_document'], ['none', 'in_document'], ['in_document', 'none']
  ] as const)('requires a new generation for %s to %s', (oldStrategy, newStrategy) => {
    const candidate = manifest({ mode: 'in_place', oldGeneration: 'v1', newGeneration: 'v1', oldStrategy, newStrategy,
      newRegistry: registry('new-queue', 'v1'), snapshot: { boundaryDigest: manifest().authoritativeBoundaryDigest, stateDigest: digest('state'), linkDigest: digest('links') } });
    expect(validateProjectionMigrationManifest(candidate)).toContain('strategyChange.requiresNewGeneration');
  });

  it('accepts certified in-place adoption only at the source snapshot boundary', () => {
    const base = manifest();
    const candidate = manifest({ mode: 'in_place', oldGeneration: 'v1', newGeneration: 'v1', newRegistry: registry('new-queue', 'v1'),
      snapshot: { boundaryDigest: base.authoritativeBoundaryDigest, stateDigest: digest('state'), linkDigest: digest('links') } });
    expect(validateProjectionMigrationManifest(candidate)).toEqual([]);
    expect(validateProjectionMigrationManifest(manifest({ ...candidate, snapshot: { ...candidate.snapshot!, boundaryDigest: digest('other') } }))).toContain('snapshot.boundaryDigest.mismatch');
  });

  it('rejects dual writers and an undrained queue without advancing', async () => {
    const states = new MemoryStates(); const engine = new ProjectionMigrationEngine(states, new MemoryRegistry()); const value = manifest();
    await engine.preflight(value);
    const result = await engine.quiesce(value, { ...quiesced, oldActiveWriters: 1 as never });
    expect(result).toMatchObject({ status: 'rejected', mutated: false, reasons: ['dualWriterOrUndrained'] });
    expect(states.state?.phase).toBe('preflighted');
  });

  it('is restart-safe and idempotent through every phase', async () => {
    const states = new MemoryStates(); const registryPort = new MemoryRegistry(); const value = manifest();
    const engine = new ProjectionMigrationEngine(states, registryPort, () => '2026-09-22T01:00:00.000Z');
    await engine.preflight(value); expect((await engine.preflight(value)).mutated).toBe(false);
    await engine.quiesce(value, quiesced); expect((await engine.quiesce(value, quiesced)).mutated).toBe(false);
    states.failNext = true; expect((await engine.activate(value, replay(value))).reasons).toContain('concurrentChange');
    expect(states.state?.phase).toBe('quiesced');
    await engine.activate(value, replay(value)); expect((await engine.activate(value, replay(value))).mutated).toBe(false);
    const verification = { replayedRangesDigest: value.authoritativeSourceDigest, stateDigest: digest('rebuilt-state'), linkDigest: digest('rebuilt-links'),
      activeWriters: 1 as const, verifiedAt: '2026-09-22T02:00:00.000Z' };
    await engine.verify(value, verification); expect((await engine.verify(value, verification)).mutated).toBe(false);
    expect(states.state?.phase).toBe('verified');
  });

  it('adopts an immutable registry and rejects conflicts', async () => {
    const states = new MemoryStates(); const registryPort = new MemoryRegistry(); const value = manifest();
    const engine = new ProjectionMigrationEngine(states, registryPort); await engine.preflight(value); await engine.quiesce(value, quiesced);
    registryPort.result = 'conflict';
    expect((await engine.activate(value, replay(value))).reasons).toContain('newRegistry.conflict');
    expect(states.state?.phase).toBe('quiesced');
  });

  it('rolls back only with retained feed and no conflicting post-activation writes', async () => {
    const states = new MemoryStates(); const value = manifest(); const engine = new ProjectionMigrationEngine(states, new MemoryRegistry());
    await engine.preflight(value); await engine.quiesce(value, quiesced); await engine.activate(value, replay(value));
    expect((await engine.rollback(value, 'bad verification', false, false)).reasons).toContain('manualRebuildRequired');
    expect((await engine.rollback(value, 'bad verification', true, true)).reasons).toContain('manualRebuildRequired');
    expect(await engine.rollback(value, 'bad verification', true, false)).toMatchObject({ status: 'ok', phase: 'rolled_back', mutated: true });
    expect((await engine.rollback(value, 'again', true, false)).mutated).toBe(false);
  });

  it('replays every complete commit and rejects corrupt authoritative ranges', async () => {
    const reader: ProjectionCompleteCommitRangeReader = { capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
      readCompleteRange: async () => ({ status: 'complete', commits: commits.map((commit) => ({ commit, encodedByteLength: 10 })), encodedByteLength: 20,
        continuationAfterSequence: 1, hasMore: false }) };
    const applied: number[] = [];
    const evidence = await replayProjectionMigrationRanges(manifest(), reader, { loadAppliedSequence: async () => null,
      applyCompleteCommit: async (commit) => { applied.push(commit.commitSequence); },
      snapshotDigests: async () => ({ stateDigest: digest('rebuilt-state'), linkDigest: digest('rebuilt-links') }) },
    { now: () => '2026-09-22T00:30:00.000Z' });
    expect(applied).toEqual([0, 1]);
    expect(evidence.replayedRangesDigest).toBe(manifest().authoritativeSourceDigest);
    let corruptApplies = 0;
    await expect(replayProjectionMigrationRanges(manifest({ sourceCommitRanges: [{ ...manifest().sourceCommitRanges[0]!, rangeDigest: digest('corrupt') }] }), reader,
      { loadAppliedSequence: async () => null, applyCompleteCommit: async () => { corruptApplies += 1; },
        snapshotDigests: async () => ({ stateDigest: digest('state'), linkDigest: digest('links') }) })).rejects.toThrow('digest mismatch');
    expect(corruptApplies).toBe(0);
    const resumed: number[] = [];
    await replayProjectionMigrationRanges(manifest(), reader, { loadAppliedSequence: async () => 0,
      applyCompleteCommit: async (commit) => { resumed.push(commit.commitSequence); },
      snapshotDigests: async () => ({ stateDigest: digest('rebuilt-state'), linkDigest: digest('rebuilt-links') }) });
    expect(resumed).toEqual([1]);
  });
});
