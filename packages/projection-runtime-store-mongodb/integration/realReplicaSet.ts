import { BSON, type CommandFailedEvent, type CommandStartedEvent, MongoClient } from 'mongodb';
import type {
  CommitProjectionSourceCommitRequest,
  ProjectionSourceCommitProgress,
  ProjectionUuidBase64Url22
} from '@redemeine/projection-runtime-core';
import {
  MongoProjectionStore,
  OWN_PROGRESS_INDEX,
  type ProjectionDedupeRecord,
  type ProjectionDocumentRecord,
  type ProjectionLinkRecord
} from '../src';

const uri = process.env.REDEMEINE_MONGO_URI;
if (!uri) throw new Error('REDEMEINE_MONGO_URI is required');

const databaseName = `redemeine_projection_v2_${Date.now()}`;
const client = new MongoClient(uri, { monitorCommands: true });
const sourceId = '00000000-0000-4000-8000-000000000001';
const encodedSource = 'AAAAAAAAQACAAAAAAAAAAQ' as ProjectionUuidBase64Url22;

const commit = (sequence: number) => ({
  streamId: sourceId,
  commitId: `00000000-0000-4000-8000-${String(sequence + 2).padStart(12, '0')}`,
  commitSequence: sequence,
  events: [{
    eventId: `00000000-0000-4000-8000-${String(sequence + 3).padStart(12, '0')}`,
    eventIndex: 0,
    streamVersion: sequence,
    aggregateType: 'Order',
    aggregateId: 'one',
    type: 'Changed',
    payload: {},
    timestamp: '2026-09-22T00:00:00.000Z'
  }] as const
});

