import { describe, expect, it } from '@jest/globals';
import { BSON, type Collection, ObjectId, UUID } from 'mongodb';
import type { ICommit } from 'tapeworm';
import { processSagaSourceEvent, type SagaTurnRepository, type SagaTurnStoredCommit } from '@redemeine/saga-runtime';
import { createCounters, createTurnTable, FakeTurnRepository, registrationOptions, sourceEvent } from '../../saga-runtime/test/fixtures/turn-processor.fixture';
import { IndexedSagaCommitReader, type SagaCommitPage } from '../src/IndexedSagaCommitReader';
import type { TapewormSagaEvent } from '../src/contracts';
import { storedCommitFromTapeworm, validateTapewormCommit } from '../src/validation';

const partition = 'sagas';
const stream = 'saga-1';
const index = { name: 'saga_index', unique: true, key: { streamId: 1, commitSequence: 1 } };

function row(sequence: number, payload: unknown = {}): ICommit<TapewormSagaEvent> {
  return {
    _id: new ObjectId(), token: new UUID('00000000-0000-0000-0000-000000000000'),
    isDispatched: false, createDateTime: new Date('2026-09-25T00:00:00Z'),
    id: `commit-${sequence}`, partitionId: partition, streamId: stream, commitSequence: sequence,
    sagaTurnIdentity: { sourceTriggerId: `source-${sequence}`, sagaKey: 'orders', instanceId: stream, routeId: 'route' },
    events: [{ id: `commit-${sequence}:event:0`, type: 'saga.instance_created.event', version: sequence, payload }]
  };
}

class Cursor {
  private direction = 1;
  max = Infinity;
  private filter: Record<string, unknown>;
  private readonly rows: ICommit<TapewormSagaEvent>[];
  closed = false;
  hintName: unknown;
  batch = 0;

  constructor(rows: ICommit<TapewormSagaEvent>[], filter: Record<string, unknown>) {
    this.rows = rows;
    this.filter = filter;
  }

  sort(spec: Record<string, number>) { this.direction = spec.commitSequence ?? 1; return this; }
  hint(value: unknown) { this.hintName = value; return this; }
  limit(value: number) { this.max = value; return this; }
  batchSize(value: number) { this.batch = value; return this; }
  private *matching() {
    const range = this.filter.commitSequence as { $gt: number; $lte: number } | undefined;
    const matches = this.rows.filter((value) => value.streamId === this.filter.streamId
      && (!range || value.commitSequence > range.$gt && value.commitSequence <= range.$lte));
    matches.sort((a, b) => this.direction * (a.commitSequence - b.commitSequence));
    yield* matches.slice(0, this.max);
  }
  async next() { return this.matching().next().value ?? null; }
  async *[Symbol.asyncIterator]() { yield* this.matching(); }
  async close() { this.closed = true; }
}

class FakeCollection {
  collectionName = `tw_${partition}_commits`;
  indexes: unknown[] = [index];
  rows: ICommit<TapewormSagaEvent>[] = [];
  cursors: Cursor[] = [];
  filters: Record<string, unknown>[] = [];
  listIndexes() { return { toArray: async () => this.indexes }; }
  find(filter: Record<string, unknown>) {
    this.filters.push(filter);
    const cursor = new Cursor(this.rows, filter);
    this.cursors.push(cursor);
    return cursor;
  }
  reader() { return new IndexedSagaCommitReader(this as unknown as Collection<ICommit<TapewormSagaEvent>>, partition); }
}

class LazyMillionCollection extends FakeCollection {
  generated = 0;
  override find(filter: Record<string, unknown>): Cursor {
    this.filters.push(filter);
    const self = this;
    const lazy = new class extends Cursor {
      override async next() { self.generated += 1; return row(999_999); }
      override async *[Symbol.asyncIterator]() {
        const range = filter.commitSequence as { $gt: number; $lte: number };
        for (let sequence = range.$gt + 1; sequence <= range.$lte && sequence <= range.$gt + this.max; sequence += 1) {
          self.generated += 1;
          yield row(sequence);
        }
      }
    }([], filter);
    this.cursors.push(lazy);
    return lazy;
  }
}

class LazyPhysicalBoundaryCollection extends FakeCollection {
  generated: number[] = [];

  constructor(private readonly first: SagaTurnStoredCommit) { super(); }

