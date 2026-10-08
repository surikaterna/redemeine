import { type Command, type CompatibleAggregate, type CommandSink } from '../src';
import { command, deferred, implementations, type State } from './lifecycle.fixture';

afterEach(() => jest.restoreAllMocks());

test('queued promised-command rejection is observed before its FIFO turn under strict Node policy', () => {
  const result = spawnSync(process.execPath, [
    '--unhandled-rejections=strict', '--no-experimental-require-module', '--import', 'tsx',
    join(__dirname, 'queueRejection.fixture.mjs'),
  ], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('queued rejection observed');
});

for (const [label, Constructor] of implementations) {
  test(`${label}: promised commands resolve inside FIFO tasks; live identity/type are read when processed`, async () => {
    const promised = deferred<Command>();
    const calls: Command[] = [];
    const sink: CommandSink<State> = { sink: async (cmd, aggregate) => { calls.push(cmd); return aggregate; } };
    const aggregate = new Constructor(sink);
    const first = aggregate._sink(promised.promise);
    const next = { ...command('replacement'), id: 'next' };
    const second = aggregate._sink(next);
    expect(aggregate._commandQueue._queue.concurrency).toBe(1);
    expect(calls).toEqual([]);
    aggregate.id = 'replacement';
    aggregate.type = 'ReplacementType';
    const original = command(aggregate.id);
    promised.resolve(original);
    expect(await first).toBe(aggregate);
    expect(await second).toBe(aggregate);
    expect(calls).toEqual([original, next]);
    expect(calls[0]).toBe(original);
    expect(original).toHaveProperty('aggregateType', 'ReplacementType');
    expect(aggregate.getVersion()).toBe(0);
    expect(aggregate._commandSink).toBe(sink);
  });

  test(`${label}: size excludes running tasks; sync read rejects only queued work and async read drains`, async () => {
    const release = deferred<CompatibleAggregate<State>>();
    const aggregate = new Constructor({ sink: () => release.promise });
    const first = aggregate._sink(command(aggregate.id));
    expect(aggregate._commandQueue._queue.pending).toBe(1);
    expect(aggregate._commandQueue.isProcessing()).toBe(false);
    const pending = aggregate.getUncommittedEvents();
    const second = aggregate._sink(command(aggregate.id));
    expect(aggregate._commandQueue.isProcessing()).toBe(true);
    expect(() => aggregate.getUncommittedEvents()).toThrow('still commands');
    let drained = false;
    const draining = aggregate.getUncommittedEventsAsync().then(events => { drained = true; return events; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve(aggregate);
    await Promise.all([first, second]);
    expect(await draining).toBe(pending);
    expect(aggregate._commandQueue._queue.pending).toBe(0);
  });

  test(`${label}: async pending accessor rechecks after idle instead of returning while new work is queued`, async () => {
    const aggregate = new Constructor();
    const busy = jest.spyOn(aggregate._commandQueue, 'isProcessing').mockReturnValueOnce(true).mockReturnValue(false);
    const empty = jest.spyOn(aggregate._commandQueue, 'empty');
    expect(await aggregate.getUncommittedEventsAsync()).toBe(aggregate._uncommittedEvents);
    expect(empty).toHaveBeenCalledTimes(2);
    expect(busy).toHaveBeenCalledTimes(3);
  });

  test(`${label}: sink owns process; delayed persistence initiation is not a durability promise`, async () => {
    const order: string[] = [];
    const saved = deferred<void>();
    const handle = jest.fn(aggregate => { order.push('process'); return aggregate; });
    const sink: CommandSink<State> = { sink(cmd, aggregate) {
      order.push('save initiated');
      void saved.promise.then(() => order.push('saved'));
      Reflect.set(cmd, 'headers', { postSink: true });
      return aggregate._process(cmd);
    } };
    const aggregate = new Constructor(sink, null, { handle });
    const original = command(aggregate.id);
    expect(await aggregate._sink(original)).toBe(aggregate);
    await aggregate.getUncommittedEventsAsync();
    expect(order).toEqual(['save initiated', 'process']);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(aggregate, original);
    expect(original).toHaveProperty('headers.postSink', true);
    saved.resolve();
    await saved.promise;
    expect(order).toEqual(['save initiated', 'process', 'saved']);
  });

  test.each([undefined, false, 5, {}])(`${label}: untyped non-promise sink result %s resolves true without fallback`, async result => {
    const aggregate = new Constructor();
    const sink = { sink: jest.fn(() => result) };
    Reflect.set(aggregate, '_commandSink', sink);
    const process = jest.spyOn(aggregate, '_process');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(aggregate._sink(command(aggregate.id))).resolves.toBe(true);
    expect(sink.sink).toHaveBeenCalledTimes(1);
    expect(process).not.toHaveBeenCalled();
  });

  test(`${label}: failed queued sink propagates its exact error and later work still runs once`, async () => {
    const error = new Error('sink');
    const sink = { sink: jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('returned') };
    const aggregate = new Constructor();
    Reflect.set(aggregate, '_commandSink', sink);
    const process = jest.spyOn(aggregate, '_process');
    const first = expect(aggregate._sink(command(aggregate.id))).rejects.toBe(error);
    const second = aggregate._sink(command(aggregate.id));
    await first;
    await expect(second).resolves.toBe('returned');
    expect(sink.sink).toHaveBeenCalledTimes(2);
    expect(process).not.toHaveBeenCalled();
  });

  test(`${label}: invalid command gains id before validation but never reaches sink`, async () => {
    const sink = { sink: jest.fn() };
    const aggregate = new Constructor(sink);
    const invalid: Command = { type: '', aggregateId: 'wrong', payload: {} };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(aggregate._sink(invalid)).rejects.toThrow('command is missing data');
    expect(invalid.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(sink.sink).not.toHaveBeenCalled();
  });
}
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
