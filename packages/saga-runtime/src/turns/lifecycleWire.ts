import { isDeepStrictEqual } from 'node:util';
import { validateBusinessState } from '../businessStateValidation';
import { type SagaCanonicalCorrelation, serializeSagaCorrelation } from '../identity/canonicalCorrelation';
import { deriveSagaInstanceId, deriveSourceTriggerId, deriveTurnCommitId, type SourceTriggerIdentityInput } from '../identity/deterministicIds';
import { decodeIntent, decodeOutcome, type WireIntent, type WireOutcome, type WireRegistryEntry } from '../intentWire';

// Additive private contract: the PR111 aggregate does not emit or project these records.
export interface LifecycleTurnV1 {
  readonly schemaVersion: 1;
  readonly kind: 'saga.lifecycle.turn';
  readonly instanceId: string;
  readonly commitId: string;
  readonly sagaKey: string;
  readonly definitionVersion: number;
  readonly correlation: SagaCanonicalCorrelation;
  readonly source: SourceTriggerIdentityInput;
  readonly sourceTriggerId: string;
  readonly routeId: string;
  readonly state: unknown;
  readonly intents: readonly WireIntent[];
  readonly timers: readonly TimerFactV1[];
  readonly terminal?: 'completed' | 'failed' | 'cancelled';
}

export type TimerFactV1 =
  | { readonly intentId: string; readonly action: 'schedule'; readonly timerId: string; readonly dueAt: string }
  | { readonly intentId: string; readonly action: 'cancelSchedule'; readonly timerId: string };

export type LifecycleProgressV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: 'saga.lifecycle.claim';
      readonly intentId: string;
      readonly instanceId: string;
      readonly epoch: number;
      readonly owner: string;
      readonly expiresAt: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: 'saga.lifecycle.outcome';
      readonly intentId: string;
      readonly instanceId: string;
      readonly outcome: WireOutcome;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: 'saga.lifecycle.continuation';
      readonly intentId: string;
      readonly instanceId: string;
      readonly outcome: WireOutcome;
      readonly status: 'applied' | 'failed';
    };

// This is a new, distinct event type. Legacy businessStateRecorded/intentLifecycleRecorded
// are never decoded as lifecycle turns or interpreted as executable intents.
export const LIFECYCLE_TURN_EVENT_TYPE = 'saga.lifecycle.turn.v1.event';

const MAX_TURN_BYTES = 8 * 1024 * 1024;
const MAX_PROGRESS_BYTES = 65536;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('invalid lifecycle record');
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    throw new TypeError('invalid lifecycle fields');
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new TypeError('invalid lifecycle text');
  return value;
}

function timestamp(value: unknown): string {
  const date = text(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date)
    throw new TypeError('invalid lifecycle timestamp');
  return date;
}

function bounded(value: unknown, maxBytes: number): void {
  validateBusinessState(value, { maxBytes, maxDepth: 32, maxNodes: 100_000 });
}

function validateTimers(value: unknown, intents: readonly WireIntent[]): TimerFactV1[] {
  if (!Array.isArray(value)) throw new TypeError('invalid timer facts');
  const expected = intents.filter((intent) => intent.kind === 'schedule' || intent.kind === 'cancelSchedule');
  if (value.length !== expected.length) throw new TypeError('timer fact count mismatch');
  return expected.map((intent, index) => {
    const fact = record(value[index]);
    const action = intent.kind;
    fields(fact, action === 'schedule' ? ['intentId', 'action', 'timerId', 'dueAt'] : ['intentId', 'action', 'timerId']);
    if (
      fact.intentId !== intent.intentId ||
      fact.action !== action ||
      fact.timerId !== intent.timerId ||
      (action === 'schedule' && fact.dueAt !== intent.dueAt)
    )
      throw new TypeError('timer fact mismatch');
    return action === 'schedule'
      ? { intentId: intent.intentId, action, timerId: intent.timerId, dueAt: intent.dueAt }
      : { intentId: intent.intentId, action, timerId: intent.timerId };
  });
}

function decodeCorrelation(value: unknown): SagaCanonicalCorrelation {
  const correlation = record(value);
  fields(correlation, ['type', 'value']);
  const canonical: SagaCanonicalCorrelation =
    correlation.type === 'string' && typeof correlation.value === 'string'
      ? { type: 'string', value: correlation.value }
      : correlation.type === 'number' && typeof correlation.value === 'number'
        ? { type: 'number', value: correlation.value }
        : (() => {
            throw new TypeError('invalid lifecycle correlation');
          })();
  serializeSagaCorrelation(canonical);
  return canonical;
}

function decodeSource(value: unknown): SourceTriggerIdentityInput {
  const source = record(value);
  fields(source, ['partitionId', 'streamId', 'commitId', 'eventIndex']);
  const position: SourceTriggerIdentityInput = {
    partitionId: text(source.partitionId),
    streamId: text(source.streamId),
    commitId: text(source.commitId),
    eventIndex: typeof source.eventIndex === 'number' ? source.eventIndex : Number.NaN
  };
  deriveSourceTriggerId(position);
  return position;
}

