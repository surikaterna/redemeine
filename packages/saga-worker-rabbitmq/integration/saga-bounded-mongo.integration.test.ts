import { describe, expect, it, jest } from '@jest/globals';
import { createSaga } from '@redemeine/saga';
import { bindSagaRegistrations, compileSagaRoutes, createStartEventBindings, processSagaSourceEvent,
  registerSagaTurnDefinition, validateBusinessState, type SagaTurnSourceEvent } from '@redemeine/saga-runtime';
import { openMongoSagaTurnRepository } from '@redemeine/saga-runtime-store-tapeworm';
import { BSON, type Db, MongoClient, ObjectId, UUID } from 'mongodb';
import type { ICommit } from 'tapeworm';
import MongoPersistence from 'tapeworm_persistence_store_mongodb';
import { realOrders } from './fixtures';

const uri = process.env.REDEMEINE_MONGO_URL;
const largeBytes = 1_500_000;

function orderId(event: unknown): string {
  if (typeof event !== 'object' || event === null || !('payload' in event)) throw new Error('Missing saga event payload');
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null || !('orderId' in payload) || typeof payload.orderId !== 'string') {
    throw new Error('Missing order ID');
  }
  return payload.orderId;
}

function routes() {
  const definition = createSaga<unknown>({ identity: { namespace: 'bounded.mongo', name: 'large-state', version: 1 } })
    .initialState((): unknown => ({ blob: 'x'.repeat(largeBytes), count: 0 }))
    .start((_state, _input: unknown) => undefined)
    .correlateBy((input) => orderId({ payload: input }))
    .triggeredBy({ kind: 'domain', toStartInput: (event: { payload: { orderId: string } }) => event.payload })
    .correlate(realOrders, (event) => orderId(event))
    .on(realOrders, { paid: (state, event) => {
      if (typeof state !== 'object' || state === null || !('blob' in state) || typeof state.blob !== 'string'
        || !('count' in state) || typeof state.count !== 'number') throw new Error('Invalid saga state');
      state.blob = event.payload.mode === 'large' ? 'z'.repeat(8 * 1024 * 1024 - 256) : 'y'.repeat(largeBytes);
      state.count += 1;
    } })
    .build();
  const table = compileSagaRoutes([definition], createStartEventBindings({ definition,
    triggerIndex: 0, eventTypes: ['real.order-placed.v1.event'] }));
  const registrations = [definition].map((entry) => registerSagaTurnDefinition({ definition: entry,
    pluginManifests: [], responseHandlerBindings: {}, canonicalCommandTypes: [] }));
  return { table, options: { registrationForRoute: bindSagaRegistrations(table, registrations) } };
}

function source(id: string, type: string, mode?: 'large', metadata?: Readonly<Record<string, unknown>>): SagaTurnSourceEvent {
  return { partitionId: 'source', streamId: `source-${id}`, commitId: `source-${id}`,
    eventIndex: 0, eventId: id, type, payload: { orderId: 'order-large', ...(mode ? { mode } : {}) },
    createDateTime: '2026-09-25T00:00:00.000Z', ...(metadata ? { metadata } : {}) };
}

async function stored(db: Db, instanceId: string) {
  const result: ICommit[] = [];
  const cursor = db.collection<ICommit>('tw_sagas_commits').find({ streamId: instanceId })
    .sort({ commitSequence: 1 }).limit(3);
  try {
    for await (const row of cursor) result.push(row);
  } finally {
    await cursor.close();
  }
  return result;
}

async function removeTestDatabase(db: Db, client: MongoClient): Promise<void> {
  try {
    await db.dropDatabase();
    const remaining = (await db.admin().listDatabases({ nameOnly: true })).databases
      .some((entry) => entry.name === db.databaseName);
    if (remaining) throw new Error(`Saga test database ${db.databaseName} was not removed`);
    console.info(JSON.stringify({ mongoVersion: (await db.admin().serverInfo()).version,
      removedDatabase: db.databaseName }));
  } finally {
    await client.close();
  }
}

function measureProposedCommit(instanceId: string, sourceEvent: SagaTurnSourceEvent) {
  const businessState = { blob: 'z'.repeat(8 * 1024 * 1024 - 256), count: 2 };
  validateBusinessState(businessState);
  const identity = { sourceTriggerId: 'candidate-trigger', sagaKey: 'bounded.mongo.large-state',
    instanceId, routeId: 'paid-route' };
  const events = [
    { id: 'candidate:event:0', type: 'saga.source_event_observed.event', version: 6,
      payload: { record: { eventType: sourceEvent.type, observedAt: sourceEvent.createDateTime,
        payload: sourceEvent.payload, metadata: sourceEvent.metadata } } },
    { id: 'candidate:event:1', type: 'saga.business_state_recorded.event', version: 7,
      payload: { schemaVersion: 1, sagaKey: identity.sagaKey, definitionVersion: 1,
        state: businessState, recordedAt: sourceEvent.createDateTime } }
  ];
  const proposed = { id: 'candidate', partitionId: 'sagas', streamId: instanceId,
    commitSequence: 2, sagaTurnIdentity: identity, events, _id: new ObjectId(),
    token: new UUID('00000000-0000-0000-0000-000000000000'), isDispatched: false, createDateTime: new Date() };
  const eventBsonBytes = events.map((event) => BSON.calculateObjectSize(event));
  const proposedBsonBytes = BSON.calculateObjectSize(proposed);
  expect(eventBsonBytes.every((bytes) => bytes < 10 * 1024 * 1024)).toBe(true);
  expect(proposedBsonBytes).toBeGreaterThan(12 * 1024 * 1024);
  expect(proposedBsonBytes).toBeLessThan(16 * 1024 * 1024);
  return { businessStateJsonBytes: Buffer.byteLength(JSON.stringify(businessState)), eventBsonBytes, proposedBsonBytes };
}

