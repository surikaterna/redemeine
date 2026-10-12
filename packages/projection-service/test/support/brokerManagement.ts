import type { ExternalConfig } from '../../src/infrastructure/mongo';
import type { BrokerManagement } from '../../src/infrastructure/management';
import type { OwnedConsumerIdentity } from '../../src/infrastructure/brokerIdentity';
import { bindingArguments, queueArguments } from '../../src/infrastructure/brokerTopology';
import { liveQueueName } from '../../src/infrastructure/rabbitChannel';

export class ManagementFixture implements BrokerManagement {
  queueValue: Record<string, unknown> | null = null;
  bindings: unknown[] = [];
  inbound: unknown[] = [];
  policies: unknown[] = [];
  operators: unknown[] = [];
  connection: Record<string, unknown> = {};
  readonly requests: string[][] = [];
  readonly exchange: Record<string, unknown>;
  failure: Error | undefined;
  gate: Promise<void> | undefined;

  constructor(readonly config: ExternalConfig) {
    this.exchange = { name: config.external.exchange, vhost: config.external.vhost, type: 'headers',
      durable: true, auto_delete: false, internal: false, arguments: {} };
  }

  declare(nonce: string): void {
    this.queueValue = { name: liveQueueName, vhost: this.config.external.vhost, type: 'quorum', durable: true,
      auto_delete: false, exclusive: false, arguments: queueArguments(nonce),
      consumer_details: [] };
    this.bindings = [this.binding('', liveQueueName, {})];
  }

  binding(source: string, key: string, args: unknown) {
    return { source, vhost: this.config.external.vhost, destination: liveQueueName, destination_type: 'queue', routing_key: key, arguments: args };
  }

  bind(): void { this.bindings.push(this.binding(this.config.external.exchange, '', bindingArguments(this.config))); }

  consume(tag: string, identity: OwnedConsumerIdentity): void {
    if (!this.queueValue) throw new Error('missing_queue');
    const connectionName = `${identity.peerHost}:${identity.peerPort} -> ${identity.host}:${identity.port}`;
    this.queueValue.consumer_details = [{ queue: { name: liveQueueName, vhost: this.config.external.vhost },
      consumer_tag: tag, active: true, ack_required: true, exclusive: false,
      prefetch_count: 1, arguments: {}, channel_details: { number: identity.channelNumber, connection_name: connectionName } }];
    this.queueValue.consumers = 1;
    this.connection = { name: connectionName, vhost: this.config.external.vhost, user: identity.user,
      peer_host: identity.peerHost, peer_port: identity.peerPort, host: identity.host, port: identity.port,
      client_properties: { connection_name: identity.connectionLabel } };
  }

  async get(segments: readonly string[]): Promise<unknown> {
    this.requests.push([...segments]);
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    const value = this.response(segments);
    return JSON.parse(JSON.stringify(value));
  }

  private response(parts: readonly string[]): unknown {
    if (parts[0] === 'queues') return parts.length === 3 ? this.queueValue : this.bindings;
    if (parts[0] === 'exchanges') return parts.length === 3 ? this.exchange : this.inbound;
    if (parts[0] === 'policies') return this.policies;
    if (parts[0] === 'operator-policies') return this.operators;
    if (parts[0] === 'connections') return this.connection;
    throw new Error('unexpected_management_query');
  }
}
