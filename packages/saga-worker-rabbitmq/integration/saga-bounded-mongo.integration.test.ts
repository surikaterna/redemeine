import { describe, expect, it } from '@jest/globals';
import { createSaga } from '@redemeine/saga';
import { bindSagaRegistrations, compileSagaRoutes, createStartEventBindings, processSagaSourceEvent,
  registerSagaTurnDefinition, type SagaTurnSourceEvent } from '@redemeine/saga-runtime';
import { openMongoSagaTurnRepository } from '@redemeine/saga-runtime-store-tapeworm';
import { BSON, type Db, MongoClient } from 'mongodb';
import type { ICommit } from 'tapeworm';
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
  const registrations = table.definitions.map((entry) => registerSagaTurnDefinition({ definition: entry,
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

(uri ? describe : describe.skip)('real Mongo bounded saga processor', () => {
  it('persists large complete turns, replays after reopening, and refuses a physically oversized new turn', async () => {
    const client = new MongoClient(uri!);
    const db = client.db(`saga_7hd4_processor_${Date.now()}_${process.pid}`);
    try {
      await client.connect();
      const { table, options } = routes();
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
      const overPhysical = source('over-physical', 'real.order-paid.v1.event', 'large', { note: 'm'.repeat(4_700_000) });
      await expect(processSagaSourceEvent(table, reopened, overPhysical, options))
        .rejects.toMatchObject({ code: 'invalid_tapeworm_stream', retryable: false });
      expect((await stored(db, instanceId)).map((row) => row.id)).toEqual(rows.map((row) => row.id));
    } finally {
      await db.dropDatabase().catch(() => undefined);
      await client.close();
    }
  }, 60_000);
});
