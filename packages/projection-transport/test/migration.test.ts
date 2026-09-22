import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type {
  ProjectionCompleteCommitRangeReader,
  ProjectionQueueRegistryManifest,
  ProjectionSha256Digest,
  ProjectionSourceCommit
} from '@redemeine/projection-runtime-core';
import {
  assertRuntimeMatchesManifest,
  inspectProjectionMigrationRuntimeArtifact,
  type ProjectionMigrationActivationPort,
  ProjectionMigrationEngine,
  type ProjectionMigrationManifest,
  type ProjectionMigrationRangeJournal,
  type ProjectionMigrationSnapshot,
  type ProjectionMigrationState,
  type ProjectionMigrationStatePort,
  ProjectionMigrationStreamingDigest,
  parseProjectionMigrationRuntimeModule,
  projectionDefinitionRegistryDigest,
  projectionGenerationCollectionsAreIsolated,
  projectionMigrationDefinitionHash,
  projectionMigrationDigest,
  projectionMigrationManifestPayload,
  projectionMigrationRuntimeConfigurationDigest,
  projectionMigrationSourceDescriptorDigest,
  projectionQueueRegistryDigest,
  replayProjectionMigrationRanges,
  scanProjectionMigrationRange,
  validateProjectionMigrationManifest,
  verifyProjectionMigrationSources
} from '../src';

