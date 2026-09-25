import { describe, expect, it } from '@jest/globals';
import { assertSagaTurnPreappendBudget, type SagaTurnAppendRequest, SagaTurnIntegrityError } from '@redemeine/saga-runtime';
import Bluebird from 'bluebird';
import { ConcurrencyError, DuplicateCommitError, type ICommit, type IPersistencePartition, type NodeCallback } from 'tapeworm';
import { createTapewormSagaTurnRepository, type TapewormSagaEvent } from '../src/index';
import { assertSagaCommitBudget, type SagaCommitReader } from '../src/IndexedSagaCommitReader';
import { BSON, ObjectId, UUID } from 'mongodb';

function request(overrides: Partial<SagaTurnAppendRequest> = {}): SagaTurnAppendRequest {
  return {
    streamId: 'saga-1',
    commitId: 'turn-1',
    expectedNextCommitSequence: 0,
    identity: { sourceTriggerId: 'trigger-1', sagaKey: 'orders', instanceId: 'saga-1', routeId: 'route-1' },
    events: [
      { type: 'saga.instance_created.event', payload: { id: 'saga-1' } },
      { type: 'saga.business_state_recorded.event', payload: { state: { count: 1 } } }
    ],
    ...overrides
  };
}

type AppendFailure = Error | { readonly error: Error; readonly afterWrite: boolean };

class FakeTapewormPartition implements IPersistencePartition<TapewormSagaEvent> {
  readonly commits: ICommit<TapewormSagaEvent>[] = [];
  queryAllCalls = 0;
  appendCalls = 0;
  appendFailure?: AppendFailure;
  afterWrite?: (commit: ICommit<TapewormSagaEvent>) => ICommit<TapewormSagaEvent>;

  append(commit: ICommit<TapewormSagaEvent>, callback?: NodeCallback<ICommit<TapewormSagaEvent>>) {
    this.appendCalls += 1;
    const failure = this.appendFailure;
    this.appendFailure = undefined;
    if (failure) {
      if (!(failure instanceof Error) && failure.afterWrite) this.commits.push(this.afterWrite?.(commit) ?? commit);
      const error = failure instanceof Error ? failure : failure.error;
      return Bluebird.reject<ICommit<TapewormSagaEvent>>(error).nodeify(callback);
    }
    this.commits.push(commit);
    return Bluebird.resolve(commit).nodeify(callback);
  }

  queryAll(callback?: NodeCallback<ICommit<TapewormSagaEvent>[]>) {
    this.queryAllCalls += 1;
    return Bluebird.reject<ICommit<TapewormSagaEvent>[]>(new Error('queryAll must not be called')).nodeify(callback);
  }

  queryStream(streamId: string, from?: number | NodeCallback<ICommit<TapewormSagaEvent>[]>, callback?: NodeCallback<ICommit<TapewormSagaEvent>[]>) {
    const cb = typeof from === 'function' ? from : callback;
    return Bluebird.resolve(this.commits.filter((commit) => commit.streamId === streamId)).nodeify(cb);
  }

  getUndispatched(callback?: NodeCallback<ICommit<TapewormSagaEvent>[]>) {
    return Bluebird.resolve([]).nodeify(callback);
  }

  markAsDispatched(commit: ICommit<TapewormSagaEvent>, callback?: NodeCallback<ICommit<TapewormSagaEvent>>) {
    return Bluebird.resolve(commit).nodeify(callback);
  }
}

function repository(partition: FakeTapewormPartition) {
  const reader: SagaCommitReader = {
    capture: async (streamId) => partition.commits.filter((row) => row.streamId === streamId)
      .reduce((high, row) => Math.max(high, row.commitSequence), -1),
    page: async (streamId, afterSequence, highWatermark) => {
      const commits = partition.commits.filter((row) => row.streamId === streamId
        && row.commitSequence > afterSequence && row.commitSequence <= highWatermark)
        .sort((a, b) => a.commitSequence - b.commitSequence).slice(0, 64);
      for (const row of commits) assertSagaCommitBudget(row);
      return { commits, afterSequence: commits.at(-1)?.commitSequence ?? afterSequence, highWatermark };
    }
  };
  return createTapewormSagaTurnRepository({ partition, partitionId: 'sagas', reader });
}

