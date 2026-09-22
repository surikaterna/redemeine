import { describe, expect, test } from '@jest/globals';
import {
  isCompleteCommitRangeCapability,
  projectionBase64Url22ToUuid,
  projectionUuidToBase64Url22,
  validateCompleteCommitRange,
  validateProjectionSourceCommit
} from '../src';
import type {
  CommitProjectionSourceCommitRequest,
  ProjectionCompleteCommitRangeRequest,
  ProjectionSourceCheckpoint,
  ProjectionSourceCommit,
  ProjectionSourceCommitStorePort,
  ProjectionSourceOrderPort
} from '../src';

const streamId = '00112233-4455-6677-8899-aabbccddeeff';

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

  test('accepts complete contiguous ranges and rejects sliced boundaries', () => {
    const request: ProjectionCompleteCommitRangeRequest = {
      sourceId: streamId,
      afterSequence: null,
      throughSequence: 0
    };
    expect(validateCompleteCommitRange(request, {
      status: 'complete',
      commits: [createCommit(0)],
      hasMore: false
    }).valid).toBe(true);
    expect(validateCompleteCommitRange(request, {
      status: 'incomplete',
      reason: 'sliced_boundary',
      details: 'first event was sliced by the upstream query'
    })).toEqual({ valid: false, issues: ['sliced_boundary'] });
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
