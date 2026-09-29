import { EventEmitter } from 'node:events';
import type { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { createSagaConfirmedRepublisher } from '../src/index';

function fixture() {
  const channel = new EventEmitter();
  const sends: { exchange: string; key: string; body: Buffer; options: Record<string, unknown> }[] = [];
  let callback: ((error: Error | null) => void) | undefined;
  let writable = true;
  let closed = 0;
  const confirm = Object.assign(channel, {
    publish: (exchange: string, key: string, body: Buffer, options: Record<string, unknown>,
      done: (error: Error | null) => void) => {
      sends.push({ exchange, key, body, options });
      callback = done;
      return writable;
    },
    close: async () => { closed++; channel.emit('close'); }
  }) as unknown as ConfirmChannel;
  const model = { createConfirmChannel: async () => confirm } as Pick<ChannelModel, 'createConfirmChannel'>;
  const source = { content: Buffer.from('original'), properties: {
    messageId: 'commit-1', contentType: 'application/json', headers: { collection: 'tw_orders_commits', tenant: 't' },
    deliveryMode: 1
  } } as ConsumeMessage;
  return { model, channel, sends, source, confirm: (error: Error | null = null) => callback?.(error),
    setWritable: (value: boolean) => { writable = value; }, closed: () => closed };
}

describe('isolated mandatory confirmed republisher', () => {
  it('preserves envelope on persistent retry and confirmed DLQ; never settles the original', async () => {
    const f = fixture();
    const publisher = await createSagaConfirmedRepublisher(f.model, 100);
    const pending = publisher.retry(f.source, { attempt: 1 });
    expect(f.sends[0]).toMatchObject({ exchange: 'rdm.saga.commits.retry.exchange', key: 'rdm.saga.commits.retry',
      body: f.source.content, options: { messageId: 'commit-1', contentType: 'application/json', mandatory: true,
        deliveryMode: 2, headers: { collection: 'tw_orders_commits', tenant: 't', attempt: 1 } } });
    f.confirm();
    await pending;
    const dead = publisher.deadLetter(f.source);
    expect(f.sends[1]).toMatchObject({ exchange: '', key: 'rdm.saga.commits.dlq' });
    f.confirm();
    await dead;
    expect('ack' in publisher).toBe(false);
    await publisher.close();
  });

  it.each(['returned', 'nack', 'lost'])('refuses %s despite any other signal', async (mode) => {
    const f = fixture();
    const publisher = await createSagaConfirmedRepublisher(f.model, 100);
    const pending = publisher.retry(f.source);
    if (mode === 'returned') {
      f.channel.emit('return', { properties: { messageId: 'commit-1' } });
      f.confirm();
    } else if (mode === 'nack') f.confirm(new Error('broker nack'));
    else f.channel.emit('close');
    await expect(pending).rejects.toThrow('uncertain');
    await expect(publisher.deadLetter(f.source)).rejects.toThrow('closed');
  });

  it('bounds outstanding publishes, drain and timeout, closing the channel on uncertainty', async () => {
    const f = fixture();
    f.setWritable(false);
    const publisher = await createSagaConfirmedRepublisher(f.model, 30);
    const pending = publisher.retry(f.source);
    await expect(publisher.retry(f.source)).rejects.toThrow('in-flight');
    f.confirm();
    await expect(pending).rejects.toThrow('timed out');
    expect(f.closed()).toBe(1);
  });

  it('waits for drain after confirm and rejects unmatched mandatory returns', async () => {
    const f = fixture();
    f.setWritable(false);
    const publisher = await createSagaConfirmedRepublisher(f.model, 100);
    const pending = publisher.retry(f.source);
    f.confirm();
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.channel.emit('drain');
    await pending;
    const next = publisher.deadLetter(f.source);
    f.channel.emit('return', { properties: { messageId: 'unrelated' } });
    await expect(next).rejects.toThrow('unmatched');
  });

  it('requires the separate confirm channel, valid deadline and source messageId', async () => {
    const f = fixture();
    await expect(createSagaConfirmedRepublisher(f.model, 0)).rejects.toThrow('timeout');
    const publisher = await createSagaConfirmedRepublisher(f.model, 100);
    await expect(publisher.retry({ ...f.source, properties: { ...f.source.properties, messageId: undefined } }))
      .rejects.toThrow('messageId');
    await publisher.close();
  });
});
