import { EventEmitter } from 'node:events';
import type { ChannelModel } from 'amqplib';
import { probeAmqpConnect } from '../integration/amqpRestartProbe';
import { refreshedEndpoints } from '../integration/restartEndpoints';

const id = 'a'.repeat(64);
const name = `topology-${'b'.repeat(32)}`;
const previous = { owner: 'amqp://owner:secret@127.0.0.1:1111',
  restricted: 'amqp://restricted:secret@127.0.0.1:1111', management: 'http://127.0.0.1:2222' };

function command(amqp: string, management: string, inspect = JSON.stringify({ Id: id, Name: `/${name}`,
  Config: { Labels: { 'redemeine.fyp3.3.run': name } } })) {
  return jest.fn((args: string[]) => {
    if (args[0] === 'container') return inspect;
    return args[2] === '5672/tcp' ? amqp : management;
  });
}

describe('owned Rabbit restart port refresh', () => {
  it.each([[3111, 4222], [1111, 2222]])('atomically updates all URLs for AMQP %i and management %i', (amqp, management) => {
    const run = command(`127.0.0.1:${amqp}`, `127.0.0.1:${management}`);
    const next = refreshedEndpoints(previous, name, id, name, run);
    expect(new URL(next.owner).port).toBe(String(amqp));
    expect(new URL(next.restricted).port).toBe(String(amqp));
    expect(new URL(next.management).port).toBe(String(management));
    expect(new URL('/api/queues/%2F/test', next.management).pathname).toBe('/api/queues/%2F/test');
    expect(previous.owner).toContain(':1111');
    expect(run.mock.calls.map((call) => call[0])).toEqual([
      ['container', 'inspect', name, '--format', '{{json .}}'],
      ['port', id, '5672/tcp'], ['port', id, '15672/tcp']
    ]);
  });

  it.each(['127.0.0.1:4444\n127.0.0.1:5555', '0.0.0.0:4444', 'localhost:4444',
    '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:4.5', '127.0.0.1:4444 secret'])
  ('rejects ambiguous, nonlocal and malformed mapping without leaking %s', (mapping) => {
    expect(() => refreshedEndpoints(previous, name, id, name, command(mapping, '127.0.0.1:2222')))
      .toThrow('unique localhost Rabbit port required');
  });

  it('does not partially replace endpoints when the management mapping is invalid', () => {
    const current = { ...previous };
    expect(() => refreshedEndpoints(current, name, id, name, command('127.0.0.1:3111', '0.0.0.0:4222')))
      .toThrow('unique localhost Rabbit port required');
    expect(current).toEqual(previous);
  });

  it('rejects foreign owner or ID before querying ports', () => {
    const run = command('127.0.0.1:3111', '127.0.0.1:4222', JSON.stringify({ Id: id, Name: `/${name}`,
      Config: { Labels: { 'redemeine.fyp3.3.run': 'foreign' } } }));
    expect(() => refreshedEndpoints(previous, name, id, name, run)).toThrow('owned Rabbit identity mismatch');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('switches from a refused old endpoint to the new owned mapping without creating a channel', async () => {
    const next = refreshedEndpoints(previous, name, id, name, command('127.0.0.1:3111', '127.0.0.1:4222'));
    const model = Object.assign(new EventEmitter(), { close: jest.fn(async () => undefined) }) as unknown as ChannelModel;
    const connect = jest.fn(async (url: string) => {
      if (new URL(url).port === '1111') throw Object.assign(new Error('amqp://owner:secret@host'), { code: 'ECONNREFUSED' });
      return model;
    });
    await expect(probeAmqpConnect(previous.owner, 30, connect)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(probeAmqpConnect(next.owner, 30, connect)).resolves.toBeUndefined();
    expect(connect.mock.calls.map(([url]) => new URL(url).port)).toEqual(['1111', '3111']);
    expect(model.close).toHaveBeenCalledTimes(1);
  });
});
