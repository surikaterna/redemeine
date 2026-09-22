import { describe, expect, test } from '@jest/globals';
import {
  hasMatchingProjectionRegistryIdentity,
  isCompleteCommitRangeCapability,
  projectionBase64Url22ToUuid,
  projectionUuidToBase64Url22,
  validateCompleteCommitRange,
  validateProjectionQueueRegistryManifest,
  validateProjectionSourceCommit
} from '../src';
import type {
  CommitProjectionSourceCommitRequest,
  ProjectionCompleteCommitRangeRequest,
  ProjectionQueueRegistryManifest,
  ProjectionQueueRegistryBinding,
  ProjectionSourceCheckpoint,
  ProjectionSourceCommit,
  ProjectionSourceCommitStorePort,
  ProjectionSourceOrderPort
} from '../src';

const streamId = '00112233-4455-6677-8899-aabbccddeeff';
const digest = `sha256:${'a'.repeat(64)}` as const;

function createCommit(sequence = 0): ProjectionSourceCommit {
  return {
    streamId,
    commitId: '123e4567-e89b-12d3-a456-426614174000',
    commitSequence: sequence,
    events: [
      {
        eventId: '123e4567-e89b-12d3-a456-426614174001',
        eventIndex: 0,
        streamVersion: 4,
        aggregateType: 'invoice',
        aggregateId: 'invoice-1',
        type: 'invoice.created.event',
        payload: { amount: 42 },
        timestamp: '2026-09-22T10:00:00.000Z'
      },
      {
        eventId: '123e4567-e89b-12d3-a456-426614174002',
        eventIndex: 1,
        streamVersion: 5,
        aggregateType: 'invoice',
        aggregateId: 'invoice-1',
        type: 'invoice.approved.event',
        payload: { approver: 'operator' },
        timestamp: '2026-09-22T10:00:00.001Z'
      }
    ]
  };
}

describe('complete projection source commits', () => {
  test('accepts sequence zero and contiguous event indexes and versions', () => {
    const result = validateProjectionSourceCommit(createCommit());
    expect(result.valid).toBe(true);
  });

  test('rejects malformed UUIDs, unsafe JSON, and incomplete event ordering', () => {
    const invalid = createCommit();
    const events = invalid.events.map((event) => ({ ...event }));
    events[1].eventIndex = 2;
    events[1].streamVersion = 7;
    events[1].payload = { amount: Number.NaN };

    const result = validateProjectionSourceCommit({
      ...invalid,
      commitId: invalid.commitId.toUpperCase(),
      events
    });
    expect(result).toEqual({
      valid: false,
      issues: expect.arrayContaining([
        'commitId',
        'events[1].eventIndex',
        'events[1].streamVersion',
        'events[1].payload'
      ])
    });
  });

  test('keeps checkpoint absence distinct from sequence zero and excludes commit identity', () => {
    const absent: ProjectionSourceCheckpoint | null = null;
    const atZero: ProjectionSourceCheckpoint = { sequence: 0 };
    expect(absent).toBeNull();
    expect(atZero.sequence).toBe(0);
    // @ts-expect-error projection checkpoints contain sequence only
    const invalid: ProjectionSourceCheckpoint = { sequence: 0, commitId: 'not-checkpoint-data' };
    void invalid;
  });
});

