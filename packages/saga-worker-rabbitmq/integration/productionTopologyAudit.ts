import type { Channel } from 'amqplib';
import type { ICommit } from 'tapeworm';
import { CommitPublisher, type RabbitConfig } from 'tapeworm_dispatcher_mdb_rmq';

type Inspect = (path: string) => Promise<unknown>;

/** Uses the installed public dispatcher publisher, not a hand-built Rabbit envelope. */
export async function publishTapewormCommit(uri: string, exchange: string): Promise<ICommit> {
  const rabbit: RabbitConfig = { uri, exchange };
  const publisher = new CommitPublisher(rabbit, 'tenant-a');
  const commit: ICommit = {
    id: 'production-kept', partitionId: 'p1', streamId: 'stream-production-kept',
    commitSequence: 0, createDateTime: new Date().toISOString(),
    events: [{ id: 'event-production-kept', type: 'Created', version: 0, payload: { id: 'production-kept' } }]
  };
  try {
    await publisher.connect();
    await publisher.publish(commit, 'tw_source_commits');
  } finally {
    await publisher.close();
  }
  return commit;
}

/** Observe the actual queued delivery and return it to the queue before the restart. */
export async function inspectPublisherDelivery(channel: Channel, queue: string, commit: ICommit): Promise<void> {
  const message = await channel.get(queue, { noAck: false });
  expect(message).not.toBe(false);
  if (!message) throw new Error('publisher delivery absent');
  try {
    expect(message.properties.headers).toMatchObject({
      collection: 'tw_source_commits', partitionId: 'p1', streamId: commit.streamId, tenant: 'tenant-a'
    });
    expect(message.properties.messageId).toBe(commit.id);
    expect(message.properties.deliveryMode).toBe(2);
    expect(JSON.parse(message.content.toString('utf8'))).toMatchObject({
      id: commit.id, partitionId: commit.partitionId, streamId: commit.streamId
    });
  } finally {
    channel.nack(message, false, true);
  }
}

/** Called before any post-restart declaration: observation alone must prove persistence. */
export async function inspectPersistedProductionTopology(inspect: Inspect, exchange: string): Promise<void> {
  const input = await inspect('/api/queues/%2F/rdm.saga.commits');
  const dead = await inspect('/api/queues/%2F/rdm.saga.commits.dlq');
  const dlx = await inspect('/api/exchanges/%2F/rdm.saga.commits.dlx');
  const source = await inspect(`/api/exchanges/%2F/${encodeURIComponent(exchange)}`);
  expect(input).toMatchObject({ durable: true, messages_ready: 1, messages_unacknowledged: 0, arguments: {
    'x-dead-letter-exchange': 'rdm.saga.commits.dlx', 'x-dead-letter-routing-key': 'rdm.saga.commits.dlq' } });
  expect(dead).toMatchObject({ durable: true });
  expect(dlx).toMatchObject({ durable: true, type: 'direct' });
  expect(source).toMatchObject({ durable: true, type: 'headers' });
  const bindings = await inspect(`/api/bindings/%2F/e/${encodeURIComponent(exchange)}/q/rdm.saga.commits`);
  expect(bindings).toEqual(expect.arrayContaining(['p1', 'p2'].map((partitionId) =>
    expect.objectContaining({ arguments: { 'x-match': 'all', collection: 'tw_source_commits', partitionId, tenant: 'tenant-a' } }))));
  expect(bindings).toHaveLength(2);
}