const SOURCE_A = '01234567-89ab-4def-8123-456789abcdef';
const SOURCE_B = '11234567-89ab-4def-8123-456789abcdef';
const digest = (value: unknown): ProjectionSha256Digest => projectionMigrationDigest(value);
const commit = (sourceId: string, sequence: number): ProjectionSourceCommit => ({
  streamId: sourceId,
  commitId: `${sourceId.slice(0, 8)}-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  commitSequence: sequence,
  events: [
    {
      eventId: `${sourceId.slice(0, 8)}-0000-4000-9000-${String(sequence).padStart(12, '0')}`,
      eventIndex: 0,
      streamVersion: sequence,
      aggregateType: 'Account',
      aggregateId: sourceId,
      type: 'Changed',
      payload: { sequence },
      timestamp: '2026-09-22T00:00:00.000Z'
    }
  ]
});

function commitDigest(commits: readonly ProjectionSourceCommit[]): ProjectionSha256Digest {
  const stream = new ProjectionMigrationStreamingDigest('redemeine:migration:complete-commits:v2');
  for (const value of commits) stream.update(value);
  return stream.finish().digest;
}

function deployment(generation: string, strategy: ProjectionMigrationManifest['destinationStrategies'][string] = 'none') {
  const deduplication = strategy === 'none' ? { strategy, duplicateEffects: 'acknowledged' as const, reason: 'migration' } : { strategy };
  return {
    projectionName: 'accounts',
    generation,
    from: { aggregateType: 'Account', aggregateKeys: ['aggregateType'], aggregatePureKeys: [], aggregateEventProjectorKeys: [], handlerKeys: ['Changed'] },
    joins: [],
    reverseSubscriptions: [],
    subscriptions: [],
    deduplication,
    hookKeys: [],
    identityConfiguration: { mode: 'aggregateId' }
  };
}

function registry(
  queueId: string,
  generation: string,
  anchors: Readonly<Record<string, number>>,
  strategy: ProjectionMigrationManifest['destinationStrategies'][string] = 'none',
  artifactDigest: ProjectionSha256Digest = digest(`${queueId}:code`)
): ProjectionQueueRegistryManifest {
  const configuration = deployment(generation, strategy);
  const definitions = [
    { projectionName: 'accounts', generation, definitionHash: projectionMigrationDefinitionHash(configuration, artifactDigest), sourceSelectors: ['Account'] }
  ];
  const payload = {
    version: 1 as const,
    queueId,
    registryGeneration: generation,
    identity: {
      version: 1 as const,
      normalizedDefinitionRegistryDigest: projectionDefinitionRegistryDigest(definitions),
      normalizedRuntimeConfigurationDigest: projectionMigrationRuntimeConfigurationDigest([configuration]),
      executableCodeArtifactDigest: artifactDigest
    },
    definitions,
    sourceStartAnchors: anchors
  };
  return { ...payload, manifestId: projectionQueueRegistryDigest(payload) };
}

function manifest(strategy: ProjectionMigrationManifest['destinationStrategies'][string] = 'none'): ProjectionMigrationManifest {
  const ranges = [
    { sourceId: SOURCE_A, firstSequence: 0, lastSequence: 1, commitCount: 2, expectedDigest: commitDigest([commit(SOURCE_A, 0), commit(SOURCE_A, 1)]) },
    { sourceId: SOURCE_B, firstSequence: 0, lastSequence: 0, commitCount: 1, expectedDigest: commitDigest([commit(SOURCE_B, 0)]) }
  ];
  const payload = {
    version: 2 as const,
    migrationId: 'accounts-v2',
    projectionName: 'accounts',
    oldGeneration: 'v1',
    newGeneration: 'v2',
    destinationStrategies: { accounts: strategy },
    streamIdentity: 'immutable_uuid_no_reset' as const,
    oldRegistry: registry('old-queue', 'v1', { [SOURCE_A]: 0, [SOURCE_B]: 0 }, strategy),
    newRegistry: registry('new-queue', 'v2', { [SOURCE_A]: 2, [SOURCE_B]: 1 }, strategy),
    sourceRanges: ranges,
    authoritativeSourceDigest: projectionMigrationSourceDescriptorDigest(ranges)
  };
  return { ...payload, manifestDigest: projectionMigrationDigest(projectionMigrationManifestPayload(payload), 'redemeine:migration:manifest:v2') };
}

function alternateManifest(): ProjectionMigrationManifest {
  const value = manifest();
  const { manifestId: _, ...registryPayload } = { ...value.newRegistry, queueId: 'alternate-new-queue' };
  const payload = { ...value, newRegistry: { ...registryPayload, manifestId: projectionQueueRegistryDigest(registryPayload) } };
  return { ...payload, manifestDigest: projectionMigrationDigest(projectionMigrationManifestPayload(payload), 'redemeine:migration:manifest:v2') };
}

class MemoryStates implements ProjectionMigrationStatePort {
  state: ProjectionMigrationState | null = null;
  journals = new Map<string, ProjectionMigrationRangeJournal>();
  writes = 0;
  async load(): Promise<ProjectionMigrationState | null> {
    return this.state;
  }
  async compareAndSet(expected: number | null, state: ProjectionMigrationState): Promise<boolean> {
    if ((this.state?.revision ?? null) !== expected) return false;
    this.state = state;
    this.writes += 1;
    return true;
  }
  async readJournal(): Promise<readonly ProjectionMigrationRangeJournal[]> {
    return [...this.journals.values()];
  }
  async writeJournal(row: ProjectionMigrationRangeJournal): Promise<'written' | 'matches' | 'conflict'> {
    const existing = this.journals.get(row.rangeKey);
    if (existing) return JSON.stringify(existing) === JSON.stringify(row) ? 'matches' : 'conflict';
    this.journals.set(row.rangeKey, row);
    return 'written';
  }
}

function reader(corruptSource?: string): ProjectionCompleteCommitRangeReader {
  return {
    capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
    readCompleteRange: async (request) => {
      if (request.sourceId === corruptSource)
        return { status: 'incomplete', reason: 'history_unavailable', details: 'corrupt', continuationAfterSequence: request.afterSequence };
      const values = Array.from({ length: request.throughSequence - (request.afterSequence ?? -1) }, (_, index) =>
        commit(request.sourceId, (request.afterSequence ?? -1) + index + 1)
      );
      return {
        status: 'complete',
        commits: values.map((value) => ({ commit: value, encodedByteLength: 100 })),
        encodedByteLength: values.length * 100,
        continuationAfterSequence: request.throughSequence,
        hasMore: false
      };
    }
  };
}

const snapshot: ProjectionMigrationSnapshot = {
  documents: { count: 1, digest: digest('documents') },
  links: { count: 1, digest: digest('links') },
  progress: { count: 1, digest: digest('progress') }
};

describe('P1-r9 projection migration', () => {
  it.each(['in_document', 'own_record', 'none'] as const)('accepts rebuild-only seq0 manifest for %s', (strategy) => {
    expect(validateProjectionMigrationManifest(manifest(strategy))).toEqual([]);
  });

  it('rejects in-place/same generation, unknown, unsorted, bad anchors, and configured bounds', () => {
    const value = manifest();
    expect(validateProjectionMigrationManifest({ ...value, mode: 'in_place' })).toContain('manifest.mode.unknown');
    expect(validateProjectionMigrationManifest({ ...value, newGeneration: value.oldGeneration })).toContain('freshGeneration');
    expect(validateProjectionMigrationManifest({ ...value, sourceRanges: [...value.sourceRanges].reverse() })).toContain('sourceRanges[1].order');
    expect(validateProjectionMigrationManifest({ ...value, newRegistry: { ...value.newRegistry, sourceStartAnchors: { [SOURCE_A]: 0 } } })).toContain(
      'newRegistry.sourceStartAnchors.coverage'
    );
    expect(validateProjectionMigrationManifest(value, 8 * 1024 * 1024 + 1)).toContain('manifest.unsupportedBound');
    expect(validateProjectionMigrationManifest({ ...value, sourceRanges: Array.from({ length: 10_001 }, () => value.sourceRanges[0]) })).toContain(
      'sourceRanges.unsupportedBound'
    );
  });

  it('uses constant-size streaming digest state with deterministic length framing', () => {
    const one = new ProjectionMigrationStreamingDigest('vector');
    one.update({ b: 2, a: 1 });
    const two = new ProjectionMigrationStreamingDigest('vector');
    two.update({ a: 1, b: 2 });
    const vector = one.finish();
    expect(vector).toEqual(two.finish());
    expect(vector.digest).toBe('sha256:66770a2ed231945e52885136e46be1c8a4a48e4788972650fa456b513fa11cb6');
    const long = new ProjectionMigrationStreamingDigest('vector');
    for (let index = 0; index < 10_000; index += 1) long.update(index);
    expect(Object.keys(long)).toHaveLength(3);
  });

  it('globally verifies all sources before replay and resumes exact journal rows', async () => {
    const states = new MemoryStates();
    const value = manifest();
    let applies = 0;
    await expect(verifyProjectionMigrationSources(value, reader(SOURCE_B), states, () => '2026-09-22T00:00:00.000Z')).rejects.toThrow('unavailable');
    expect(states.journals.size).toBe(1);
    expect(applies).toBe(0);
    await verifyProjectionMigrationSources(value, reader(), states, () => '2026-09-22T00:00:00.000Z');
    expect(states.journals.size).toBe(2);
    await replayProjectionMigrationRanges(value, reader(), {
      process: async () => {
        applies += 1;
        return { status: 'completed' };
      }
    });
    expect(applies).toBe(3);
  });

  it('pins every source read to 100 commits and 8 MiB and rejects oversized history', async () => {
    const range = manifest().sourceRanges[1]!;
    let observedRequest: { maxCommits: number; maxBytes: number } | undefined;
    const oversized: ProjectionCompleteCommitRangeReader = {
      capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
      readCompleteRange: async (request) => {
        observedRequest = request;
        return {
          status: 'oversized_commit',
          sourceId: request.sourceId,
          commitSequence: 0,
          commitId: 'oversized',
          encodedByteLength: request.maxBytes + 1,
          continuationAfterSequence: request.afterSequence
        };
      }
    };
    await expect(scanProjectionMigrationRange(oversized, range)).rejects.toThrow('unavailable');
    expect(observedRequest).toMatchObject({ maxCommits: 100, maxBytes: 8 * 1024 * 1024 });
  });

  it('rejects a digest change discovered by the applying replay scan', async () => {
    const value = manifest();
    const range = value.sourceRanges[0]!;
    let reads = 0;
    let applies = 0;
    const changing: ProjectionCompleteCommitRangeReader = {
      capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
      readCompleteRange: async (request) => {
        reads += 1;
        const commits = [commit(request.sourceId, 0), commit(request.sourceId, 1)];
        if (reads === 2) commits[1]!.events[0]!.payload = { sequence: 999 };
        return {
          status: 'complete',
          commits: commits.map((entry) => ({ commit: entry, encodedByteLength: 100 })),
          encodedByteLength: 200,
          continuationAfterSequence: request.throughSequence,
          hasMore: false
        };
      }
    };
    await expect(
      replayProjectionMigrationRanges({ ...value, sourceRanges: [range] }, changing, {
        process: async () => {
          applies += 1;
          return { status: 'completed' };
        }
      })
    ).rejects.toThrow('changed during replay');
    expect(applies).toBe(2);
  });

  it('recomputes full definition identity and rejects stale declarations or artifact bytes', () => {
    const registry = manifest().newRegistry;
    const executable = {
      generation: 'v2',
      definition: {
        name: 'accounts',
        fromStream: { aggregate: { aggregateType: 'Account' }, handlers: { Changed() {} } },
        joinStreams: [],
        reverseSubscribeStreams: [],
        initialState() {},
        identity() {
          return 'id';
        },
        subscriptions: [],
        deduplication: { strategy: 'none' as const, duplicateEffects: 'acknowledged' as const, reason: 'migration' }
      }
    };
    const declared = deployment('v2');
    const parsed = parseProjectionMigrationRuntimeModule({ migrationDefinitions: [executable], migrationDeploymentDefinitions: [declared] });
    expect(() => assertRuntimeMatchesManifest(parsed, registry, { accounts: 'none' }, registry.identity.executableCodeArtifactDigest)).not.toThrow();
    expect(() => assertRuntimeMatchesManifest(parsed, registry, { accounts: 'none' }, digest('changed-handler-artifact'))).toThrow('bundle identity');
    expect(() =>
      parseProjectionMigrationRuntimeModule({
        migrationDefinitions: [
          { ...executable, definition: { ...executable.definition, joinStreams: [{ aggregate: { aggregateType: 'Joined' }, handlers: { Joined() {} } }] } }
        ],
        migrationDeploymentDefinitions: [declared]
      })
    ).toThrow('normalized deployment');
    expect(() =>
      parseProjectionMigrationRuntimeModule({
        migrationDefinitions: [
          {
            ...executable,
            definition: { ...executable.definition, reverseSubscribeStreams: [{ aggregate: { aggregateType: 'Reverse' }, handlers: { Reversed() {} } }] }
          }
        ],
        migrationDeploymentDefinitions: [declared]
      })
    ).toThrow('normalized deployment');
    expect(() =>
      parseProjectionMigrationRuntimeModule({
        migrationDefinitions: [
          { ...executable, definition: { ...executable.definition, fromStream: { ...executable.definition.fromStream, handlers: { Other() {} } } } }
        ],
        migrationDeploymentDefinitions: [declared]
      })
    ).toThrow('normalized deployment');
  });

  it('hashes immutable bundle bytes before import and rejects changed code, mutable files, and symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'redemeine-runtime-artifact-'));
    const source = (amount: number) =>
      `const definition={name:'accounts',fromStream:{aggregate:{aggregateType:'Account'},handlers:{Changed(){return ${amount}}}},joinStreams:[],reverseSubscribeStreams:[],initialState(){},identity(){return'id'},subscriptions:[],deduplication:{strategy:'none',duplicateEffects:'acknowledged',reason:'migration'}};export const migrationDefinitions=[{generation:'v2',definition}];export const migrationDeploymentDefinitions=[{projectionName:'accounts',generation:'v2',from:{aggregateType:'Account',aggregateKeys:['aggregateType'],aggregatePureKeys:[],aggregateEventProjectorKeys:[],handlerKeys:['Changed']},joins:[],reverseSubscriptions:[],subscriptions:[],deduplication:{strategy:'none',duplicateEffects:'acknowledged',reason:'migration'},hookKeys:[],identityConfiguration:{mode:'aggregateId'}}];`;
    const originalPath = join(directory, 'original.mjs');
    const changedPath = join(directory, 'changed.mjs');
    try {
      await writeFile(originalPath, source(1));
      await expect(inspectProjectionMigrationRuntimeArtifact(originalPath)).rejects.toThrow('immutable');
      await chmod(originalPath, 0o444);
      await writeFile(changedPath, source(2));
      await chmod(changedPath, 0o444);
      const original = await inspectProjectionMigrationRuntimeArtifact(originalPath);
      const persisted = registry('new-queue', 'v2', { [SOURCE_A]: 2, [SOURCE_B]: 1 }, 'none', original.digest);
      const parsed = parseProjectionMigrationRuntimeModule({
        migrationDefinitions: [
          {
            generation: 'v2',
            definition: {
              name: 'accounts',
              fromStream: { aggregate: { aggregateType: 'Account' }, handlers: { Changed() {} } },
              joinStreams: [],
              reverseSubscribeStreams: [],
              initialState() {},
              identity() {
                return 'id';
              },
              subscriptions: [],
              deduplication: { strategy: 'none', duplicateEffects: 'acknowledged', reason: 'migration' }
            }
          }
        ],
        migrationDeploymentDefinitions: [deployment('v2')]
      });
      expect(() => assertRuntimeMatchesManifest(parsed, persisted, { accounts: 'none' }, original.digest)).not.toThrow();
      const changed = await inspectProjectionMigrationRuntimeArtifact(changedPath);
      expect(() => assertRuntimeMatchesManifest(parsed, persisted, { accounts: 'none' }, changed.digest)).toThrow('bundle identity');
      const link = join(directory, 'linked.mjs');
      await symlink(originalPath, link);
      await expect(inspectProjectionMigrationRuntimeArtifact(link)).rejects.toThrow('non-symlink');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects every old/new and intra-generation collection alias', () => {
    const old = { documents: 'old-docs', links: 'old-links', progress: 'old-progress', migrationReceipts: 'old-receipts' };
    const next = { documents: 'new-docs', links: 'new-links', progress: 'new-progress', migrationReceipts: 'new-receipts' };
    expect(projectionGenerationCollectionsAreIsolated(old, next)).toBe(true);
    const slots = ['documents', 'links', 'progress', 'migrationReceipts'] as const;
    for (const left of slots)
      for (const right of slots) {
        const changedOld = { ...old };
        const changedNext = { ...next };
        if (left < right) {
          changedOld[right] = changedOld[left];
          expect(projectionGenerationCollectionsAreIsolated(changedOld, changedNext)).toBe(false);
        }
        changedNext[right] = changedOld[left];
        expect(projectionGenerationCollectionsAreIsolated(changedOld, changedNext)).toBe(false);
      }
  });

  it('enforces phases, manifest identity, trusted snapshots, and preactivation-only rollback', async () => {
    const states = new MemoryStates();
    const active: ProjectionMigrationActivationPort = {
      activate: async (_manifest, state) => {
        const next = { ...state, revision: state.revision + 1, phase: 'activated' as const };
        states.state = next;
        return next;
      },
      verifyActive: async () => true
    };
    const engine = new ProjectionMigrationEngine({
      states,
      preflight: { inspect: async () => [] },
      sourceReader: reader(),
      replay: { process: async () => ({ status: 'completed' }) },
      snapshot: { read: async () => snapshot },
      activation: active,
      now: () => '2026-09-22T00:00:00.000Z'
    });
    const value = manifest();
    expect((await engine.preflight(value, true)).mutated).toBe(false);
    await engine.preflight(value);
    await engine.verifySources(value);
    await engine.replay(value);
    const conflicting = { ...value, manifestDigest: digest('other') };
    expect((await engine.activate(conflicting)).reasons).toContain('manifestDigest.mismatch');
    await engine.activate(value);
    expect((await engine.verify(value)).phase).toBe('verified');
    expect((await engine.rollback(value)).reasons).toContain('postActivationForwardRebuildRequired');
  });

  it('rejects migrationId manifest reuse in every phase', async () => {
    const original = manifest();
    const alternate = alternateManifest();
    const preflightStates = new MemoryStates();
    preflightStates.state = { migrationId: original.migrationId, manifestDigest: original.manifestDigest, revision: 0, phase: 'preflighted' };
    const preflightEngine = new ProjectionMigrationEngine({
      states: preflightStates,
      preflight: { inspect: async () => [] },
      sourceReader: reader(),
      replay: { process: async () => ({ status: 'completed' }) },
      snapshot: { read: async () => snapshot },
      activation: { activate: async () => null, verifyActive: async () => true }
    });
    expect((await preflightEngine.preflight(alternate)).reasons).toContain('migrationId.manifestConflict');
    const phases = ['preflighted', 'sources_verified', 'sources_replayed', 'activated', 'verified'] as const;
    for (const phase of phases) {
      const states = new MemoryStates();
      states.state = {
        migrationId: original.migrationId,
        manifestDigest: original.manifestDigest,
        revision: 1,
        phase,
        ...(phase === 'sources_replayed' || phase === 'activated' || phase === 'verified' ? { replaySnapshot: snapshot } : {})
      };
      const engine = new ProjectionMigrationEngine({
        states,
        preflight: { inspect: async () => [] },
        sourceReader: reader(),
        replay: { process: async () => ({ status: 'completed' }) },
        snapshot: { read: async () => snapshot },
        activation: { activate: async () => null, verifyActive: async () => true }
      });
      const result =
        phase === 'preflighted'
          ? await engine.verifySources(alternate)
          : phase === 'sources_verified'
            ? await engine.replay(alternate)
            : phase === 'sources_replayed'
              ? await engine.activate(alternate)
              : phase === 'activated'
                ? await engine.verify(alternate)
                : await engine.rollback(alternate);
      expect(result.reasons).toContain('manifestConflictOrMissing');
    }
  });
});
