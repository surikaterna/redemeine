import { describe, expect, it } from '@jest/globals';
import { type Collection, ObjectId, UUID } from 'mongodb';
import type { ICommit } from 'tapeworm';
import { IndexedSagaCommitReader, SAGA_PAGE_COMMITS } from '../src/IndexedSagaCommitReader';
import type { TapewormSagaEvent } from '../src/contracts';

const total = process.env.SAGA_MILLION_STRESS === '1' ? 1_000_000 : 4_096;
const streamId = 'stress-instance';
const partitionId = 'sagas';

function row(sequence: number): ICommit<TapewormSagaEvent> {
  const id = `commit-${sequence}`;
  return {
    _id: new ObjectId(), token: new UUID('00000000-0000-0000-0000-000000000000'),
    isDispatched: false, createDateTime: new Date('2026-09-25T00:00:00Z'),
    id, partitionId, streamId, commitSequence: sequence,
    sagaTurnIdentity: { sourceTriggerId: id, sagaKey: 'orders', instanceId: streamId, routeId: 'route' },
    events: [{ id: `${id}:event:0`, type: 'saga.instance_created.event', version: sequence, payload: {} }]
  };
}

class LazyCollection {
  readonly collectionName = 'tw_sagas_commits';
  generated = 0;
  live = 0;
  peakLive = 0;
  open = 0;
  peakOpen = 0;
  metadata = 0;

  listIndexes() {
    this.metadata = 1;
    return { toArray: async () => [{ name: 'ordered', unique: true, key: { streamId: 1, commitSequence: 1 } }] };
  }

  find(filter: { streamId: string; commitSequence?: { $gt: number; $lte: number } }) {
    const owner = this;
    let direction = 1;
    let limit = Infinity;
    let closed = false;
    let next = filter.commitSequence?.$gt ?? total - 1;
    this.open += 1;
    this.peakOpen = Math.max(this.peakOpen, this.open);
    const cursor = {
      sort(spec: { commitSequence: number }) { direction = spec.commitSequence; return this; },
      hint(_name: string) { return this; },
      limit(value: number) { limit = value; return this; },
      batchSize(_value: number) { return this; },
      async next() { return owner.make(total - 1); },
      async *[Symbol.asyncIterator]() {
        if (direction !== 1) throw new Error('page must be ascending');
        let yielded = 0;
        while (yielded < limit && next + 1 <= (filter.commitSequence?.$lte ?? -1)) {
          next += 1;
          yielded += 1;
          yield owner.make(next);
        }
      },
      async close() {
        if (!closed) { closed = true; owner.open -= 1; }
      }
    };
    return cursor;
  }

  private make(sequence: number) {
    this.generated += 1;
    this.live += 1;
    this.peakLive = Math.max(this.peakLive, this.live);
    return row(sequence);
  }

  release(count: number) { this.live -= count; }
}

describe('lazy sequential indexed saga fold', () => {
  it(`folds ${total} generated commits with bounded retained pages and metadata`, async () => {
    const collection = new LazyCollection();
    const reader = new IndexedSagaCommitReader(collection as unknown as Collection<ICommit<TapewormSagaEvent>>, partitionId);
    const start = performance.now();
    const high = await reader.capture(streamId);
    collection.release(1);
    let after = -1;
    let folded = 0;
    let peakPage = 0;
    while (after < high) {
      const page = await reader.page(streamId, after, high);
      peakPage = Math.max(peakPage, page.commits.length);
      for (const commit of page.commits) {
        if (commit.commitSequence !== folded) throw new Error(`Nonsequential fold at ${folded}`);
        folded += 1;
      }
      collection.release(page.commits.length + (page.afterSequence < high ? 1 : 0));
      after = page.afterSequence;
    }
    const elapsedMs = Math.round(performance.now() - start);
    console.info(JSON.stringify({ total, folded, generated: collection.generated, peakPage,
      peakLive: collection.peakLive, peakOpen: collection.peakOpen, metadata: collection.metadata, elapsedMs }));
    expect(folded).toBe(total);
    expect(peakPage).toBeLessThanOrEqual(SAGA_PAGE_COMMITS);
    expect(collection.peakLive).toBeLessThanOrEqual(SAGA_PAGE_COMMITS + 1);
    expect(collection.open).toBe(0);
    expect(collection.live).toBe(0);
    expect(collection.metadata).toBe(1);
  }, process.env.SAGA_MILLION_STRESS === '1' ? 600_000 : 30_000);
});