function decodeTurnIdentity(v: Record<string, unknown>) {
  const sagaKey = text(v.sagaKey);
  const correlation = decodeCorrelation(v.correlation);
  const instanceId = deriveSagaInstanceId(sagaKey, correlation);
  const source = decodeSource(v.source);
  const sourceTriggerId = deriveSourceTriggerId(source);
  const routeId = text(v.routeId);
  const commitId = deriveTurnCommitId({ sagaKey, instanceId, sourceTriggerId, routeId });
  if (v.instanceId !== instanceId || v.commitId !== commitId || v.sourceTriggerId !== sourceTriggerId) throw new TypeError('lifecycle identity mismatch');
  return { sagaKey, correlation, instanceId, source, sourceTriggerId, routeId, commitId };
}

function decodeOrderedIntents(
  v: Record<string, unknown>,
  identity: ReturnType<typeof decodeTurnIdentity>,
  registry: readonly WireRegistryEntry[]
): WireIntent[] {
  const { sagaKey, correlation, instanceId, sourceTriggerId, routeId } = identity;
  if (!Array.isArray(v.intents)) throw new TypeError('invalid intents');
  const intents = v.intents.map((intent) => decodeIntent(intent, registry));
  for (const [ordinal, intent] of intents.entries()) {
    if (
      intent.origin.ordinal !== ordinal ||
      intent.origin.sagaKey !== sagaKey ||
      serializeSagaCorrelation(intent.origin.correlation) !== serializeSagaCorrelation(correlation) ||
      intent.origin.sourceId !== sourceTriggerId ||
      intent.origin.routeId !== routeId ||
      intent.instanceId !== instanceId
    )
      throw new TypeError('lifecycle intent origin/order mismatch');
  }
  return intents;
}

export function decodeLifecycleTurn(value: unknown, registry: readonly WireRegistryEntry[]): LifecycleTurnV1 {
  bounded(value, MAX_TURN_BYTES);
  const v = record(value);
  fields(
    v,
    [
      'schemaVersion',
      'kind',
      'instanceId',
      'commitId',
      'sagaKey',
      'definitionVersion',
      'correlation',
      'source',
      'sourceTriggerId',
      'routeId',
      'state',
      'intents',
      'timers'
    ],
    ['terminal']
  );
  if (v.schemaVersion !== 1 || v.kind !== 'saga.lifecycle.turn') throw new TypeError('unsupported lifecycle turn version or kind');
  const identity = decodeTurnIdentity(v);
  if (typeof v.definitionVersion !== 'number' || !Number.isSafeInteger(v.definitionVersion) || v.definitionVersion < 1)
    throw new TypeError('invalid definition version');
  const intents = decodeOrderedIntents(v, identity, registry);
  const timers = validateTimers(v.timers, intents);
  if (v.terminal !== undefined && v.terminal !== 'completed' && v.terminal !== 'failed' && v.terminal !== 'cancelled')
    throw new TypeError('invalid terminal status');
  return {
    schemaVersion: 1,
    kind: 'saga.lifecycle.turn',
    ...identity,
    definitionVersion: v.definitionVersion,
    state: v.state,
    intents,
    timers,
    ...(v.terminal === undefined ? {} : { terminal: v.terminal })
  } as LifecycleTurnV1;
}

export function assertLifecycleVersion(turn: LifecycleTurnV1, activeDefinitionVersion: number): void {
  if (turn.definitionVersion !== activeDefinitionVersion) throw new TypeError('definition_version_migration_unsupported');
}

export function equivalentLifecycleTurn(left: unknown, right: unknown, registry: readonly WireRegistryEntry[]): boolean {
  return isDeepStrictEqual(decodeLifecycleTurn(left, registry), decodeLifecycleTurn(right, registry));
}

export function decodeLifecycleProgress(value: unknown, intent: WireIntent): LifecycleProgressV1 {
  bounded(value, MAX_PROGRESS_BYTES);
  const v = record(value);
  if (v.schemaVersion !== 1 || v.intentId !== intent.intentId || v.instanceId !== intent.instanceId) throw new TypeError('progress identity/version mismatch');
  if (v.kind === 'saga.lifecycle.claim') {
    fields(v, ['schemaVersion', 'kind', 'intentId', 'instanceId', 'epoch', 'owner', 'expiresAt']);
    if (typeof v.epoch !== 'number' || !Number.isSafeInteger(v.epoch) || v.epoch < 1) throw new TypeError('invalid claim epoch');
    return {
      schemaVersion: 1,
      kind: v.kind,
      intentId: intent.intentId,
      instanceId: intent.instanceId,
      epoch: v.epoch,
      owner: text(v.owner),
      expiresAt: timestamp(v.expiresAt)
    };
  }
  if (v.kind !== 'saga.lifecycle.outcome' && v.kind !== 'saga.lifecycle.continuation') throw new TypeError('unknown lifecycle progress kind');
  fields(v, ['schemaVersion', 'kind', 'intentId', 'instanceId', 'outcome'], v.kind === 'saga.lifecycle.continuation' ? ['status'] : []);
  const outcome = decodeOutcome(v.outcome, intent);
  if (v.kind === 'saga.lifecycle.outcome') return { schemaVersion: 1, kind: v.kind, intentId: intent.intentId, instanceId: intent.instanceId, outcome };
  if (v.status !== 'applied' && v.status !== 'failed') throw new TypeError('invalid continuation status');
  return { schemaVersion: 1, kind: v.kind, intentId: intent.intentId, instanceId: intent.instanceId, outcome, status: v.status };
}