  private physical(sequence: number): ICommit<TapewormSagaEvent> {
    const id = sequence === 0 ? this.first.commitId : `later-${sequence}`;
    const pair = this.first.events.slice(2).map((event, position) => ({ ...event,
      version: 4 + (sequence - 1) * 2 + position }));
    const selected = sequence === 63 ? pair.slice(0, 1) : sequence === 64 ? pair.slice(1) : pair;
    const events = sequence === 0 ? this.first.events : selected.map((event, position) => ({ ...event,
      id: `${id}:event:${position}` }));
    return { ...row(sequence), id, streamId: this.first.streamId, sagaTurnIdentity: this.first.identity,
      events };
  }

  override find(filter: Record<string, unknown>): Cursor {
    this.filters.push(filter);
    const owner = this;
    const lazy = new class extends Cursor {
      override async next() { owner.generated.push(64); return owner.physical(64); }
      override async *[Symbol.asyncIterator]() {
        const range = filter.commitSequence as { $gt: number; $lte: number };
        for (let sequence = range.$gt + 1; sequence <= range.$lte && sequence <= range.$gt + this.max; sequence += 1) {
          owner.generated.push(sequence);
          yield owner.physical(sequence);
        }
      }
    }([], filter);
    this.cursors.push(lazy);
    return lazy;
  }
}

async function readAll(mongo: FakeCollection): Promise<SagaCommitPage[]> {
  const reader = mongo.reader();
  const high = await reader.capture(stream);
  const pages: SagaCommitPage[] = [];
  let after = -1;
  do {
    const page = await reader.page(stream, after, high);
    pages.push(page);
    after = page.afterSequence;
  } while (after < high);
  return pages;
}

