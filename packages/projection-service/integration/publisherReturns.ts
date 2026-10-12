import { isIP } from 'node:net';
import { exchangeName, publisherUsername, QualificationError } from './plan';
import { assert, isRecord, integer, record, string } from './schema';
import { sha256, type Receipts } from './receipts';
import type { BrokerHttp } from './http';

export interface PublisherScope { vhost: string; peerAddress: string }
export interface PublisherCounters { identity: string; published: number; returned: number }

function peerAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ip = value.startsWith('::ffff:') ? value.slice(7) : value;
  return isIP(ip) === 4 ? ip : undefined;
}

export function publisherCounters(rows: unknown, scope: PublisherScope): PublisherCounters | null {
  assert(Array.isArray(rows) && rows.length <= 16, 'publisher_channel_capacity_or_shape');
  if (!Array.isArray(rows)) throw new QualificationError('publisher_channel_capacity_or_shape');
  const selected = rows.filter((value: unknown) => isRecord(value) && value.vhost === scope.vhost && value.user === publisherUsername
    && isRecord(value.connection_details) && peerAddress(value.connection_details.peer_host) === scope.peerAddress);
  assert(selected.length <= 1, 'publisher_channel_ambiguous');
  if (selected.length === 0) return null;
  const channel = record(selected[0]); const connection = record(channel.connection_details);
  if (channel.confirm !== true || channel.state !== 'running') return null;
  const number = integer(channel.number); const port = integer(connection.peer_port);
  assert(number > 0 && number <= 65535 && port >= 1024 && port <= 65535, 'publisher_channel_socket_invalid');
  const identity = sha256(JSON.stringify([string(channel.name), string(connection.name), scope.vhost, publisherUsername,
    scope.peerAddress, port, number]));
  if (channel.message_stats === undefined) return null;
  const stats = record(channel.message_stats);
  if (stats.publish === undefined || stats.return_unroutable === undefined) return null;
  return { identity, published: integer(stats.publish), returned: integer(stats.return_unroutable) };
}

export function mandatoryReturnIncreased(before: PublisherCounters, after: PublisherCounters): boolean {
  assert(before.identity === after.identity, 'publisher_channel_identity_changed');
  assert(after.published >= before.published && after.returned >= before.returned, 'publisher_counters_reset');
  return after.published > before.published && after.returned > before.returned;
}

export async function returnBaseline(observer: Pick<PublisherReturns, 'sample'>, initializeMetrics: () => Promise<void>,
  wait: (check: () => Promise<boolean>) => Promise<void>): Promise<PublisherCounters> {
  let baseline = await observer.sample();
  if (baseline) return baseline;
  await initializeMetrics();
  await wait(async () => { baseline = await observer.sample(); return baseline !== null; });
  if (!baseline) throw new QualificationError('publisher_return_baseline_missing');
  return baseline;
}

export class PublisherReturns {
  constructor(private readonly broker: BrokerHttp, private readonly receipt: Receipts, private readonly scope: PublisherScope) {
    assert(isIP(scope.peerAddress) === 4, 'publisher_peer_address_invalid');
  }

  async sample(): Promise<PublisherCounters | null> {
    const exchange = record(await this.broker.request('GET', ['exchanges', this.scope.vhost, exchangeName]));
    assert(exchange.name === exchangeName && exchange.vhost === this.scope.vhost && exchange.type === 'headers'
      && exchange.durable === true && exchange.auto_delete === false && exchange.internal === false
      && Object.keys(record(exchange.arguments)).length === 0, 'publisher_exchange_scope_invalid');
    const destinations = await this.broker.request('GET', ['exchanges', this.scope.vhost, exchangeName, 'bindings', 'source']);
    assert(Array.isArray(destinations) && destinations.length === 0, 'publisher_destination_present_or_unproven');
    const counters = publisherCounters(await this.broker.request('GET', ['vhosts', this.scope.vhost, 'channels']), this.scope);
    this.receipt.provenance.publisherReturns = { metricSource: 'scoped_publisher_channel_totals', noDestinations: true,
      status: counters ? 'observed' : 'not_yet_observed', ...(counters ?? {}) };
    await this.receipt.save(); return counters;
  }
}
