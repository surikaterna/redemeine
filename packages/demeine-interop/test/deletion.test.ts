import { Aggregate, Repository, type Command, type Event, type Partition } from 'demeine';
import Bluebird from 'bluebird';
import { DefaultCommandHandler } from 'demeine/lib/aggregate/DefaultCommandHandler';
import { DefaultEventHandler } from 'demeine/lib/aggregate/DefaultEventHandler';
import { createDemeineBridge } from '../src';
import { definition } from './fixture';

test.each([false, true])('inherited deletion bypasses builder/envelope (explicit defaults=%s)', async explicit => {
  const built = definition();
  const process = jest.spyOn(built, 'process');
  const apply = jest.spyOn(built, 'apply');
  const envelope = jest.fn(event => event);
  const Bridge = createDemeineBridge(built, { AggregateBase: Aggregate, envelope });
  const aggregate = new Bridge(null, explicit ? new DefaultEventHandler() : null, explicit ? new DefaultCommandHandler() : null);
  aggregate.id = 'live-id';
  aggregate.type = 'LiveType';
  aggregate._state = { count: 9, items: [] };
  await aggregate.delete();
  const [deleted] = aggregate.getUncommittedEvents();
  expect(deleted).toMatchObject({ type: '$stream.deleted.event', aggregateId: 'live-id', correlationId: expect.any(String), payload: { aggregateType: 'LiveType' } });
  expect(deleted).not.toHaveProperty('metadata');
  expect(aggregate._state.count).toBe(9);
  aggregate.processDelete({ type: 'counter.remove.command', id: 'remove-id', payload: {} });
  expect(aggregate.getUncommittedEvents()[1]).toMatchObject({ correlationId: 'remove-id' });
  expect(aggregate.getVersion()).toBe(2);
  expect(process).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(envelope).not.toHaveBeenCalled();
  await aggregate.add(1);
  expect(aggregate._state.count).toBe(10);
});

test('real Repository intercepts first deletion, discarding normal append of mixed buffer', async () => {
  const Bridge = createDemeineBridge(definition(), { AggregateBase: Aggregate });
  const aggregate = new Bridge();
  const stream = { append: jest.fn(), commit: jest.fn(), getCommittedEvents: jest.fn(), getVersion: () => 0, _version: 0 };
  const partition = { delete: jest.fn().mockReturnValue(Bluebird.resolve(aggregate)), openStream: jest.fn().mockReturnValue(Bluebird.resolve(stream)) };
  const repository = new Repository(partition, 'counter', () => aggregate);
  await aggregate.add(1);
  await aggregate.delete();
  await aggregate.add(2);
  await aggregate.delete();
  const firstDeleted = aggregate.getUncommittedEvents()[1];
  await repository.save(aggregate);
  expect(partition.delete).toHaveBeenCalledTimes(1);
  expect(partition.delete).toHaveBeenCalledWith(aggregate.id, firstDeleted);
  expect(partition.openStream).toHaveBeenCalledWith(aggregate.id, true);
  expect(stream.append).not.toHaveBeenCalled();
  expect(stream.commit).not.toHaveBeenCalled();
});

type Commit = { id: string; streamId: string; events: Event<{ aggregateType?: string }>[]; isDispatched: boolean };
interface Persistence {
  _snapshots: Record<string, unknown>;
  truncateStreamFrom(id: string, sequence: number): Promise<unknown>;
  queryAll(): Promise<Commit[]>;
  removeSnapshot?: (id: string) => Promise<void>;
}
interface StorePartition extends Partition {
  _persistencePartition: Persistence;
  _dispatchService: (commit: Commit, done: () => void) => void;
}
const EventStore: new () => { openPartition(id: string): Promise<StorePartition> } = require('tapeworm');

async function storedAggregate() {
  const partition = await new EventStore().openPartition('isolated-test');
  const persistence = partition._persistencePartition;
  // The shipped in-memory provider has no removal method. Supply this persistence
  // capability so the real 0.5.0 deletion routine must invoke it, not bridge code.
  persistence.removeSnapshot = jest.fn(async id => { delete persistence._snapshots[id]; });
  const truncate = jest.spyOn(persistence, 'truncateStreamFrom');
  const deleteSpy = jest.spyOn(partition, 'delete');
  const Bridge = createDemeineBridge(definition(), { AggregateBase: Aggregate });
  const aggregate = new Bridge();
  aggregate.type = 'CounterProjection';
  const repository = new Repository(partition, 'counter', () => aggregate);
  await aggregate.add(3);
  await repository.save(aggregate, 'old-commit');
  await partition.storeSnapshot!(aggregate.id, aggregate._state, 1);
  return { partition, persistence, truncate, deleteSpy, aggregate, repository };
}

test('tapeworm 0.5.0 deletion truncates, commits one fresh tombstone, removes snapshot and dispatches correlation', async () => {
  const { partition, persistence, truncate, deleteSpy, aggregate, repository } = await storedAggregate();
  const commands = new Map<string, Command>();
  const commitLookup: Command[] = [];
  const projections = new Map([[`CounterProjection:${aggregate.id}`, aggregate._state]]);
  partition._dispatchService = (commit, done) => {
    const event = commit.events[0]!;
    commitLookup.push(commands.get(event.correlationId!)!);
    projections.delete(`${event.payload.aggregateType}:${commit.streamId}`);
    done();
  };
  const remove = { id: 'remove-command', type: 'counter.remove.command', payload: {} };
  commands.set(remove.id, remove);
  aggregate.processDelete(remove);
  await repository.save(aggregate);
  const commits = await persistence.queryAll();
  expect(deleteSpy).toHaveBeenCalledTimes(1);
  expect(truncate).toHaveBeenCalledWith(aggregate.id, -1, undefined);
  expect(commits).toHaveLength(1);
  expect(commits[0]!.id).not.toBe('old-commit');
  expect(commits[0]!.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(commits[0]!.events).toHaveLength(1);
  expect(commits[0]!.events[0]).toMatchObject({ type: '$stream.deleted.event', correlationId: 'remove-command' });
  expect(commits[0]!.isDispatched).toBe(true);
  expect(persistence.removeSnapshot).toHaveBeenCalledWith(aggregate.id);
  expect(await partition.loadSnapshot!(aggregate.id)).toBeUndefined();
  expect(commitLookup).toEqual([remove]);
  expect(projections.size).toBe(0);
});
