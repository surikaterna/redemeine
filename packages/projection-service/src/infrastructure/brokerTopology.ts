import type { ExternalConfig } from './mongo';
import type { BrokerManagement } from './management';
import type { OwnedConsumerIdentity } from './brokerIdentity';
import { socketHost } from './brokerIdentity';
import { object, list, same, string, BrokerRefusal } from './brokerSchema';
import { liveQueueName } from './rabbitChannel';
import { consumerFacts, type ConsumerFacts } from './consumerFacts';
import { observeStartup } from '../startupDiagnostics';

export function queueArguments(nonce: string) {
  return { 'x-queue-type': 'quorum', 'x-single-active-consumer': true, 'x-delivery-limit': -1, 'x-redemeine-bootstrap-id': nonce };
}

export function bindingArguments(config: ExternalConfig) {
  return { 'x-match': 'all', collection: config.external.collection, partitionId: config.external.partitionId,
    ...(config.external.tenant === undefined ? {} : { tenant: config.external.tenant }) };
}

export class BrokerTopology {
  constructor(private readonly config: ExternalConfig, private readonly management: BrokerManagement,
    private readonly observe?: (facts: ConsumerFacts) => void) {}

  async queue(): Promise<unknown> { return this.management.get(['queues', this.config.external.vhost, liveQueueName], true); }

  async checkExchange(): Promise<void> {
    const { vhost, exchange } = this.config.external;
    const value = object(await this.management.get(['exchanges', vhost, exchange]));
    same([value.name, value.vhost, value.type, value.durable, value.auto_delete, value.internal], [exchange, vhost, 'headers', true, false, false]);
    same(object(value.arguments), {});
    same(list(await this.management.get(['exchanges', vhost, exchange, 'bindings', 'destination'])), []);
    // A dedicated policy-free vhost avoids guessing Rabbit/Erlang policy precedence or regex semantics.
    same(list(await this.management.get(['policies', vhost])), [], 'broker_policy_unproven');
    same(list(await this.management.get(['operator-policies', vhost])), [], 'broker_policy_unproven');
  }

  async inspect(nonce: string, consumer?: { tag: string; identity: OwnedConsumerIdentity }, initial = false): Promise<void> {
    await this.checkExchange();
    const queue = object(await this.queue(), 'broker_queue_response_invalid');
    same([queue.name, queue.vhost, queue.type, queue.durable, queue.exclusive, queue.auto_delete],
      [liveQueueName, this.config.external.vhost, 'quorum', true, false, false]);
    same(object(queue.arguments, 'broker_queue_arguments_invalid'), queueArguments(nonce));
    if (!absentPolicy(queue, 'policy') || !absentPolicy(queue, 'operator_policy')) {
      throw new BrokerRefusal('broker_policy_unproven');
    }
    // Cold quorum queues have no statistics yet; policy absence is proved above, not by missing stats.
    if (Object.hasOwn(queue, 'effective_policy_definition')) {
      same(object(queue.effective_policy_definition, 'broker_queue_effective_policy_invalid'), {}, 'broker_queue_effective_policy_invalid');
    }
    await this.bindings();
    const consumers = list(queue.consumer_details, 16, 'broker_queue_consumer_details_invalid');
    observeStartup(() => this.observe?.(consumerFacts(queue, consumers, consumer?.tag)), 'consumer_start');
    if (consumer) {
      checkConsumerCount(queue);
      // Initial statistics may be absent or ahead of consumer details; neither observation proves admission.
      if (initial && consumers.length === 0) throw new BrokerRefusal('broker_consumer_count_pending');
      await this.consumer(consumers, consumer.tag, consumer.identity);
    }
    else same(consumers, [], 'broker_consumer_conflict');
  }

  private async bindings(): Promise<void> {
    const { vhost, exchange } = this.config.external;
    const bindings = list(await this.management.get(['queues', vhost, liveQueueName, 'bindings']));
    let application = 0;
    let defaultExchange = 0;
    for (const value of bindings) {
      const binding = object(value);
      same([binding.vhost, binding.destination, binding.destination_type], [vhost, liveQueueName, 'queue']);
      if (binding.source === '') {
        same([binding.routing_key, object(binding.arguments)], [liveQueueName, {}]);
        defaultExchange += 1;
      } else {
        same([binding.source, binding.routing_key, object(binding.arguments)], [exchange, '', bindingArguments(this.config)]);
        application += 1;
      }
    }
    same([application, defaultExchange], [1, 1], 'broker_binding_mismatch');
  }

  private async consumer(values: unknown[], tag: string, identity: OwnedConsumerIdentity): Promise<void> {
    if (values.length !== 1) throw new BrokerRefusal('broker_consumer_conflict');
    const value = object(values[0], 'broker_queue_consumer_details_invalid');
    same([object(value.queue).name, object(value.queue).vhost], [liveQueueName, this.config.external.vhost], 'broker_consumer_queue_mismatch');
    same(value.consumer_tag, tag, 'broker_consumer_tag_mismatch');
    same(value.active, true, 'broker_consumer_active_mismatch');
    same(value.ack_required, true, 'broker_consumer_ack_mismatch');
    same(value.exclusive, false, 'broker_consumer_exclusive_mismatch');
    same(value.prefetch_count, 1, 'broker_consumer_prefetch_mismatch');
    same(object(value.arguments), {}, 'broker_consumer_arguments_mismatch');
    const details = object(value.channel_details, 'broker_consumer_channel_mismatch');
    same(details.number, identity.channelNumber, 'broker_consumer_channel_mismatch');
    const connectionName = string(details.connection_name);
    const connection = object(await this.management.get(['connections', connectionName]));
    same([connection.name, connection.vhost, connection.user], [connectionName, this.config.external.vhost, identity.user], 'broker_consumer_connection_mismatch');
    same(object(connection.client_properties).connection_name, identity.connectionLabel, 'broker_consumer_connection_mismatch');
    same([socketHost(connection.peer_host), connection.peer_port, socketHost(connection.host), connection.port],
      [identity.peerHost, identity.peerPort, identity.host, identity.port], 'broker_consumer_connection_mismatch');
  }
}

function checkConsumerCount(queue: Record<string, unknown>): void {
  if (!Object.hasOwn(queue, 'consumers')) return;
  const count = queue.consumers;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new BrokerRefusal('broker_consumer_count_inconsistent');
  if (count > 1) throw new BrokerRefusal('broker_consumer_conflict');
}

function absentPolicy(queue: Record<string, unknown>, field: 'policy' | 'operator_policy'): boolean {
  // RabbitMQ 4.1.4 basic queue stats omit empty policies; full stats can encode them as null.
  return !Object.hasOwn(queue, field) || queue[field] === null || queue[field] === '';
}
