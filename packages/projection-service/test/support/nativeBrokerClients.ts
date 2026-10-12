import type { RabbitConnector } from '../../src/infrastructure/rabbit';
import { brokerClients } from './brokerClients';
import { createNativeRabbit, type NativeRabbitFixture } from './nativeRabbit.cjs';

export function nativeBrokerClients(suspendClose = false) {
  const clients = brokerClients();
  const natives: NativeRabbitFixture[] = [];
  clients.message.fields.consumerTag = 'native-consumer';
  const rabbit: RabbitConnector = async (_uri, options) => {
    const peerPort = 12345 + natives.length;
    const native = createNativeRabbit({ localPort: peerPort, suspendClose,
      onDeclare: (args) => {
        const nonce = args['x-redemeine-bootstrap-id'];
        if (typeof nonce !== 'string') throw new Error('missing_nonce');
        clients.management.declare(nonce);
      },
      onBind: () => clients.management.bind(),
      onConsume: (tag, channelNumber) => clients.management.consume(tag, {
        connectionLabel: options.clientProperties?.connection_name ?? '', channelNumber,
        peerHost: '127.0.0.1', peerPort, host: '127.0.0.1', port: 5672, user: 'user'
      }),
      onClose: () => { if (clients.management.queueValue) clients.management.queueValue.consumer_details = []; }
    });
    natives.push(native);
    return native.model;
  };
  return { ...clients, natives, factories: { ...clients.factories, rabbit } };
}
