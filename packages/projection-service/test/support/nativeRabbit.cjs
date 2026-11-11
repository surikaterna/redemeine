const { Duplex } = require('node:stream');
const { dirname, join } = require('node:path');
const root = dirname(require.resolve('amqplib'));
const { Connection } = require(join(root, 'lib/connection.js'));
const { ChannelModel } = require(join(root, 'lib/channel_model.js'));
const defs = require(join(root, 'lib/defs.js'));

// Only broker handshake frames are supplied; close/cancel state transitions remain pinned native code.
function createNativeRabbit(options = {}) {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  Object.assign(stream, { localAddress: '127.0.0.1', localPort: options.localPort ?? 12345,
    remoteAddress: '127.0.0.1', remotePort: 5672 });
  const connection = new Connection(stream);
  const model = new ChannelModel(connection);
  const channels = [];
  const frames = [];
  let channelClosed = false;
  let connectionClosed = false;
  model.on('close', () => { connectionClosed = true; options.onClose?.(); });
  model.on('error', () => {});
  connection.sendMethod = offlineFrames(connection, options, channels, frames, () => { channelClosed = true; });
  return { model, channels, frames, version: require(join(root, 'package.json')).version,
    closeConnection() { connection.toClosed('offline-socket-failure', new Error('simulated socket failure')); },
    closeChannel() { channels[0].toClosed('offline-channel-failure'); },
    deliver(message) { channels[0].emit('delivery', message); },
    state() { return { channelClosed, connectionClosed, network: false }; }
  };
}

function offlineFrames(connection, options, channels, frames, closed) {
  const closedChannels = new Set();
  return (number, method, fields) => {
    frames.push({ number, method: defs.info(method).name });
    if (method === defs.ConnectionClose) {
      if (!options.suspendClose) queueMicrotask(() => {
        if (!connection.expectSocketClose) connection.accept({ id: defs.ConnectionCloseOk, fields: {} });
      });
      return;
    }
    if (method === defs.BasicAck) return;
    const channel = connection.channels[number].channel;
    if (method === defs.ChannelOpen) {
      channels.push(channel);
      channel.on('close', () => { closedChannels.add(channel); closed(); });
      channel.on('error', () => {});
    }
    let reply;
    let result = {};
    if (method === defs.ChannelOpen) reply = defs.ChannelOpenOk;
    else if (method === defs.QueueDeclare) {
      if (!fields.passive) options.onDeclare?.(fields.arguments);
      reply = defs.QueueDeclareOk; result = { queue: fields.queue, messageCount: 0, consumerCount: 0 };
    } else if (method === defs.QueueBind) { options.onBind?.(); reply = defs.QueueBindOk; }
    else if (method === defs.BasicQos) reply = defs.BasicQosOk;
    else if (method === defs.BasicConsume) {
      options.onConsume?.('native-consumer', number); reply = defs.BasicConsumeOk; result = { consumerTag: 'native-consumer' };
    } else if (method === defs.BasicCancel) { reply = defs.BasicCancelOk; result = { consumerTag: fields.consumerTag }; }
    else if (method === defs.ChannelClose) { if (!options.suspendClose) reply = defs.ChannelCloseOk; }
    else throw new Error(`unexpected_offline_frame:${defs.info(method).name}`);
    if (reply) queueMicrotask(() => { if (!closedChannels.has(channel)) channel.accept({ id: reply, fields: result }); });
  };
}

module.exports = { createNativeRabbit };
