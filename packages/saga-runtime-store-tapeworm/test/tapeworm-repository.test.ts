import { describe, expect, it } from '@jest/globals';
import { type SagaTurnAppendRequest, SagaTurnIntegrityError } from '@redemeine/saga-runtime';
import Bluebird from 'bluebird';
import { ConcurrencyError, DuplicateCommitError, type ICommit, type IPersistencePartition, type NodeCallback } from 'tapeworm';
import { createTapewormSagaTurnRepository, type TapewormPartitionReadiness, type TapewormSagaEvent } from '../src/index';

const readiness: TapewormPartitionReadiness = {
  partitionOpened: true,
  uniqueCommitIdIndexReady: true,
  uniqueStreamSequenceIndexReady: true
};

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
  appendFailure?: AppendFailure;

  append(commit: ICommit<TapewormSagaEvent>, callback?: NodeCallback<ICommit<TapewormSagaEvent>>) {
    const failure = this.appendFailure;
    this.appendFailure = undefined;
    if (failure) {
      if (!(failure instanceof Error) && failure.afterWrite) this.commits.push(commit);
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
  return createTapewormSagaTurnRepository({ partition, partitionId: 'sagas', readiness });
}

describe('Tapeworm saga turn repository', () => {
  it('uses actual queryStream/append contracts and starts commit and event sequences at zero', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    expect(await target.load('saga-1')).toEqual({ streamId: 'saga-1', nextCommitSequence: 0, events: [] });
    expect(await target.append(request())).toEqual({ status: 'committed', commitSequence: 0 });
    expect(partition.commits).toHaveLength(1);
    expect(partition.commits[0]).toMatchObject({ id: 'turn-1', partitionId: 'sagas', streamId: 'saga-1', commitSequence: 0 });
    expect(partition.commits[0]?.events.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: 'turn-1:event:0', version: 0 },
      { id: 'turn-1:event:1', version: 1 }
    ]);
    const loaded = await target.load('saga-1');
    expect(loaded.nextCommitSequence).toBe(1);
    expect(loaded.events).toHaveLength(2);
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
    const result = await target.append(original);
    expect(result.status).toBe('reconciled');
    const actual = partition.commits[0]!;
    partition.commits[0] = { ...actual, events: actual.events.map((event, index) => index === 1 ? { ...event, payload: { state: { count: 2 } } } : event) };
    await expect(target.append(original)).rejects.toMatchObject({ code: 'incompatible_turn_commit', retryable: false });
    expect(partition.queryAllCalls).toBe(0);
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
    await expect(repository(partition).load('saga-1')).rejects.toBeInstanceOf(SagaTurnIntegrityError);
  });
});
