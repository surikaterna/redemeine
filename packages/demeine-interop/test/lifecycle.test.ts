import Bluebird from 'bluebird';
import { type Event } from '../src';
import { command, event, implementations } from './lifecycle.fixture';

afterEach(() => jest.restoreAllMocks());

for (const [label, Constructor] of implementations) {
  test(`${label}: validation assigns UUID first, failed application does not count and successful events retain identity`, () => {
    const handle = jest.fn();
    const aggregate = new Constructor(null, { handle });
    const invalid = event('wrong');
    expect(() => aggregate._apply(invalid, true)).toThrow('event is missing data');
    expect(invalid.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(handle).not.toHaveBeenCalled();
    const accepted = event(aggregate.id);
    aggregate._version = -1;
    expect(aggregate._apply(accepted, true)).toBe(aggregate);
    expect(aggregate.getVersion()).toBe(1);
    expect(aggregate.getUncommittedEvents()[0]).toBe(accepted);
    handle.mockImplementationOnce(() => { throw new Error('failed evolution'); });
    expect(() => aggregate._apply(event(aggregate.id), true)).toThrow('failed evolution');
    expect(aggregate.getVersion()).toBe(1);
    expect(aggregate.getUncommittedEvents()).toEqual([accepted]);
  });

  test(`${label}: pending arrays and snapshots are live references; clear replaces rather than mutates`, () => {
    const aggregate = new Constructor(null, { handle() {} });
    const snapshot = { count: 7, items: ['factory'] };
    aggregate._state = snapshot;
    expect(aggregate._getSnapshot()).toBe(snapshot);
    const pending = aggregate.getUncommittedEvents();
    const accepted = event(aggregate.id);
    aggregate._apply(accepted, true);
    expect(pending[0]).toBe(accepted);
    const empty = aggregate.clearUncommittedEvents();
    expect(empty).toBe(aggregate.getUncommittedEvents());
    expect(empty).toEqual([]);
    expect(empty).not.toBe(pending);
    expect(pending).toEqual([accepted]);
    expect(aggregate.getVersion()).toBe(1);
  });

  test.each([undefined, 0, -1, 7])(`${label}: replay version %s preserves snapshot identity and never buffers`, async version => {
    const handle = jest.fn();
    const aggregate = new Constructor(null, { handle });
    const snapshot = { count: 9, items: [] };
    await aggregate._rehydrate([event(aggregate.id), event(aggregate.id)], version, snapshot);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(aggregate._state).toBe(snapshot);
    expect(aggregate.getVersion()).toBe(version || 2);
    expect(aggregate.getUncommittedEvents()).toEqual([]);
    await aggregate._rehydrate([], 0);
    expect(aggregate.getVersion()).toBe(version || 2);
    expect(aggregate._getSnapshot()).toBe(snapshot);
  });

  test(`${label}: replay yields at indices zero and one hundred, not before applying them`, async () => {
    const aggregate = new Constructor(null, { handle() {} });
    const yielded: number[] = [];
    const immediate = global.setImmediate;
    const spy = jest.spyOn(global, 'setImmediate').mockImplementation(callback => {
      yielded.push(aggregate.getVersion());
      return immediate(callback);
    });
    try {
      await aggregate._rehydrate(Array.from({ length: 201 }, () => event(aggregate.id)));
      expect(yielded).toEqual([1, 101, 201]);
    } finally { spy.mockRestore(); }
  });

  test.each(['throw', 'native rejection', 'operational'] as const)(`${label}: %s only clears if operational; no rollback or fallback`, async failure => {
    const aggregate = new Constructor(null, { handle() {} });
    aggregate._apply(event(aggregate.id), true);
    const previous = aggregate.getUncommittedEvents();
    const error = failure === 'operational' ? new Bluebird.OperationalError('operational') : new Error('ordinary');
    const handle = jest.fn(() => {
      if (failure === 'native rejection') return Promise.reject(error);
      throw error;
    });
    Reflect.set(aggregate, '_commandHandler', { handle });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(aggregate._process(command(aggregate.id))).rejects.toBe(error);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(aggregate.getVersion()).toBe(1);
    expect(previous).toHaveLength(1);
    if (failure === 'operational') {
      expect(aggregate.getUncommittedEvents()).not.toBe(previous);
      expect(aggregate.getUncommittedEvents()).toEqual([]);
      if (label === 'standalone') expect(log).toHaveBeenCalledTimes(1);
    } else {
      expect(aggregate.getUncommittedEvents()).toBe(previous);
      expect(log).not.toHaveBeenCalled();
    }
  });

  test(`${label}: direct process is not queued and assimilates untyped result without replacing it`, async () => {
    const aggregate = new Constructor();
    const queue = jest.spyOn(aggregate._commandQueue, 'queueCommand');
    for (const result of [undefined, { arbitrary: true }, Promise.resolve('settled')]) {
      Reflect.set(aggregate, '_commandHandler', { handle: () => result });
      await expect(aggregate._process(command(aggregate.id))).resolves.toBe(await result);
    }
    expect(queue).not.toHaveBeenCalled();
  });

  test(`${label}: partial replay preserves earlier events and state side effects on a later failure`, async () => {
    let applied = 0;
    const aggregate = new Constructor(null, { handle() { if (++applied === 2) throw new Error('second'); } });
    const events: Event[] = [event(aggregate.id), event(aggregate.id), event(aggregate.id)];
    await expect(aggregate._rehydrate(events, 99)).rejects.toThrow('second');
    expect(applied).toBe(2);
    expect(aggregate.getVersion()).toBe(1);
    expect(aggregate.getUncommittedEvents()).toEqual([]);
  });
}
