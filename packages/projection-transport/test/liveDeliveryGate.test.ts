import { expect, test } from '@jest/globals';
import { liveCommit } from '../../projection-worker-core/test/liveFixtures';
import { createLiveDeliveryGate } from '../src/liveDeliveryGate';
import { liveStart, OrderedLiveFeedFixture } from './orderedLiveFeedFixture';
import { delivery, readerFor } from './liveRabbitFixtures';

test('raw scope, message identity and full authoritative content are checked before admission', async () => {
  const commit = liveCommit(42);
  const feed = new OrderedLiveFeedFixture();
  feed.append(commit);
  await feed.openSession(liveStart, { sessionRef: 'channel', queueName: liveStart.queueName, prefetch: 1, exclusive: true });
  const wire = delivery(feed, commit);
  const gate = createLiveDeliveryGate({ collection: 'commits', partitionId: 'partition', sourceScopeDigest: 'scope' }, readerFor([commit]), 10000);
  await expect(gate.verify(wire)).resolves.toEqual(commit);
  await expect(gate.verify({ ...wire, properties: { ...wire.properties, messageId: 'forged' } })).rejects.toThrow('invalid_live_wire');
  await expect(gate.verify({ ...wire, properties: { ...wire.properties, headers: { ...wire.properties.headers, partitionId: 'forged' } } })).rejects.toThrow('scope');
  await expect(gate.verify({ ...wire, content: Buffer.from(wire.content.toString().replace('"amount":1', '"amount":2')) })).rejects.toThrow('authoritative');
  await expect(gate.verify({ ...wire, content: Buffer.alloc(10001) })).rejects.toThrow('capacity');
  const scope = { collection: 'commits', partitionId: 'partition', sourceScopeDigest: 'scope' };
  const stableGate = createLiveDeliveryGate(scope, readerFor([commit]), 10000);
  scope.partitionId = 'changed';
  await expect(stableGate.verify(wire)).resolves.toEqual(commit);
});
