import { randomUUID } from 'node:crypto';
import EventStore, { Event, EventStorePartition, EventStream, type IBaseEvent, type IPersistenceProvider, type IPersistencePartition } from 'tapeworm';
import MongoPersistence from 'tapeworm_persistence_store_mongodb';
import { Db, ReadConcern, type MongoClient, type CollectionOptions, type Document, type Collection } from 'mongodb';
import { budgets, partitionId, sourceCollection } from './plan';
import { assert, integer, record } from './schema';

export type SourceLabel = 'primary' | 'new' | 'unseen' | 'probe';
export interface EventInput { amount: number; type?: 'Added' | 'Ignored'; target?: 'shared' | 'none' }
type Partition = InstanceType<typeof EventStorePartition>;
type Stream = InstanceType<typeof EventStream>;
type MongoPartition = NonNullable<ReturnType<InstanceType<typeof MongoPersistence>['_getPartition']>>;

/** Fixed qualification mapping; the actual persistence package still creates indexes and appends commits. */
export class FixtureDb extends Db {
  override collection<T extends Document = Document>(name: string, options?: CollectionOptions): Collection<T> {
    return super.collection<T>(name === `tw_${partitionId}_commits` ? sourceCollection : name, options);
  }
}

export function fixtureEvent(input: EventInput): IBaseEvent {
  assert(Number.isSafeInteger(input.amount) && input.amount >= 0, 'invalid_fixture_amount');
  const event = new Event(randomUUID(), input.type ?? 'Added', { target: input.target ?? 'shared', amount: input.amount });
  return { ...event, timestamp: '2026-09-30T00:00:00.000Z', aggregateType: 'ModelCounter', aggregateId: 'fixture' };
}

function appendPersistence(db: Db): IPersistenceProvider {
  const persistence = new MongoPersistence(db);
  // Legacy optional snapshot declarations differ; this fixed fixture forwards only the append/query surface it uses.
  return { openPartition: (partition) => persistence.openPartition(partition).then((store: MongoPartition) => ({
    append: (commit, callback) => store.append(commit, callback),
    getLatestCommit: (id, callback) => store.getLatestCommit(id, callback),
    queryAll: (callback) => store.queryAll(callback),
    queryStream: (id, sequence, callback) => {
      if (sequence !== undefined && typeof sequence !== 'number') throw new Error('unused_legacy_callback_form');
      return store.queryStream(id, sequence, callback);
    },
    getUndispatched: (callback) => store.getUndispatched(callback),
    markAsDispatched: (commit, callback) => store.markAsDispatched(commit, callback)
  } satisfies IPersistencePartition)) };
}

export class SourceFixtures {
  private readonly streams = new Map<string, Stream>();
  committed = 0;
  private constructor(readonly db: Db, private readonly partition: Partition, private readonly signal: AbortSignal) {}

  static async open(client: MongoClient, database: string, signal: AbortSignal): Promise<SourceFixtures> {
    assert(!signal.aborted, 'qualification_stopping');
    const db = new FixtureDb(client, database, { readConcern: new ReadConcern('majority'), writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const store = new EventStore(appendPersistence(db));
    const partition: unknown = await store.openPartition(partitionId);
    if (!(partition instanceof EventStorePartition)) throw new Error('unexpected_fixture_partition');
    return new SourceFixtures(db, partition, signal);
  }

  source(label: SourceLabel): string {
    const suffix = { primary: 1, new: 2, unseen: 3, probe: 4 }[label];
    return `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  }

  async append(label: SourceLabel, events: readonly EventInput[]) { return this.appendId(this.source(label), events); }

  private async appendId(sourceId: string, events: readonly EventInput[]) {
    assert(this.committed < 1024 && events.length > 0 && events.length <= 10, 'fixture_capacity');
    assert(!this.signal.aborted, 'qualification_stopping');
    let stream = this.streams.get(sourceId);
    if (!stream) {
      const opened: unknown = await this.partition.openStream(sourceId, true);
      if (!(opened instanceof EventStream)) throw new Error('unexpected_fixture_stream');
      stream = opened; this.streams.set(sourceId, stream);
    }
    for (const event of events) stream.append(fixtureEvent(event));
    assert(!this.signal.aborted, 'qualification_stopping');
    const commitId = randomUUID(); await stream.commit(commitId); this.committed += 1;
    const row = await this.db.collection<{ id: string; streamId: string; commitSequence: number }>(sourceCollection).findOne({ id: commitId });
    assert(row !== null, 'append_not_persisted'); if (!row) throw new Error('append_not_persisted');
    return { commitId, sourceId, sequence: integer(row.commitSequence) };
  }

  async seed(): Promise<void> {
    for (let sequence = 0; sequence < 42; sequence += 1) {
      const commit = await this.append('primary', [{ type: 'Ignored', target: 'none', amount: 1000 }]);
      assert(commit.sequence === sequence, 'fixture_sequence_mismatch');
    }
    for (let index = 0; index < budgets.inactiveSources; index += 1) {
      const source = `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`;
      await this.appendId(source, [{ type: 'Ignored', target: 'none', amount: 1000 }]);
    }
  }

  async observeConsumerQueries(appName: string) {
    const rows = await this.db.collection<{ appName: string; command: unknown }>('system.profile').find({ appName, 'command.find': sourceCollection }).limit(512).toArray();
    assert(rows.length < 512, 'query_receipt_capacity');
    let primaryRangeReads = 0;
    for (const row of rows) {
      const filter = record(record(row.command).filter);
      assert(typeof filter.streamId === 'string' && filter.commitSequence !== undefined, 'consumer_source_inventory_query');
      if (filter.streamId !== this.source('primary')) continue;
      primaryRangeReads += 1;
      const range = record(filter.commitSequence);
      assert(typeof range.$gt === 'number' && range.$gt >= 41, 'consumer_prefix_read');
    }
    return { observedSourceFinds: rows.length, primaryRangeReads, actualInactiveSources: budgets.inactiveSources,
      datasetConstructionIsSeparate: true, millionSourceEvidence: 'not_run' };
  }
}
