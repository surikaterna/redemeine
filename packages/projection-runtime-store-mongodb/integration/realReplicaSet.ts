import { BSON, type ClientSession, type CommandFailedEvent, type CommandStartedEvent, MongoClient } from 'mongodb';
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
  progress: ProjectionSourceCommitProgress,
  stagedLinks: CommitProjectionSourceCommitRequest<TState>['stagedLinks'] = []
): CommitProjectionSourceCommitRequest<TState> => ({
  version: 1,
  mode: 'atomic-all',
  projectionName: name,
  projectionGeneration: 'v1',
  commit: commit(sequence),
  finalDocuments: documents,
  stagedLinks,
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

  let storeReconciliations = 0;
  let proxiedTransactionCount = 0;
  const unknownAfterCommitClient = {
    startSession: (): ClientSession => {
      const session = client.startSession();
      const withUnknownResult: ClientSession['withTransaction'] = async (work, options) => {
        proxiedTransactionCount += 1;
        const result = await session.withTransaction(work, options);
        if (proxiedTransactionCount === 1) return result;
        const unknown = new Error('injected final UnknownTransactionCommitResult') as Error & {
          hasErrorLabel(label: string): boolean;
        };
        unknown.hasErrorLabel = (label) => label === 'UnknownTransactionCommitResult';
        throw unknown;
      };
      return new Proxy(session, {
        get: (target, property) => {
          if (property === 'withTransaction') return withUnknownResult;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
  const reconcilingStore = new MongoProjectionStore({
    collection: documents,
    linkCollection: links,
    dedupeCollection: dedupe,
    mongoClient: unknownAfterCommitClient,
    onSourceCommitReconciliation: (event) => {
      if (event.outcome === 'committed') storeReconciliations += 1;
    }
  });
  await reconcilingStore.initializeProjectionSourceCommitStore();
  const reconciled = request(
    'store-reconciliation',
    0,
    [{ targetDocumentId: 'reconciled', expectedRevision: null, finalDocument: { value: 1 } }],
    { strategy: 'in_document', targets: [{ targetDocumentId: 'reconciled', expected: {}, final: { [encodedSource]: 0 } }] }
  );
  assert((await reconcilingStore.commitProjectionSourceCommit(reconciled)).status === 'committed', 'store reconciliation failed');
  assert(storeReconciliations === 1, 'store reconciliation path was not observed');

  const inlineBaseline = request(
    'oversized',
    0,
    [{ targetDocumentId: 'rollback-first', expectedRevision: null, finalDocument: { value: 1 } }],
    { strategy: 'in_document', targets: [{ targetDocumentId: 'rollback-first', expected: {}, final: { [encodedSource]: 0 } }] },
    [{ operation: 'subscribe', targetDocumentId: 'rollback-first', aggregateType: 'Order', aggregateId: 'rollback', expectedRevision: null }]
  );
  assert((await store.commitProjectionSourceCommit(inlineBaseline)).status === 'committed', 'inline baseline failed');
  const baselineDocument = await documents.findOne({ _id: 'rollback-first' });
  const baselineLink = await links.findOne({ aggregateId: 'rollback' });
  assert(Boolean(baselineDocument && baselineLink), 'inline capacity baseline incomplete');

  const oversizedPayloadBytes = 16 * 1024 * 1024 + 64 * 1024;
  const oversized = request(
    'oversized',
    1,
    [
      { targetDocumentId: 'rollback-first', expectedRevision: 1, finalDocument: { value: 2 } },
      { targetDocumentId: 'rollback-second', expectedRevision: null, finalDocument: { value: 2 } },
      { targetDocumentId: 'rollback-oversized', expectedRevision: null, finalDocument: { padding: 'x'.repeat(oversizedPayloadBytes) } }
    ],
    {
      strategy: 'in_document',
      targets: [
        { targetDocumentId: 'rollback-first', expected: { [encodedSource]: 0 }, final: { [encodedSource]: 1 } },
        { targetDocumentId: 'rollback-second', expected: {}, final: { [encodedSource]: 1 } },
        { targetDocumentId: 'rollback-oversized', expected: {}, final: { [encodedSource]: 1 } }
      ]
    },
    [{ operation: 'subscribe', targetDocumentId: 'rollback-second', aggregateType: 'Order', aggregateId: 'rollback', expectedRevision: 1 }]
  );
  let inlineServerCapacityFailures = 0;
  const capacityMonitor = (event: CommandFailedEvent): void => {
    const failure = event.failure as { code?: number };
    if (event.commandName === 'update' && failure.code === 10334) inlineServerCapacityFailures += 1;
  };
  client.on('commandFailed', capacityMonitor);
  const oversizedResult = await store.commitProjectionSourceCommit(oversized);
  client.off('commandFailed', capacityMonitor);
  assert(
    oversizedResult.status === 'rejected' && oversizedResult.category === 'terminal' && !oversizedResult.retryable,
    `oversized result was ${JSON.stringify(oversizedResult)}`
  );
  assert(inlineServerCapacityFailures === 1, 'inline capacity failure was not returned by MongoDB update command');
  assert(JSON.stringify(await documents.findOne({ _id: 'rollback-first' })) === JSON.stringify(baselineDocument), 'capacity rollback changed baseline target');
  assert(await documents.countDocuments({ _id: { $in: ['rollback-second', 'rollback-oversized'] } }) === 0, 'capacity rollback leaked a new target');
  assert(JSON.stringify(await links.findOne({ aggregateId: 'rollback' })) === JSON.stringify(baselineLink), 'capacity rollback changed baseline link');

  const ownBaseline = request(
    'oversized-own',
    0,
    [{ targetDocumentId: 'own-first', expectedRevision: null, finalDocument: { value: 1 } }],
    { strategy: 'own_record', source: { sourceId, expectedSequence: null, finalSequence: 0 } },
    [{ operation: 'subscribe', targetDocumentId: 'own-first', aggregateType: 'Order', aggregateId: 'own-rollback', expectedRevision: null }]
  );
  assert((await store.commitProjectionSourceCommit(ownBaseline)).status === 'committed', 'own baseline failed');
  const baselineOwnDocument = await documents.findOne({ _id: 'own-first' });
  const baselineOwnLink = await links.findOne({ aggregateId: 'own-rollback' });
  const baselineOwn = await dedupe.findOne({ projectionName: 'oversized-own' });
  assert(Boolean(baselineOwnDocument && baselineOwnLink && baselineOwn), 'own capacity baseline incomplete');
  const oversizedOwn = request(
    'oversized-own',
    1,
    [
      { targetDocumentId: 'own-first', expectedRevision: 1, finalDocument: { value: 2 } },
      { targetDocumentId: 'own-oversized', expectedRevision: null, finalDocument: { padding: 'x'.repeat(oversizedPayloadBytes) } }
    ],
    { strategy: 'own_record', source: { sourceId, expectedSequence: 0, finalSequence: 1 } },
    [{ operation: 'subscribe', targetDocumentId: 'own-oversized', aggregateType: 'Order', aggregateId: 'own-rollback', expectedRevision: 1 }]
  );
  let ownServerCapacityFailures = 0;
  const ownCapacityMonitor = (event: CommandFailedEvent): void => {
    const failure = event.failure as { code?: number };
    if (event.commandName === 'update' && failure.code === 10334) ownServerCapacityFailures += 1;
  };
  client.on('commandFailed', ownCapacityMonitor);
  const oversizedOwnResult = await store.commitProjectionSourceCommit(oversizedOwn);
  client.off('commandFailed', ownCapacityMonitor);
  assert(
    oversizedOwnResult.status === 'rejected' && oversizedOwnResult.category === 'terminal' && !oversizedOwnResult.retryable,
    `oversized own result was ${JSON.stringify(oversizedOwnResult)}`
  );
  assert(ownServerCapacityFailures === 1, 'own capacity failure was not returned by MongoDB update command');
  assert(JSON.stringify(await documents.findOne({ _id: 'own-first' })) === JSON.stringify(baselineOwnDocument), 'own rollback changed baseline target');
  assert(await documents.findOne({ _id: 'own-oversized' }) === null, 'own rollback leaked oversized target');
  assert(JSON.stringify(await links.findOne({ aggregateId: 'own-rollback' })) === JSON.stringify(baselineOwnLink), 'own rollback changed baseline link');
  assert(JSON.stringify(await dedupe.findOne({ projectionName: 'oversized-own' })) === JSON.stringify(baselineOwn), 'own rollback advanced scalar progress');

  const buildInfo = await db.admin().command({ buildInfo: 1 });
  const receipt = {
    databaseName,
    mongoVersion: buildInfo.version,
    driverVersion: process.env.npm_package_dependencies_mongodb ?? '6.18.0',
    ownIndex: OWN_PROGRESS_INDEX,
    belowLimitBsonBytes: BSON.calculateObjectSize((await documents.findOne({ _id: 'below' })) ?? {}),
    attemptedOversizedPayloadBytes: oversizedPayloadBytes,
    capacityResult: oversizedResult.status,
    inlineServerCapacityFailures,
    ownCapacityResult: oversizedOwnResult.status,
    ownServerCapacityFailures,
    driverUnknownCommitRetries: commitTransactionFailures,
    storeReconciliations,
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
