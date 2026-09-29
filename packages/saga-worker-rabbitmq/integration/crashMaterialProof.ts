import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BSON } from 'mongodb';
import { deriveTurnCommitId } from '@redemeine/saga-runtime';

type Row = Record<string, unknown>;
type EventRow = { type: string; payload: unknown; id: string; version: number };
const types = ['saga.instance_created.event', 'saga.definition_identity_recorded.event',
  'saga.source_event_observed.event', 'saga.business_state_recorded.event'];

function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid physical material');
  return value as Row;
}

function same(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error('physical material differs from expected fixture');
}

export function proveMaterial(rows: readonly unknown[], expected: { sagaId: string; sagaKey: string;
  partition: string; eventId: string; sourceTriggerId: string; sourcePartition: string;
  sourceStream: string; sourceCommit: string; amount: number }): { physical: number; intentFacts: number;
  stateMatches: boolean; materialSha256: string } {
  if (rows.length !== 1) throw new Error('unexpected physical turn count');
  const row = record(rows[0]);
  const identity = record(row.sagaTurnIdentity);
  const events = row.events;
  if (!Array.isArray(events) || events.length !== types.length) throw new Error('unexpected saga event count');
  const facts = events.map(record) as EventRow[];
  same(facts.map(event => event.type), types);
  same(facts.map(event => event.version), [0, 1, 2, 3]);
  if (typeof row.id !== 'string' || !row.id || row.commitSequence !== 0 || row.streamId !== expected.sagaId ||
      row.partitionId !== expected.partition || identity.instanceId !== expected.sagaId ||
      identity.sagaKey !== expected.sagaKey || identity.sourceTriggerId !== expected.sourceTriggerId ||
      typeof identity.routeId !== 'string' || !identity.routeId ||
      facts.some((event, index) => event.id !== `${row.id}:event:${index}`)) {
    throw new Error('physical turn identity differs');
  }
  same(row.id, deriveTurnCommitId({ sourceTriggerId: expected.sourceTriggerId, sagaKey: expected.sagaKey,
    instanceId: expected.sagaId, routeId: identity.routeId }));
  const created = record(facts[0]!.payload);
  if (created.id !== expected.sagaId || created.lifecycleState !== 'active') {
    throw new Error('instance creation differs');
  }
  const definition = record(facts[1]!.payload);
  if (definition.sagaKey !== expected.sagaKey || definition.schemaVersion !== 1 ||
      definition.definitionVersion !== 1 || typeof definition.policySha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(definition.policySha256)) throw new Error('definition identity differs');
  const observed = record(facts[2]!.payload);
  const source = record(observed.record);
  same(source.sourcePosition, { partitionId: expected.sourcePartition, streamId: expected.sourceStream,
    commitId: expected.sourceCommit, eventIndex: 0 });
  same({ eventId: source.eventId, eventType: source.eventType, payload: source.payload },
    { eventId: expected.eventId, eventType: 'real.order-placed.v1.event',
      payload: { orderId: 'crash-order', amount: expected.amount } });
  const business = record(facts[3]!.payload);
  same(business.state, { count: 0, seen: [] });
  if (business.sagaKey !== expected.sagaKey || business.sourceTriggerId !== expected.sourceTriggerId ||
      business.definitionVersion !== 1 || business.schemaVersion !== 1) throw new Error('business state identity differs');
  const intentFacts = facts.filter(event => event.type === 'saga.intent_recorded.event' ||
    event.type === 'saga.timer_fact_recorded.event').length;
  return { physical: rows.length, intentFacts, stateMatches: true,
    materialSha256: createHash('sha256').update(BSON.EJSON.stringify(rows)).digest('hex') };
}

export function proveUnchanged(before: readonly unknown[], after: readonly unknown[]): void {
  if (BSON.EJSON.stringify(after) !== BSON.EJSON.stringify(before)) {
    throw new Error('physical material changed or extra turn appended');
  }
}
