import { describe, expect, it } from '@jest/globals';
import { SagaTurnIntegrityError, type SagaTurnAppendRequest } from '@redemeine/saga-runtime';
import Bluebird from 'bluebird';
import {
  ConcurrencyError,
  DuplicateCommitError,
  type ICommit,
  type IPersistencePartition,
  type NodeCallback
} from 'tapeworm';
import {
  createTapewormSagaTurnRepository,
  type TapewormSagaEvent,
  type TapewormPartitionReadiness
} from '../src/index';

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
    return Bluebird.resolve([...this.commits]).nodeify(callback);
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
  });

  it('continues commit and event versions contiguously', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    await target.append(request());
    await target.append(request({ commitId: 'turn-2', expectedNextCommitSequence: 1, events: [{ type: 'saga.source_event_observed.event', payload: {} }] }));
    expect(partition.commits[1]?.commitSequence).toBe(1);
    expect(partition.commits[1]?.events[0]?.version).toBe(2);
  });

  it('reconciles duplicate and ambiguous-success writes through identity readback', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    await target.append(request());
    partition.appendFailure = new DuplicateCommitError('duplicate');
    const duplicate = await target.append(request({ expectedNextCommitSequence: 1 }));
    expect(duplicate).toMatchObject({ status: 'reconciled', commit: { commitId: 'turn-1' } });

    partition.appendFailure = { error: new Error('network timeout'), afterWrite: true };
    const ambiguous = await target.append(request({ commitId: 'turn-2', expectedNextCommitSequence: 1 }));
    expect(ambiguous).toMatchObject({ status: 'reconciled', commit: { commitId: 'turn-2' } });
  });

  it('maps concurrency without readback to conflict and rethrows unknown failures', async () => {
    const partition = new FakeTapewormPartition();
    const target = repository(partition);
    partition.appendFailure = new ConcurrencyError('conflict');
    await expect(target.append(request())).resolves.toEqual({ status: 'conflict' });
    partition.appendFailure = new Error('network down');
    await expect(target.append(request())).rejects.toThrow('network down');
  });

  it('rejects deterministic commit aliases outside the expected stream', async () => {
    const partition = new FakeTapewormPartition();
    partition.commits.push({
      id: 'turn-1', partitionId: 'sagas', streamId: 'other-saga', commitSequence: 0,
      events: [{ id: 'turn-1:event:0', type: 'saga.instance_created.event', version: 0, payload: {} }],
      sagaTurnIdentity: { sourceTriggerId: 'other', sagaKey: 'other', instanceId: 'other-saga', routeId: 'other' }
    });
    partition.appendFailure = new DuplicateCommitError('duplicate');
    await expect(repository(partition).append(request())).rejects.toMatchObject({
      code: 'incompatible_turn_commit', retryable: false
    });
  });

  it('rejects malformed stream ordering before exposing repository state', async () => {
    const partition = new FakeTapewormPartition();
    partition.commits.push({
      id: 'bad', partitionId: 'sagas', streamId: 'saga-1', commitSequence: 1,
      events: [{ id: 'bad:event:0', type: 'saga.instance_created.event', version: 0, payload: {} }]
    });
    await expect(repository(partition).load('saga-1')).rejects.toBeInstanceOf(SagaTurnIntegrityError);
  });
});