async function rejectOversizedPhysicalTurn(db: Db, instanceId: string, context: ReturnType<typeof routes>, originalIds: string[]) {
  const sourceEvent = source('over-physical', 'real.order-paid.v1.event', 'large', { note: 'm'.repeat(4_700_000) });
  const measured = measureProposedCommit(instanceId, sourceEvent);
  const openPartition = MongoPersistence.prototype.openPartition;
  let realAppendCalls = 0;
  let instrumented = false;
  const openSpy = jest.spyOn(MongoPersistence.prototype, 'openPartition').mockImplementation(function (
    this: InstanceType<typeof MongoPersistence>, ...args: unknown[]
  ) {
    const partitionId = args[0];
    if (partitionId !== undefined && typeof partitionId !== 'string') throw new TypeError('Invalid partition ID');
    return openPartition.call(this, partitionId).then((partition: Awaited<ReturnType<InstanceType<typeof MongoPersistence>['openPartition']>>) => {
      instrumented = true;
      const append = partition.append.bind(partition);
      jest.spyOn(partition, 'append').mockImplementation((commit, callback) => {
        realAppendCalls += 1;
        return append(commit, callback);
      });
      return partition;
    });
  });
  try {
    const repository = await openMongoSagaTurnRepository(db, 'sagas');
    await expect(processSagaSourceEvent(context.table, repository, sourceEvent, context.options))
      .rejects.toMatchObject({ code: 'invalid_tapeworm_stream', retryable: false });
    expect(instrumented).toBe(true);
    expect(realAppendCalls).toBe(0);
  } finally {
    openSpy.mockRestore();
  }
  expect((await stored(db, instanceId)).map((row) => row.id)).toEqual(originalIds);
  console.info(JSON.stringify({ ...measured, realAppendCalls, originalCommitCount: originalIds.length }));
}

(uri ? describe : describe.skip)('real Mongo bounded saga processor', () => {
  it('persists large complete turns, replays after reopening, and refuses a physically oversized new turn', async () => {
    const client = new MongoClient(uri!);
    const db = client.db(`saga_7hd4_processor_${Date.now()}_${process.pid}`);
    try {
      await client.connect();
      const context = routes();
      const { table, options } = context;
      const repository = await openMongoSagaTurnRepository(db, 'sagas');
      const first = source('placed', 'real.order-placed.v1.event');
      const second = source('paid', 'real.order-paid.v1.event');
      const [created] = await processSagaSourceEvent(table, repository, first, options);
      const [updated] = await processSagaSourceEvent(table, repository, second, options);
      expect([created?.status, updated?.status]).toEqual(['committed', 'committed']);
      const instanceId = created!.instanceId;
      const rows = await stored(db, instanceId);
      expect(rows.map((row) => row.events.map(({ type }) => type))).toEqual([
        ['saga.instance_created.event', 'saga.definition_identity_recorded.event',
          'saga.source_event_observed.event', 'saga.business_state_recorded.event'],
        ['saga.source_event_observed.event', 'saga.business_state_recorded.event']
      ]);
      expect(rows.map((row) => row.events.map(({ version }) => version))).toEqual([[0, 1, 2, 3], [4, 5]]);
      expect(rows.map((row) => row.sagaTurnIdentity)).toEqual([
        expect.objectContaining({ instanceId, sourceTriggerId: expect.any(String), routeId: expect.any(String) }),
        expect.objectContaining({ instanceId, sourceTriggerId: expect.any(String), routeId: expect.any(String) })
      ]);
      expect(rows[0]?.events[1]?.payload).toMatchObject({ schemaVersion: 1, definitionVersion: 1,
        policySha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(rows[0]?.events[3]?.payload).toMatchObject({ state: { count: 0, blob: 'x'.repeat(largeBytes) } });
      expect(rows.every((row) => BSON.calculateObjectSize(row) < 12 * 1024 * 1024)).toBe(true);
      const reopened = await openMongoSagaTurnRepository(db, 'sagas');
      expect((await reopened.load(instanceId)).nextCommitSequence).toBe(2);
      expect(rows[1]?.events[1]?.payload).toMatchObject({ state: { count: 1, blob: 'y'.repeat(largeBytes) } });
      expect((await processSagaSourceEvent(table, reopened, first, options))[0]?.status).toBe('reconciled');
      expect((await processSagaSourceEvent(table, reopened, second, options))[0]?.status).toBe('reconciled');
      expect((await stored(db, instanceId)).map((row) => row.id)).toEqual(rows.map((row) => row.id));
      await rejectOversizedPhysicalTurn(db, instanceId, context, rows.map((row) => row.id));
    } finally {
      await removeTestDatabase(db, client);
    }
  }, 60_000);
});
