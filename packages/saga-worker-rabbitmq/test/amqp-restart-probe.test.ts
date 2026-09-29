import { EventEmitter } from 'node:events';
import type { ChannelModel, SocketOptions } from 'amqplib';
import { probeAmqpConnect, waitForAmqpAfterRestart } from '../integration/amqpRestartProbe';

function model() {
  const events = new EventEmitter();
  const destroy = jest.fn();
  const close = jest.fn(async () => undefined);
  const createChannel = jest.fn(async () => { throw new Error('no channel needed for connect probe'); });
  const channelModel = Object.assign(events, { close, createChannel, connection: { stream: { destroy } } }) as unknown as ChannelModel;
  return { channelModel, events, close, destroy, createChannel };
}

describe('bounded AMQP restart connection probe', () => {
  it('closes a successful model without creating a channel or unhandled model error', async () => {
    const fake = model();
    const connect = jest.fn(async (_url: string, options: SocketOptions) => {
      expect(options.timeout).toBe(50);
      return fake.channelModel;
    });
    await probeAmqpConnect('amqp://user:pass@host', 50, connect);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.createChannel).not.toHaveBeenCalled();
    expect(() => fake.events.emit('error', new Error('closed Basic private'))).not.toThrow();
  });

  it('bounds a hung connect and destroys a model that resolves late', async () => {
    let complete: ((value: ChannelModel) => void) | undefined;
    const pending = new Promise<ChannelModel>((resolve) => { complete = resolve; });
    const fake = model();
    await expect(probeAmqpConnect('amqp://user:pass@host', 20, async () => pending)).rejects.toThrow('timed out');
    complete?.(fake.channelModel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(() => fake.events.emit('error', new Error('late close'))).not.toThrow();
  });

  it('keeps the existing overall budget and supplies sanitized last AMQP failure to the gate', async () => {
    const failures: unknown[] = [];
    const connect = async () => { throw Object.assign(new Error('amqp://user:pass@host'), { code: 'ECONNREFUSED' }); };
    await expect(waitForAmqpAfterRestart('amqp://user:pass@host', (error) => failures.push(error), connect, 40))
      .rejects.toThrow('deadline exceeded');
    expect(failures.length).toBeGreaterThan(0);
  });
});