describe('Tapeworm saga turn repository', () => {
  it('uses indexed pages/append contracts and starts commit and event sequences at zero', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    const empty = await target.load('saga-1');
    expect(empty.nextCommitSequence).toBe(0);
    for await (const _commit of empty.commits) throw new Error('empty saga has commits');
    expect(await target.append(request())).toEqual({ status: 'committed', commitSequence: 0 });
    expect(partition.commits).toHaveLength(1);
    expect(partition.commits[0]).toMatchObject({ id: 'turn-1', partitionId: 'sagas', streamId: 'saga-1', commitSequence: 0 });
    expect(partition.commits[0]?.events.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: 'turn-1:event:0', version: 0 },
      { id: 'turn-1:event:1', version: 1 }
    ]);
    const loaded = await target.load('saga-1');
    expect(loaded.nextCommitSequence).toBe(1);
    const rows = [];
    for await (const commit of loaded.commits) rows.push(commit);
    expect(rows[0]?.events).toHaveLength(2);
    expect(partition.queryAllCalls).toBe(0);
  });

  it('continues commit and event versions contiguously', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    await target.append(request());
    await target.append(request({ commitId: 'turn-2', expectedNextCommitSequence: 1, events: [{ type: 'saga.source_event_observed.event', payload: {} }] }));
    expect(partition.commits[1]?.commitSequence).toBe(1);
    expect(partition.commits[1]?.events[0]?.version).toBe(2);
  });

  it('refuses oversized append event counts and bytes before any read or write', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    await expect(target.append(request({ events: Array.from({ length: 257 }, () => request().events[0]!) })))
      .rejects.toThrow('event count');
    await expect(target.append(request({ events: [{ type: 'saga.instance_created.event', payload: { text: 'x'.repeat(10 * 1024 * 1024) } }] })))
      .rejects.toThrow('byte limit');
    expect(partition.appendCalls).toBe(0);
  });

  it('shares the exact projected physical envelope, 256 boundary and event limits with the runtime precheck', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    const valid = request({ events: Array.from({ length: 256 }, () => request().events[0]!) });
    const bytes = assertSagaTurnPreappendBudget(valid, target.partitionId, 0);
    await target.append(valid);
    const committed = partition.commits[0]!;
    expect(assertSagaCommitBudget({ ...committed, _id: new ObjectId(),
      token: new UUID('00000000-0000-0000-0000-000000000000'), isDispatched: false, createDateTime: new Date() }))
      .toBe(bytes);
    expect(committed.events).toHaveLength(256);
    const tooMany = request({ commitId: 'too-many', expectedNextCommitSequence: 1,
      events: [...valid.events, valid.events[0]!] });
    expect(() => assertSagaTurnPreappendBudget(tooMany, target.partitionId, 256)).toThrow('256');
    await expect(target.append(tooMany)).rejects.toThrow('event count');
    const large = request({ commitId: 'too-large', expectedNextCommitSequence: 1,
      events: [{ type: 'saga.source_event_observed.event', payload: { blob: 'x'.repeat(9 * 1024 * 1024) },
        metadata: { blob: 'y'.repeat(2 * 1024 * 1024) } }] });
    expect(() => assertSagaTurnPreappendBudget(large, target.partitionId, 256)).toThrow('event exceeds');
    await expect(target.append(large)).rejects.toThrow('byte limit');
    expect(partition.appendCalls).toBe(1);
    expect(BSON.calculateObjectSize(committed.events[0]!)).toBeLessThan(10 * 1024 * 1024);
  });

  it('rejects an oversized individual intent before append without capping the state at 64 KiB', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    const intents = (size: number) => request({ events: [
      { type: 'saga.business_state_recorded.event', payload: { state: { blob: 's'.repeat(70000) } } },
      { type: 'saga.intent_recorded.event', payload: { schemaVersion: 1, intent: { payload: 'x'.repeat(size - 14) } } }
    ] });
    expect(Buffer.byteLength(JSON.stringify((intents(65536).events[1]!.payload as { intent: unknown }).intent))).toBe(65536);
    await expect(target.append(intents(65536))).resolves.toMatchObject({ status: 'committed' });
    await expect(target.append({ ...intents(65537), commitId: 'turn-2', expectedNextCommitSequence: 1 })).rejects.toThrow('64 KiB');
    expect(partition.appendCalls).toBe(1);
  });

  it('persists and replays one complete 1.5 MiB business-state event', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    const state = { blob: 'x'.repeat(1_500_000) };
    const initial = request({ events: [{ type: 'saga.business_state_recorded.event', payload: { state } }] });
    expect(await target.append(initial)).toMatchObject({ status: 'committed' });
    const snapshot = await target.load('saga-1');
    const rows = [];
    for await (const commit of snapshot.commits) rows.push(commit);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.events[0]?.payload).toEqual({ state });
    expect(await target.append(initial)).toMatchObject({ status: 'reconciled' });
    expect(partition.appendCalls).toBe(1);
  });

  it('refuses a physical commit over 12 MiB even when each JSON-safe event is under its limit', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    const events = ['a', 'b'].map((character) => ({ type: 'saga.business_state_recorded.event',
      payload: { state: { blob: character.repeat(7 * 1024 * 1024) } } }));
    await expect(target.append(request({ events }))).rejects.toThrow('complete commit exceeds');
    expect(partition.appendCalls).toBe(0);
  });

  it('reconciles an equivalent duplicate through expected-stream readback without queryAll', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    await target.append(request());
    partition.appendFailure = new DuplicateCommitError('duplicate');
    const duplicate = await target.append(request({ expectedNextCommitSequence: 1 }));
    expect(duplicate).toMatchObject({ status: 'reconciled', commit: { commitId: 'turn-1' } });
    expect(partition.queryAllCalls).toBe(0);
  });

  it('reconciles ambiguous success through expected-stream readback without queryAll', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    partition.appendFailure = { error: new Error('network timeout'), afterWrite: true };
    const ambiguous = await target.append(request());
    expect(ambiguous).toMatchObject({ status: 'reconciled', commit: { commitId: 'turn-1' } });
    expect(partition.queryAllCalls).toBe(0);
  });

  it('refuses same-ID requests whose ordered content, headers, or metadata differ', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    await target.append(request());
    const mutations: SagaTurnAppendRequest['events'][] = [
      request().events.slice(0, 1),
      [{ type: 'saga.instance_created.event', payload: { id: 'other' } }, request().events[1]!],
      [{ ...request().events[0]!, headers: { token: 'different' } }, request().events[1]!],
      [request().events[0]!, { ...request().events[1]!, metadata: { origin: 'different' } }],
      [...request().events].reverse()
    ];
    for (const events of mutations) {
      await expect(target.append(request({ expectedNextCommitSequence: 1, events }))).rejects.toMatchObject({
        code: 'incompatible_turn_commit', retryable: false
      });
    }
    expect(partition.commits).toHaveLength(1);
    expect(partition.queryAllCalls).toBe(0);
  });

  it('refuses ambiguous after-write success when the stored event material changed', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    const original = request();
    partition.appendFailure = { error: new Error('network timeout'), afterWrite: true };
    partition.afterWrite = (commit) => ({
      ...commit,
      events: commit.events.map((event, index) => index === 1 ? { ...event, payload: { state: { count: 2 } } } : event)
    });
    await expect(target.append(original)).rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
    expect(partition.appendCalls).toBe(1);
    expect(partition.commits[0]?.events[1]?.payload).toEqual({ state: { count: 2 } });
    expect(partition.queryAllCalls).toBe(0);
  });

  it.each(['headers', 'metadata'] as const)('refuses own undefined %s in the expected event before append', async (field) => {
    const partition = new FakeTapewormPartition();
    const bad = request({ events: [{ ...request().events[0], [field]: undefined }, request().events[1]!] });
    await expect(repository(partition).append(bad)).rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
    expect(partition.appendCalls).toBe(0);
  });

  it.each(['headers', 'metadata'] as const)('refuses own undefined %s in stored material before normalization', async (field) => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    await target.append(request());
    const commit = partition.commits[0]!;
    partition.commits[0] = { ...commit, events: commit.events.map((event, index) => index === 0 ? { ...event, [field]: undefined } : event) };
    await expect(target.append(request({ expectedNextCommitSequence: 1 }))).rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
    expect(partition.appendCalls).toBe(1);
  });

  it.each(['headers', 'metadata'] as const)('distinguishes absent %s from a present empty object', async (field) => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    await target.append(request());
    const present = request({
      expectedNextCommitSequence: 1,
      events: [{ ...request().events[0], [field]: {} }, request().events[1]!]
    });
    await expect(target.append(present)).rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
    const commit = partition.commits[0]!;
    partition.commits[0] = { ...commit, events: commit.events.map((event, index) => index === 0 ? { ...event, [field]: {} } : event) };
    await expect(target.append(request({ expectedNextCommitSequence: 1 }))).rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
    expect(partition.appendCalls).toBe(1);
  });

  it('rejects exotic stored and expected JSON prototypes before content comparison', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    const payload = Object.setPrototypeOf({ id: 'saga-1' }, new Date());
    await expect(target.append(request({ events: [{ type: 'saga.instance_created.event', payload }] }))).rejects.toMatchObject({
      code: 'incompatible_turn_commit', retryable: false
    });
    await target.append(request());
    const commit = partition.commits[0]!;
    partition.commits[0] = { ...commit, events: commit.events.map((event, index) => index === 0 ? { ...event, payload } : event) };
    await expect(target.append(request({ expectedNextCommitSequence: 1 }))).rejects.toMatchObject({
      code: 'incompatible_turn_commit', retryable: false
    });
    expect(partition.appendCalls).toBe(1);
  });

  it('maps concurrency without expected-stream readback to conflict without queryAll', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    partition.appendFailure = new ConcurrencyError('conflict');
    await expect(target.append(request())).resolves.toEqual({ status: 'conflict' });
    expect(partition.queryAllCalls).toBe(0);
  });

  it('rethrows an unknown append failure without queryAll', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    partition.appendFailure = new Error('network down');
    await expect(target.append(request())).rejects.toThrow('network down');
    expect(partition.queryAllCalls).toBe(0);
  });

  it('classifies an incompatible duplicate as nonretryable without queryAll', async () => {
    const partition = new FakeTapewormPartition();
    partition.commits.push({
      id: 'turn-1',
      partitionId: 'sagas',
      streamId: 'other-saga',
      commitSequence: 0,
      events: [{ id: 'turn-1:event:0', type: 'saga.instance_created.event', version: 0, payload: {} }],
      sagaTurnIdentity: { sourceTriggerId: 'other', sagaKey: 'other', instanceId: 'other-saga', routeId: 'other' }
    });
    partition.appendFailure = new DuplicateCommitError('duplicate');
    const expected = request();
    await expect(repository(partition).append(expected)).rejects.toMatchObject({
      code: 'incompatible_turn_commit',
      retryable: false,
      details: { commitId: 'turn-1', streamId: 'saga-1', expectedIdentity: expected.identity }
    });
    expect(partition.queryAllCalls).toBe(0);
  });

  it('rejects a same-stream duplicate with incompatible identity diagnostics without queryAll', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    const actual = request();
    await target.append(actual);
    const expected = request({
      expectedNextCommitSequence: 1,
      identity: { ...actual.identity, routeId: 'different-route' }
    });
    partition.appendFailure = new DuplicateCommitError('duplicate');
    await expect(target.append(expected)).rejects.toMatchObject({
      code: 'incompatible_turn_commit',
      retryable: false,
      details: { expectedIdentity: expected.identity, actualIdentity: actual.identity }
    });
    expect(partition.queryAllCalls).toBe(0);
  });

  it('rejects malformed stream ordering before exposing repository state', async () => {
    const partition = new FakeTapewormPartition();
    partition.commits.push({
      id: 'bad',
      partitionId: 'sagas',
      streamId: 'saga-1',
      commitSequence: 1,
      events: [{ id: 'bad:event:0', type: 'saga.instance_created.event', version: 0, payload: {} }]
    });
    const snapshot = await repository(partition).load('saga-1');
    await expect((async () => { for await (const _commit of snapshot.commits) { /* read all */ } })()).rejects.toBeInstanceOf(SagaTurnIntegrityError);
  });
});
