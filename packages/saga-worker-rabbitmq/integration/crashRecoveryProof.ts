import { isDeepStrictEqual } from 'node:util';
import type { CrashSignal } from './crashIpc';

export function proveRecoverySignals(trace: readonly CrashSignal[], messageId: string, eventId: string, retryQueue: string) {
  const acks = trace.filter(event => event.kind === 'ack' && event.messageId === messageId);
  const deliveries = trace.filter((event): event is Exclude<CrashSignal, { kind: 'error' }> =>
    event.kind === 'delivery' && event.messageId === messageId);
  const statuses = trace.filter((event): event is Exclude<CrashSignal, { kind: 'error' }> =>
    event.kind === 'processed' && event.messageId === eventId);
  if (acks.length !== 2 || deliveries.length !== 3 || deliveries[1]?.redelivered !== true ||
      deliveries[1]?.attempt !== undefined || !isDeepStrictEqual(statuses.map(event => event.statuses),
        [['reconciled'], ['reconciled']])) throw new Error('recovery delivery or settlement differs');
  const returned = deliveries[2];
  const deaths = returned?.deaths;
  if (returned?.attempt !== 1 || !Array.isArray(deaths) || deaths.length !== 1 ||
      !deaths[0] || typeof deaths[0] !== 'object' || Array.isArray(deaths[0]) ||
      deaths[0].queue !== retryQueue || deaths[0].reason !== 'expired' || deaths[0].count !== 1) {
    throw new Error('TTL death or attempt differs');
  }
  return { acks: acks.length, deliveries: deliveries.length, statuses: statuses.length,
    redelivered: true, attempt: returned.attempt, deathCount: deaths[0].count as number };
}

export function proveMismatchSignals(trace: readonly CrashSignal[], messageId: string): void {
  const dead = trace.findIndex(event => event.kind === 'dead' && event.messageId === messageId);
  const acks = trace.flatMap((event, index) => event.kind === 'ack' && event.messageId === messageId ? [index] : []);
  if (dead < 0 || acks.length !== 3 || acks[2]! <= dead) throw new Error('mismatch DLQ confirmation or ACK absent');
}
