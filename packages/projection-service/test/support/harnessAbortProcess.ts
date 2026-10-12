import { publishMalformed } from '../../integration/transportFaults';
import { finalProcessGuard, independentlyCleanup } from '../../integration/cancellation';
import { OfflineConnection } from './offlineTransport';

const connection = new OfflineConnection(); connection.channel.neverClose = true; connection.neverClose = true;
const controller = new AbortController(); const unjoined: string[] = [];
setInterval(() => {}, 1000);
const work = independentlyCleanup(() => publishMalformed('amqp://127.0.0.1:1/', 'offline-source', controller.signal,
  { connect: async () => connection, unjoined: (label) => unjoined.push(label) }),
async () => { console.log(JSON.stringify({ cleanupEntered: true, published: connection.channel.published, network: false, docker: false })); },
controller.signal, performance.now() + 1000, (label) => unjoined.push(label));
setImmediate(() => controller.abort());
await work.catch(() => {});
process.exitCode = 1;
finalProcessGuard(1, (code) => process.exit(code), () => console.log(JSON.stringify({ guardFired: true, unjoined })));