describe('canonical UUID base64url codec', () => {
  test.each([
    ['00000000-0000-0000-0000-000000000000', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['00112233-4455-6677-8899-aabbccddeeff', 'ABEiM0RVZneImaq7zN3u_w'],
    ['ffffffff-ffff-ffff-ffff-ffffffffffff', '_____________________w']
  ])('round-trips %s', (uuid, encoded) => {
    expect(projectionUuidToBase64Url22(uuid)).toBe(encoded);
    expect(projectionBase64Url22ToUuid(encoded)).toBe(uuid);
  });

  test('rejects noncanonical and padded values', () => {
    expect(() => projectionUuidToBase64Url22(streamId.toUpperCase())).toThrow(TypeError);
    expect(() => projectionBase64Url22ToUuid('AAAAAAAAAAAAAAAAAAAAAA==')).toThrow(TypeError);
    expect(() => projectionBase64Url22ToUuid('AAAAAAAAAAAAAAAAAAAAAB')).toThrow(TypeError);
  });
});

describe('ordering and range contracts', () => {
  test('requires explicit complete unsliced capability', () => {
    expect(isCompleteCommitRangeCapability({
      completeCommitBoundaries: true,
      unslicedCommitEvents: true
    })).toBe(true);
    expect(isCompleteCommitRangeCapability({
      completeCommitBoundaries: true,
      unslicedCommitEvents: false
    })).toBe(false);
  });

  test('accepts byte-accounted complete contiguous ranges and rejects sliced boundaries', () => {
    const request: ProjectionCompleteCommitRangeRequest = {
      sourceId: streamId,
      afterSequence: null,
      throughSequence: 0,
      maxCommits: 10,
      maxBytes: 1_024
    };
    expect(validateCompleteCommitRange(request, {
      status: 'complete',
      commits: [{ commit: createCommit(0), encodedByteLength: 512 }],
      encodedByteLength: 512,
      continuationAfterSequence: 0,
      hasMore: false
    }).valid).toBe(true);
    expect(validateCompleteCommitRange(request, {
      status: 'incomplete',
      reason: 'sliced_boundary',
      details: 'first event was sliced by the upstream query',
      continuationAfterSequence: null
    })).toEqual({ valid: false, issues: ['sliced_boundary'] });
  });

  test('rejects invalid limits, byte mismatches, excess counts, and out-of-range commits', () => {
    const request = {
      sourceId: streamId,
      afterSequence: 0,
      throughSequence: 1,
      maxCommits: 0,
      maxBytes: 500
    };
    const result = validateCompleteCommitRange(request, {
      status: 'complete',
      commits: [
        { commit: createCommit(1), encodedByteLength: 300 },
        { commit: createCommit(2), encodedByteLength: 300 }
      ],
      encodedByteLength: 599,
      continuationAfterSequence: 2,
      hasMore: false
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      'request.maxCommits', 'max_commits', 'boundary[2]', 'encoded_bytes_mismatch', 'max_bytes'
    ]));
    expect(validateCompleteCommitRange({
      ...request,
      maxCommits: 1,
      maxBytes: Number.MAX_SAFE_INTEGER + 1
    }, {
      status: 'complete',
      commits: [],
      encodedByteLength: 0,
      continuationAfterSequence: 0,
      hasMore: false
    }).issues).toContain('request.maxBytes');
  });

  test('reports an oversized first commit without advancing continuation', () => {
    const request: ProjectionCompleteCommitRangeRequest = {
      sourceId: streamId,
      afterSequence: 4,
      throughSequence: 8,
      maxCommits: 2,
      maxBytes: 1_024
    };
    expect(validateCompleteCommitRange(request, {
      status: 'oversized_commit',
      sourceId: streamId,
      commitSequence: 5,
      commitId: '123e4567-e89b-12d3-a456-426614174000',
      encodedByteLength: 1_025,
      continuationAfterSequence: 4
    })).toEqual({ valid: false, issues: ['oversized_commit'] });
  });

  test('transport coverage can only admit dispatch, including redelivery', async () => {
    const port: ProjectionSourceOrderPort = {
      async admitForDispatch(commit, queueBindingId) {
        return {
          dispatch: true,
          coverage: { queueBindingId, sourceId: commit.streamId, sequence: commit.commitSequence }
        };
      },
      async advanceCoverage(request) {
        return { queueBindingId: request.queueBindingId, sourceId: request.sourceId, sequence: request.sequence };
      }
    };
    const admission = await port.admitForDispatch(createCommit(0), 'queue-v1');
    expect(admission.dispatch).toBe(true);
  });
});

