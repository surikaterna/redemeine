import { describe, expect, it } from '@jest/globals';
import { proveMaterial, proveUnchanged } from '../integration/crashMaterialProof';
import { proveMismatchSignals, proveRecoverySignals } from '../integration/crashRecoveryProof';
import type { CrashSignal } from '../integration/crashIpc';
import { deriveTurnCommitId } from '@redemeine/saga-runtime';

const expected = { sagaId: 'saga', sagaKey: 'key', partition: 'partition', eventId: 'event',
  sourceTriggerId: 'trigger', sourcePartition: 'source-partition', sourceStream: 'source-stream',
  sourceCommit: 'source-commit', amount: 1 };
function row() {
  const id = deriveTurnCommitId({ sourceTriggerId: 'trigger', sagaKey: 'key', instanceId: 'saga', routeId: 'route' });
  return { id, partitionId: 'partition', streamId: 'saga', commitSequence: 0,
    sagaTurnIdentity: { instanceId: 'saga', sagaKey: 'key', sourceTriggerId: 'trigger', routeId: 'route' },
    events: [
      { id: `${id}:event:0`, version: 0, type: 'saga.instance_created.event', payload: { id: 'saga', lifecycleState: 'active' } },
      { id: `${id}:event:1`, version: 1, type: 'saga.definition_identity_recorded.event', payload: {
        sagaKey: 'key', schemaVersion: 1, definitionVersion: 1, policySha256: 'a'.repeat(64) } },
      { id: `${id}:event:2`, version: 2, type: 'saga.source_event_observed.event', payload: { record: {
        eventId: 'event', eventType: 'real.order-placed.v1.event',
        sourcePosition: { partitionId: 'source-partition', streamId: 'source-stream', commitId: 'source-commit', eventIndex: 0 },
        payload: { orderId: 'crash-order', amount: 1 } } } },
      { id: `${id}:event:3`, version: 3, type: 'saga.business_state_recorded.event', payload: {
        sagaKey: 'key', sourceTriggerId: 'trigger', schemaVersion: 1, definitionVersion: 1, state: { count: 0, seen: [] } } }
    ] };
}

const signals: CrashSignal[] = [
  { kind: 'delivery', messageId: 'source', redelivered: false },
  { kind: 'delivery', messageId: 'source', redelivered: true },
  { kind: 'processed', messageId: 'event', statuses: ['reconciled'] },
  { kind: 'ack', messageId: 'source' },
  { kind: 'delivery', messageId: 'source', attempt: 1, deaths: [{ queue: 'retry', reason: 'expired', count: 1 }] },
  { kind: 'processed', messageId: 'event', statuses: ['reconciled'] },
  { kind: 'ack', messageId: 'source' }
];

describe('offline crash recovery evidence', () => {
  it('validates actual full physical row and compares the exact stored content after recovery', () => {
    const original = [row()];
    expect(proveMaterial(original, expected)).toMatchObject({ physical: 1, intentFacts: 0, stateMatches: true });
    expect(() => proveUnchanged(original, structuredClone(original))).not.toThrow();
    expect(() => proveUnchanged(original, [row(), row()])).toThrow();
    expect(() => proveMaterial([row(), row()], expected)).toThrow();
    const wrong = row(); wrong.events[3]!.payload = { sagaKey: 'key', sourceTriggerId: 'trigger', definitionVersion: 1,
      state: { count: 99, seen: ['event'] } };
    expect(() => proveMaterial([wrong], expected)).toThrow();
    expect(() => proveUnchanged(original, [wrong])).toThrow();
    const intent = row(); intent.events.push({ id: 'turn:event:4', version: 4, type: 'saga.intent_recorded.event', payload: {} });
    expect(() => proveMaterial([intent], expected)).toThrow();
    const wrongIdentity = row(); wrongIdentity.sagaTurnIdentity.sourceTriggerId = 'different';
    expect(() => proveMaterial([wrongIdentity], expected)).toThrow();
  });

  it('fails closed on missing ACK, invalid death or attempt, and non-reconciled status', () => {
    expect(proveRecoverySignals(signals, 'source', 'event', 'retry')).toMatchObject({ acks: 2, deathCount: 1 });
    expect(() => proveRecoverySignals(signals.slice(0, -1), 'source', 'event', 'retry')).toThrow();
    const badDeath = structuredClone(signals); badDeath[4] = { kind: 'delivery', messageId: 'source', attempt: 1,
      deaths: [{ queue: 'retry', reason: 'rejected', count: 1 }] };
    expect(() => proveRecoverySignals(badDeath, 'source', 'event', 'retry')).toThrow();
    badDeath[4] = { kind: 'delivery', messageId: 'source', attempt: 2,
      deaths: [{ queue: 'retry', reason: 'expired', count: 1 }] };
    expect(() => proveRecoverySignals(badDeath, 'source', 'event', 'retry')).toThrow();
    badDeath[5] = { kind: 'processed', messageId: 'event', statuses: ['committed'] };
    expect(() => proveRecoverySignals(badDeath, 'source', 'event', 'retry')).toThrow();
  });

  it('requires permanent DLQ confirmation before the third ACK', () => {
    expect(() => proveMismatchSignals([...signals, { kind: 'dead', messageId: 'source' },
      { kind: 'ack', messageId: 'source' }], 'source')).not.toThrow();
    expect(() => proveMismatchSignals([...signals, { kind: 'ack', messageId: 'source' }], 'source')).toThrow();
    expect(() => proveMismatchSignals([...signals, { kind: 'ack', messageId: 'source' },
      { kind: 'dead', messageId: 'source' }], 'source')).toThrow();
  });
});
