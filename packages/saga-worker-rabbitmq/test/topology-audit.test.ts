import { EventEmitter } from 'node:events';
import type { Channel, ConfirmChannel, Message, Options } from 'amqplib';
import { expectBrokerRejection, publishConfirmedCommit } from '../integration/topologyAudit';

describe('offline topology audit observers', () => {
  it.each([false, true])('mandatory publish confirms and detects return=%s independently', async (returned) => {
    const events = new EventEmitter();
    const published: Array<{ exchange: string; options: Options.Publish }> = [];
    const channel = Object.assign(events, {
      publish: (exchange: string, _key: string, _body: Buffer, options: Options.Publish, callback: (error: Error | null) => void) => {
        published.push({ exchange, options });
        if (returned) events.emit('return', { properties: { messageId: options.messageId } } as Message);
        callback(null);
        return true;
      },
      waitForConfirms: async () => undefined
    }) as unknown as ConfirmChannel;
    await publishConfirmedCommit(channel, 'source', { id: 'commit-a', partitionId: 'p1', collection: 'tw_p1_commits', tenant: 'tenant-a' }, returned);
    expect(published).toEqual([{ exchange: 'source', options: expect.objectContaining({
      deliveryMode: 2, mandatory: true, messageId: 'commit-a', headers: {
        collection: 'tw_p1_commits', partitionId: 'p1', streamId: 'stream-commit-a', tenant: 'tenant-a'
      }
    }) }]);
    expect(events.listenerCount('return')).toBe(0);
    await expect(publishConfirmedCommit(channel, 'source', { id: 'commit-b', partitionId: 'p1', collection: 'tw_p1_commits' }, !returned))
      .rejects.toThrow('routing mismatch');
  });

  it('requires matching broker code in rejection AND the observed channel error', async () => {
    const channel = new EventEmitter() as unknown as Channel;
    const rejectWith = (code: number) => async () => {
      const error = Object.assign(new Error('broker closed'), { code });
      channel.emit('error', error);
      throw Object.assign(new Error('topology failed'), { cause: error });
    };
    await expectBrokerRejection(channel, rejectWith(406), 406);
    await expectBrokerRejection(channel, rejectWith(403), 403);
    expect(channel.listenerCount('error')).toBe(0);
    await expect(expectBrokerRejection(channel, rejectWith(406), 403)).rejects.toThrow('expected broker reply code 403');
    expect(channel.listenerCount('error')).toBe(0);
  });
});