describe('indexed Mongo saga complete-commit reader', () => {
  it('rejects a physical observation-only turn at the 64th commit before delivering the next-page state', async () => {
    const writer = new FakeTurnRepository();
    const table = createTurnTable('indexed-physical-boundary', createCounters());
    const source = sourceEvent();
    const options = registrationOptions(table);
    const [started] = await processSagaSourceEvent(table, writer, source, options);
    const instanceId = started!.instanceId;
    const first = (await (await writer.load(instanceId)).commits[Symbol.asyncIterator]().next()).value;
    if (!first) throw new Error('missing initial commit');
    const collection = new LazyPhysicalBoundaryCollection(first);
    const reader = collection.reader();
    let pages = 0;
    let firstPageSize = 0;
    let firstContinuation = -1;
    let stateOnlyDelivered = 0;
    let appendCalls = 0;
    const repository: SagaTurnRepository = {
      partitionId: partition,
      load: async () => {
        const high = await reader.capture(instanceId);
        return { streamId: instanceId, nextCommitSequence: high + 1, commits: (async function* () {
          let after = -1;
          let version = 0;
          while (after < high) {
            const page = await reader.page(instanceId, after, high);
            pages += 1;
            firstPageSize = page.commits.length;
            firstContinuation = page.afterSequence;
            for (const raw of page.commits) {
              const validated = validateTapewormCommit(raw, partition, instanceId, raw.commitSequence, version);
              version += validated.commit.events.length;
              if (raw.commitSequence === 64) stateOnlyDelivered += 1;
              yield storedCommitFromTapeworm(validated.commit);
            }
            after = page.afterSequence;
          }
        })() };
      },
      findCommit: async () => { throw new Error('Early duplicate lookup must not run'); },
      assertCommitMaterial: () => { throw new Error('Invalid history must not be reconciled'); },
      append: async () => { appendCalls += 1; throw new Error('Invalid history must not be appended'); }
    };
    await expect(processSagaSourceEvent(table, repository, source, options))
      .rejects.toMatchObject({ code: 'invalid_stored_event', retryable: false });
    expect({ pages, firstPageSize, firstContinuation, stateOnlyDelivered, appendCalls })
      .toEqual({ pages: 1, firstPageSize: 64, firstContinuation: 63, stateOnlyDelivered: 0, appendCalls: 0 });
    expect(collection.cursors).toHaveLength(2);
    expect(collection.cursors[1]?.max).toBe(65);
    expect(collection.cursors.every((cursor) => cursor.closed && cursor.hintName === index.name && cursor.batch === 1)).toBe(true);
    expect(collection.generated.filter((sequence) => sequence === 64)).toHaveLength(2);
  });
  it('refuses a mismatched namespace', () => {
    const mongo = new FakeCollection();
    mongo.collectionName = 'tw_elsewhere_commits';
    expect(() => mongo.reader()).toThrow('writable Tapeworm partition');
  });

  it.each([
    [], [{ ...index, unique: false }], [index, { ...index, name: 'duplicate' }],
    [{ ...index, expireAfterSeconds: 1 }], [{ ...index, hidden: true }],
    [{ ...index, sparse: true }], [{ ...index, partialFilterExpression: { streamId: stream } }],
    [{ ...index, collation: { locale: 'en' } }],
    [{ ...index, key: { commitSequence: 1, streamId: 1 } }]
  ].map((indexes) => ({ indexes })))('rejects missing or unusable indexed readiness (%j)', async ({ indexes }) => {
    const mongo = new FakeCollection();
    mongo.indexes = indexes;
    await expect(mongo.reader().capture(stream)).rejects.toThrow('Exactly one usable');
    expect(mongo.cursors).toHaveLength(0);
  });

  it('rechecks index readiness for every capture and page', async () => {
    const mongo = new FakeCollection();
    const reader = mongo.reader();
    expect(await reader.capture(stream)).toBe(-1);
    mongo.indexes = [];
    await expect(reader.page(stream, -1, -1)).rejects.toThrow('Exactly one usable');
  });

  it.each([0, 1, 64, 65])('uses hinted, limited, single-batch cursors and complete continuations for %i rows', async (count) => {
    const mongo = new FakeCollection();
    mongo.rows = Array.from({ length: count }, (_, index) => row(index));
    const pages = await readAll(mongo);
    expect(pages.flatMap((page) => page.commits).map((commit) => commit.commitSequence))
      .toEqual(Array.from({ length: count }, (_, index) => index));
    expect(mongo.cursors.every((cursor) => cursor.closed && cursor.hintName === index.name && cursor.batch === 1)).toBe(true);
    expect(mongo.cursors.map((cursor) => cursor.max)).toEqual(count === 65 ? [1, 65, 65] : [1, 65]);
    expect(mongo.filters[1]).toEqual({ streamId: stream, commitSequence: { $gt: -1, $lte: count - 1 } });
  });

  it('rejects gaps, foreign partitions, and malformed persisted envelope without retaining a page', async () => {
    for (const malformed of [row(1), { ...row(0), partitionId: 'other' }, { ...row(0), token: 'not-a-uuid' }]) {
      const mongo = new FakeCollection();
      mongo.rows = [malformed];
      const reader = mongo.reader();
      await expect(reader.page(stream, -1, 1)).rejects.toThrow();
      expect(mongo.cursors.at(-1)?.closed).toBe(true);
    }
  });

  it('captures the high watermark so later appends are excluded', async () => {
    const mongo = new FakeCollection();
    mongo.rows = [row(0)];
    const reader = mongo.reader();
    const high = await reader.capture(stream);
    mongo.rows.push(row(1));
    expect((await reader.page(stream, -1, high)).commits).toHaveLength(1);
  });

  it('reads a million-commit lazy generator at either boundary without materializing its history', async () => {
    const mongo = new LazyMillionCollection();
    const reader = mongo.reader();
    expect(await reader.capture(stream)).toBe(999_999);
    expect((await reader.page(stream, -1, 999_999)).commits).toHaveLength(64);
    const end = await reader.page(stream, 999_935, 999_999);
    expect(end.commits).toHaveLength(64);
    expect(end.afterSequence).toBe(999_999);
    expect(mongo.generated).toBeLessThan(135);
    expect(mongo.cursors.every((cursor) => cursor.closed)).toBe(true);
  });

  it('refuses oversized first commits and resumes when the next complete commit exceeds remaining page bytes', async () => {
    const mongo = new FakeCollection();
    const large = (sequence: number) => ({ ...row(sequence), events: Array.from({ length: 1 }, (_, position) => ({
      id: `commit-${sequence}:event:${position}`, type: 'saga.instance_created.event', version: sequence + position,
      payload: { text: 'a'.repeat(7 * 1024 * 1024) }
    })) });
    mongo.rows = [large(0), large(1)];
    expect(BSON.calculateObjectSize(mongo.rows[0])).toBeLessThan(12 * 1024 * 1024);
    const reader = mongo.reader();
    const first = await reader.page(stream, -1, 1);
    expect(first.commits).toHaveLength(1);
    expect(first.afterSequence).toBe(0);
    expect((await reader.page(stream, first.afterSequence, 1)).commits).toHaveLength(1);
    mongo.rows = [row(0, { text: 'x'.repeat(12 * 1024 * 1024) })];
    await expect(reader.page(stream, -1, 0)).rejects.toThrow('byte limit');
  });
});
