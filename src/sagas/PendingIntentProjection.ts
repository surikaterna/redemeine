import type { SagaCommandMap, SagaIntent } from './createSaga';
import type {
  SagaIntentDeadLetteredEvent,
  SagaIntentDispatchedEvent,
  SagaIntentFailedEvent,
  SagaIntentRecordedEvent,
  SagaIntentRetryScheduledEvent,
  SagaIntentStartedEvent,
  SagaIntentSucceededEvent,
  SagaLifecycleEvent
} from './SagaEventStore';

export type PendingIntentStatus = 'pending' | 'started' | 'dispatched' | 'succeeded' | 'failed';

export interface PendingIntentRecord<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  readonly intentKey: string;
  readonly sagaStreamId: string;
  readonly idempotencyKey: string;
  readonly intent: SagaIntent<TCommandMap>;
  readonly recordedAt: string;
  readonly dueAt: string;
  readonly status: PendingIntentStatus;
  readonly startedAt?: string;
  readonly succeededAt?: string;
  readonly failedAt?: string;
}

export interface PendingIntentQuery {
  readonly statuses?: readonly PendingIntentStatus[];
  readonly dueAtBeforeOrEqual?: string | Date;
  readonly dueAtAfterOrEqual?: string | Date;
}

interface MutablePendingIntentRecord<TCommandMap extends SagaCommandMap> {
  intentKey: string;
  sagaStreamId: string;
  idempotencyKey: string;
  intent: SagaIntent<TCommandMap>;
  recordedAt: string;
  dueAt: string;
  status: PendingIntentStatus;
  startedAt?: string;
  succeededAt?: string;
  failedAt?: string;
}

type SagaLifecycleEventsByIntentKey =
  | SagaIntentStartedEvent
  | SagaIntentDispatchedEvent
  | SagaIntentSucceededEvent
  | SagaIntentFailedEvent
  | SagaIntentRetryScheduledEvent
  | SagaIntentDeadLetteredEvent;

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function dueAtFromRecordedEvent<TCommandMap extends SagaCommandMap>(
  event: SagaIntentRecordedEvent<TCommandMap>
): string {
  if (event.intent.type !== 'schedule') {
    return event.recordedAt;
  }

  const recordedAtMs = Date.parse(event.recordedAt);

  if (Number.isNaN(recordedAtMs)) {
    return event.recordedAt;
  }

  return new Date(recordedAtMs + event.intent.delay).toISOString();
}

function cloneRecord<TCommandMap extends SagaCommandMap>(
  intent: MutablePendingIntentRecord<TCommandMap>
): PendingIntentRecord<TCommandMap> {
  return {
    ...intent
  };
}

/**
 * S11 pending-intent read model that projects recorded and lifecycle events
 * into queryable intent execution state.
 */
export class PendingIntentProjection<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  private readonly intentsByKey = new Map<string, MutablePendingIntentRecord<TCommandMap>>();

  private readonly deferredLifecycleByIntentKey = new Map<string, SagaLifecycleEventsByIntentKey[]>();

  projectRecordedEvent(event: SagaIntentRecordedEvent<TCommandMap>): void {
    const intentKey = event.idempotencyKey;
    const projected: MutablePendingIntentRecord<TCommandMap> = {
      intentKey,
      sagaStreamId: event.sagaStreamId,
      idempotencyKey: event.idempotencyKey,
      intent: event.intent,
      recordedAt: event.recordedAt,
      dueAt: dueAtFromRecordedEvent(event),
      status: 'pending'
    };

    this.intentsByKey.set(intentKey, projected);

    const deferred = this.deferredLifecycleByIntentKey.get(intentKey);
    if (deferred) {
      for (const lifecycleEvent of deferred) {
        this.applyLifecycleEvent(projected, lifecycleEvent);
      }

      this.deferredLifecycleByIntentKey.delete(intentKey);
    }
  }

  projectLifecycleEvent(event: SagaLifecycleEvent): void {
    const intentKey = event.lifecycle.intentKey;
    const current = this.intentsByKey.get(intentKey);

    if (!current) {
      const deferred = this.deferredLifecycleByIntentKey.get(intentKey) ?? [];
      deferred.push(event);
      this.deferredLifecycleByIntentKey.set(intentKey, deferred);
      return;
    }

    this.applyLifecycleEvent(current, event);
  }

  projectEvents(
    recordedEvents: readonly SagaIntentRecordedEvent<TCommandMap>[],
    lifecycleEvents: readonly SagaLifecycleEvent[]
  ): void {
    for (const event of recordedEvents) {
      this.projectRecordedEvent(event);
    }

    for (const event of lifecycleEvents) {
      this.projectLifecycleEvent(event);
    }
  }

  getByIntentKey(intentKey: string): PendingIntentRecord<TCommandMap> | undefined {
    const projected = this.intentsByKey.get(intentKey);
    return projected ? cloneRecord(projected) : undefined;
  }

  query(query: PendingIntentQuery = {}): PendingIntentRecord<TCommandMap>[] {
    const statuses = query.statuses ? new Set(query.statuses) : null;
    const dueAtBefore = query.dueAtBeforeOrEqual ? toIsoString(query.dueAtBeforeOrEqual) : null;
    const dueAtAfter = query.dueAtAfterOrEqual ? toIsoString(query.dueAtAfterOrEqual) : null;

    const filtered = Array.from(this.intentsByKey.values()).filter(intent => {
      if (statuses && !statuses.has(intent.status)) {
        return false;
      }

      if (dueAtBefore && intent.dueAt > dueAtBefore) {
        return false;
      }

      if (dueAtAfter && intent.dueAt < dueAtAfter) {
        return false;
      }

      return true;
    });

    return filtered
      .sort((left, right) => {
        if (left.dueAt === right.dueAt) {
          return left.intentKey.localeCompare(right.intentKey);
        }

        return left.dueAt.localeCompare(right.dueAt);
      })
      .map(cloneRecord);
  }

  getExecutablePendingIntents(now: string | Date = new Date()): PendingIntentRecord<TCommandMap>[] {
    return this.query({
      statuses: ['pending'],
      dueAtBeforeOrEqual: now
    });
  }

  private applyLifecycleEvent(
    current: MutablePendingIntentRecord<TCommandMap>,
    event: SagaLifecycleEventsByIntentKey
  ): void {
    if (event.type === 'saga.intent-started') {
      current.status = 'started';
      current.startedAt = event.startedAt;
      return;
    }

    if (event.type === 'saga.intent-succeeded') {
      current.status = 'succeeded';
      current.succeededAt = event.succeededAt;
      return;
    }

    if (event.type === 'saga.intent-dispatched') {
      current.status = 'dispatched';
      return;
    }

    if (event.type === 'saga.intent-retry-scheduled') {
      current.status = 'pending';
      current.dueAt = event.retry.nextAttemptAt;
      return;
    }

    if (event.type === 'saga.intent-dead-lettered') {
      current.status = 'failed';
      current.failedAt = event.deadLetteredAt;
      return;
    }

    current.status = 'failed';
    current.failedAt = event.failedAt;
  }
}