describe('immutable queue registry manifest', () => {
  function createManifest(): ProjectionQueueRegistryManifest {
    return {
      version: 1,
      manifestId: digest,
      queueId: 'projection-v1',
      registryGeneration: 'generation-v1',
      identity: {
        version: 1,
        normalizedDefinitionRegistryDigest: digest,
        normalizedRuntimeConfigurationDigest: digest,
        executableCodeArtifactDigest: digest
      },
      definitions: [{
        projectionName: 'summary',
        generation: 'v1',
        definitionHash: digest,
        sourceSelectors: ['invoice']
      }],
      sourceStartAnchors: { [streamId]: 0 }
    };
  }

  test('requires versioned SHA-256 identities for runtime configuration and executable code', () => {
    expect(validateProjectionQueueRegistryManifest(createManifest())).toEqual([]);
    const invalid = createManifest();
    const issues = validateProjectionQueueRegistryManifest({
      ...invalid,
      identity: {
        version: 1,
        normalizedDefinitionRegistryDigest: digest,
        normalizedRuntimeConfigurationDigest: 'sha256:short',
        executableCodeArtifactDigest: ''
      }
    } as ProjectionQueueRegistryManifest);
    expect(issues).toEqual([
      'identity.normalizedRuntimeConfigurationDigest',
      'identity.executableCodeArtifactDigest'
    ]);
    expect(validateProjectionQueueRegistryManifest({ version: 1 })).toEqual(expect.arrayContaining([
      'manifestId', 'identity', 'identity.version', 'definitions', 'sourceStartAnchors'
    ]));
  });

  test('rejects malformed, unnormalized, empty, and duplicate source selectors', () => {
    const manifest = createManifest();
    const issues = validateProjectionQueueRegistryManifest({
      ...manifest,
      definitions: [
        { ...manifest.definitions[0], sourceSelectors: ['invoice', ' invoice ', '', 'invoice'] },
        { ...manifest.definitions[0], sourceSelectors: null }
      ]
    });
    expect(issues).toEqual(expect.arrayContaining([
      'definitions[0].sourceSelectors[1].normalized',
      'definitions[0].sourceSelectors[1].duplicate',
      'definitions[0].sourceSelectors[2]',
      'definitions[0].sourceSelectors[3].duplicate',
      'definitions[1].sourceSelectors',
      'definitions[1].duplicate'
    ]));
    expect(validateProjectionQueueRegistryManifest({
      ...manifest,
      definitions: [{ ...manifest.definitions[0], sourceSelectors: [] }]
    })).toContain('definitions[0].sourceSelectors.empty');
  });

  test('accepts sequence zero anchors and rejects unsafe source anchor records', () => {
    const manifest = createManifest();
    expect(validateProjectionQueueRegistryManifest(manifest)).toEqual([]);
    const uppercaseId = streamId.toUpperCase();
    const issues = validateProjectionQueueRegistryManifest({
      ...manifest,
      sourceStartAnchors: {
        [streamId]: 0,
        [uppercaseId]: -1,
        'not-a-uuid': Number.MAX_SAFE_INTEGER + 1
      }
    });
    expect(issues).toEqual(expect.arrayContaining([
      `sourceStartAnchors.${uppercaseId}.sourceId`,
      `sourceStartAnchors.${uppercaseId}.duplicate`,
      `sourceStartAnchors.${uppercaseId}.sequence`,
      'sourceStartAnchors.not-a-uuid.sourceId',
      'sourceStartAnchors.not-a-uuid.sequence'
    ]));
    expect(validateProjectionQueueRegistryManifest({ ...manifest, sourceStartAnchors: [] }))
      .toContain('sourceStartAnchors');
    expect(validateProjectionQueueRegistryManifest({
      ...manifest,
      sourceStartAnchors: Object.create({ inherited: 0 })
    })).toContain('sourceStartAnchors');
  });

  test.each([
    'normalizedDefinitionRegistryDigest',
    'normalizedRuntimeConfigurationDigest',
    'executableCodeArtifactDigest'
  ] as const)('rejects a binding with changed %s', (field) => {
    const manifest = createManifest();
    const matchingBinding: ProjectionQueueRegistryBinding = {
      queueId: manifest.queueId,
      manifestId: manifest.manifestId,
      registryGeneration: manifest.registryGeneration,
      identity: manifest.identity,
      boundAt: '2026-09-22T12:00:00.000Z'
    };
    expect(hasMatchingProjectionRegistryIdentity(manifest, matchingBinding)).toBe(true);
    expect(hasMatchingProjectionRegistryIdentity(manifest, {
      ...matchingBinding,
      identity: { ...matchingBinding.identity, [field]: `sha256:${'b'.repeat(64)}` }
    })).toBe(false);
  });
});

describe('atomic source commit store contract', () => {
  test('selects strategy-specific sequence-only progress', async () => {
    const sourceKey = projectionUuidToBase64Url22(streamId);
    const requests: CommitProjectionSourceCommitRequest[] = [
      {
        version: 1,
        mode: 'atomic-all',
        projectionName: 'summary',
        projectionGeneration: 'v1',
        commit: createCommit(),
        finalDocuments: [{ targetDocumentId: 'doc-1', expectedRevision: null, finalDocument: { total: 42 } }],
        stagedLinks: [],
        progress: {
          strategy: 'in_document',
          targets: [{ targetDocumentId: 'doc-1', expected: {}, final: { [sourceKey]: 0 } }]
        }
      },
      {
        version: 1,
        mode: 'atomic-all',
        projectionName: 'summary',
        projectionGeneration: 'v1',
        commit: createCommit(),
        finalDocuments: [],
        stagedLinks: [],
        progress: { strategy: 'own_record', source: { sourceId: streamId, expectedSequence: null, finalSequence: 0 } }
      },
      {
        version: 1,
        mode: 'atomic-all',
        projectionName: 'effects',
        projectionGeneration: 'v1',
        commit: createCommit(),
        finalDocuments: [],
        stagedLinks: [],
        progress: { strategy: 'none' }
      }
    ];
    const store: ProjectionSourceCommitStorePort = {
      async commitProjectionSourceCommit(request) {
        return {
          version: 1,
          status: 'committed',
          commitSequence: request.commit.commitSequence,
          documentRevisions: {},
          progress: request.progress
        };
      }
    };
    const results = await Promise.all(requests.map((request) => store.commitProjectionSourceCommit(request)));
    expect(results.map((result) => result.status)).toEqual(['committed', 'committed', 'committed']);
  });
});