const request = <TState>(
  name: string,
  sequence: number,
  documents: CommitProjectionSourceCommitRequest<TState>['finalDocuments'],
  progress: ProjectionSourceCommitProgress
): CommitProjectionSourceCommitRequest<TState> => ({
  version: 1,
  mode: 'atomic-all',
  projectionName: name,
  projectionGeneration: 'v1',
  commit: commit(sequence),
  finalDocuments: documents,
  stagedLinks: [],
  progress
});

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const run = async (): Promise<void> => {
  await client.connect();
  const db = client.db(databaseName);
  const documents = db.collection<ProjectionDocumentRecord<unknown>>('documents');
  const links = db.collection<ProjectionLinkRecord>('links');
  const dedupe = db.collection<ProjectionDedupeRecord>('dedupe');
  const store = new MongoProjectionStore({ collection: documents, linkCollection: links, dedupeCollection: dedupe, mongoClient: client });

  await store.initializeProjectionSourceCommitStore();
  const ownIndex = (await dedupe.listIndexes().toArray()).find((index) => index.name === OWN_PROGRESS_INDEX);
  assert(ownIndex?.unique === true && ownIndex.expireAfterSeconds === undefined, 'own-record index readiness failed');

  const sequenceZero = request(
    'inline-seq0',
    0,
    [
      { targetDocumentId: 'seq0-a', expectedRevision: null, finalDocument: { value: 1 } },
      { targetDocumentId: 'seq0-b', expectedRevision: null, finalDocument: { value: 2 } }
    ],
    {
      strategy: 'in_document',
      targets: [
        { targetDocumentId: 'seq0-a', expected: {}, final: { [encodedSource]: 0 } },
        { targetDocumentId: 'seq0-b', expected: {}, final: { [encodedSource]: 0 } }
      ]
    }
  );
  assert((await store.commitProjectionSourceCommit(sequenceZero)).status === 'committed', 'sequence zero failed');

  const own = request('own-no-target', 0, [], {
    strategy: 'own_record',
    source: { sourceId, expectedSequence: null, finalSequence: 0 }
  });
  assert((await store.commitProjectionSourceCommit(own)).status === 'committed', 'own-record no-target failed');

  let noneDedupeOperations = 0;
  const monitor = (event: CommandStartedEvent): void => {
    if (event.databaseName === databaseName && event.command[`${event.commandName}`] === 'dedupe') noneDedupeOperations += 1;
  };
  client.on('commandStarted', monitor);
  const none = request('none', 0, [], { strategy: 'none' });
  assert((await store.commitProjectionSourceCommit(none)).status === 'committed', 'none failed');
  client.off('commandStarted', monitor);
  assert(noneDedupeOperations === 0, `none used dedupe collection ${noneDedupeOperations} times`);

  const belowLimit = request(
    'below-limit',
    0,
    [{ targetDocumentId: 'below', expectedRevision: null, finalDocument: { padding: 'x'.repeat(1024 * 1024) } }],
    { strategy: 'in_document', targets: [{ targetDocumentId: 'below', expected: {}, final: { [encodedSource]: 0 } }] }
  );
  assert((await store.commitProjectionSourceCommit(belowLimit)).status === 'committed', 'below-limit document failed');

  let commitTransactionFailures = 0;
  const failedCommitMonitor = (event: CommandFailedEvent): void => {
    if (event.commandName === 'commitTransaction') commitTransactionFailures += 1;
  };
  client.on('commandFailed', failedCommitMonitor);
  await db.admin().command({
    configureFailPoint: 'failCommand',
    mode: { times: 1 },
    data: { failCommands: ['commitTransaction'], closeConnection: true }
  });
  const unknownOutcome = request(
    'unknown-outcome',
    0,
    [{ targetDocumentId: 'unknown', expectedRevision: null, finalDocument: { value: 1 } }],
    { strategy: 'in_document', targets: [{ targetDocumentId: 'unknown', expected: {}, final: { [encodedSource]: 0 } }] }
  );
  assert((await store.commitProjectionSourceCommit(unknownOutcome)).status === 'committed', 'unknown commit result was not reconciled');
  client.off('commandFailed', failedCommitMonitor);
  assert(commitTransactionFailures > 0, 'unknown commit result failpoint did not execute');

  const oversized = request(
    'oversized',
    0,
    [
      { targetDocumentId: 'rollback-first', expectedRevision: null, finalDocument: { value: 1 } },
      { targetDocumentId: 'rollback-oversized', expectedRevision: null, finalDocument: { padding: 'x'.repeat(17 * 1024 * 1024) } }
    ],
    {
      strategy: 'in_document',
      targets: [
        { targetDocumentId: 'rollback-first', expected: {}, final: { [encodedSource]: 0 } },
        { targetDocumentId: 'rollback-oversized', expected: {}, final: { [encodedSource]: 0 } }
      ]
    }
  );
  const oversizedResult = await store.commitProjectionSourceCommit(oversized);
  assert(
    oversizedResult.status === 'rejected' && oversizedResult.category === 'terminal' && !oversizedResult.retryable,
    `oversized result was ${JSON.stringify(oversizedResult)}`
  );
  assert(await documents.countDocuments({ _id: { $in: ['rollback-first', 'rollback-oversized'] } }) === 0, 'capacity rollback leaked a target');

  const buildInfo = await db.admin().command({ buildInfo: 1 });
  const receipt = {
    databaseName,
    mongoVersion: buildInfo.version,
    driverVersion: process.env.npm_package_dependencies_mongodb ?? '6.18.0',
    ownIndex: OWN_PROGRESS_INDEX,
    belowLimitBsonBytes: BSON.calculateObjectSize((await documents.findOne({ _id: 'below' })) ?? {}),
    attemptedOversizedPayloadBytes: 17 * 1024 * 1024,
    capacityResult: oversizedResult.status,
    unknownCommitTransactionFailures: commitTransactionFailures,
    noneDedupeOperations,
    cleanup: 'pending'
  };
  await db.dropDatabase();
  console.log(JSON.stringify({ ...receipt, cleanup: 'database-dropped' }));
};

try {
  await run();
} finally {
  await client.close();
}
