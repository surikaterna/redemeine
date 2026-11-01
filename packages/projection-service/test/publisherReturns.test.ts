import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PublisherReturns, publisherCounters, mandatoryReturnIncreased, returnBaseline } from '../integration/publisherReturns';
import { BrokerHttp } from '../integration/http';
import { Receipts, sanitizedLogs } from '../integration/receipts';
import { exchangeName, publisherUsername } from '../integration/plan';

const scope = { vhost: 'hpq1_c603ab27e914', peerAddress: '172.20.0.5' };
const channel = { name: '172.20.0.5:45000 -> 172.20.0.3:5672 (1)', number: 1, vhost: scope.vhost,
  user: publisherUsername, confirm: true, state: 'running',
  connection_details: { name: '172.20.0.5:45000 -> 172.20.0.3:5672', peer_host: scope.peerAddress, peer_port: 45000 },
  message_stats: { publish: 10, return_unroutable: 2, return_unroutable_details: { rate: 999 } } };
const exchange = { name: exchangeName, vhost: scope.vhost, type: 'headers', durable: true, auto_delete: false, internal: false,
  arguments: {}, message_stats: { publish_in: 10, publish_out: 0 } };

test('native Rabbit4.1 exchange top-level publish fields are not return evidence; publisherchannel totals are', () => {
  expect(exchange.message_stats).not.toHaveProperty('return_unroutable');
  expect(publisherCounters([channel], scope)).toMatchObject({ published: 10, returned: 2 });
  expect(publisherCounters([{ ...channel, connection_details: { ...channel.connection_details, peer_host: '::ffff:172.20.0.5' } }], scope))
    .toEqual(publisherCounters([channel], scope));
});

test.each([
  { ...channel, vhost: 'foreign', message_stats: { publish: 999, return_unroutable: 999 } },
  { ...channel, user: 'other' }, { ...channel, connection_details: { ...channel.connection_details, peer_host: '172.20.0.6' } }
])('foreignvhost/user/peer counters never selected: %j', (foreign) => {
  expect(publisherCounters([foreign], scope)).toBeNull();
  expect(publisherCounters([foreign, channel], scope)).toEqual(publisherCounters([channel], scope));
});

test.each([undefined, {}, { publish: 0 }, { return_unroutable: 0 }])('missingstats/counters stay unknown,not zero baseline: %j', (stats) => {
  expect(publisherCounters([{ ...channel, message_stats: stats }], scope)).toBeNull();
});

test.each([{ publish: '1', return_unroutable: 0 }, { publish: 1, return_unroutable: -1 },
  { publish: 1, return_unroutable: 0.5 }, { publish: Number.MAX_SAFE_INTEGER + 1, return_unroutable: 1 }])
('malformed total counters refuse ratherthan use rates: %j', (stats) => {
  expect(() => publisherCounters([{ ...channel, message_stats: stats }], scope)).toThrow();
});

test('ambiguity/capacity and changedidentity/reset cannot certify advancement', () => {
  expect(() => publisherCounters([channel, channel], scope)).toThrow('publisher_channel_ambiguous');
  expect(() => publisherCounters(Array(17).fill(channel), scope)).toThrow('publisher_channel_capacity_or_shape');
  const before = { identity: 'hash', published: 10, returned: 2 };
  expect(() => mandatoryReturnIncreased(before, { ...before, identity: 'changed' })).toThrow('publisher_channel_identity_changed');
  expect(() => mandatoryReturnIncreased(before, { ...before, published: 0, returned: 0 })).toThrow('publisher_counters_reset');
});

test.each([{ published: 10, returned: 2 }, { published: 11, returned: 2 }, { published: 10, returned: 3 }])
('existingcounts or one-sided delta is not a newreturn: %j', (after) => {
  expect(mandatoryReturnIncreased({ identity: 'hash', published: 10, returned: 2 }, { identity: 'hash', ...after })).toBe(false);
});

test('newnumericpublishandreturntotals on samepublisheridentity certify a fresh observation,not rate or sourceUUID', () => {
  expect(mandatoryReturnIncreased({ identity: 'hash', published: 10, returned: 2 }, { identity: 'hash', published: 11, returned: 3 })).toBe(true);
});

test.each([true, false])('injectedmanagementprotocol scopesvhost/publisher andrefusesdestinations;bound=%s', async (bound) => {
  const root = await mkdtemp('/tmp/opencode/hpq1-return-metric-');
  const broker = new BrokerHttp(49152, 'test', 'secret-canary', new AbortController().signal); const calls: string[][] = [];
  jest.spyOn(broker, 'request').mockImplementation(async (_method, segments) => {
    calls.push([...segments]);
    if (segments.at(-1) === 'source') return bound ? [{ source: exchangeName, destination: 'unwanted' }] : [];
    if (segments.at(-1) === 'channels') return [{ ...channel, password: 'secret-canary' }];
    return exchange;
  });
  try {
    const receipt = new Receipts(root, 'c603ab27e914'); const observer = new PublisherReturns(broker, receipt, scope);
    if (bound) await expect(observer.sample()).rejects.toThrow('publisher_destination_present_or_unproven');
    else {
      expect(await observer.sample()).toMatchObject({ published: 10, returned: 2 });
      expect(calls).toEqual([['exchanges', scope.vhost, exchangeName],
        ['exchanges', scope.vhost, exchangeName, 'bindings', 'source'], ['vhosts', scope.vhost, 'channels']]);
      const saved = await readFile(join(root, 'receipt.json'), 'utf8');
      expect(saved).not.toContain('secret-canary'); expect(saved).not.toContain(channel.name);
    }
  } finally { jest.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});

test('native mandatoryreturn CLI error receives only exactsafe classification', () => {
  const log = sanitizedLogs('Dispatcher retry: Mandatory publication unroutable\nDispatcher retry: amqp://secret-canary\n');
  expect(log).toContain('mandatory_publication_unroutable'); expect(log).not.toContain('secret-canary');
});

test('cold publication metrics initialize through append before numericbaseline,never fabricated zero', async () => {
  const calls: string[] = []; let initialized = false; let read = 0;
  const sample = async () => {
    calls.push('sample'); read += 1;
    return initialized && read >= 3 ? publisherCounters([channel], scope) : null;
  };
  const baseline = await returnBaseline({ sample }, async () => { calls.push('append'); initialized = true; }, async (check) => {
    expect(await check()).toBe(false); expect(await check()).toBe(true);
  });
  expect(baseline).toMatchObject({ published: 10, returned: 2 });
  expect(calls).toEqual(['sample', 'append', 'sample', 'sample']);
});

test('already observed numericbaseline doesnot append metric warmup', async () => {
  const initialize = jest.fn(); const wait = jest.fn();
  expect(await returnBaseline({ sample: async () => publisherCounters([channel], scope) }, initialize, wait))
    .toMatchObject({ published: 10, returned: 2 });
  expect(initialize).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
});

test('failed append cannot manufacture a baseline or proceed to metric wait', async () => {
  const wait = jest.fn();
  await expect(returnBaseline({ sample: async () => null }, async () => { throw new Error('append_failed'); }, wait)).rejects.toThrow('append_failed');
  expect(wait).not.toHaveBeenCalled();
});
