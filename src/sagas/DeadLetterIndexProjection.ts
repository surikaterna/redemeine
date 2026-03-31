import { createProjection, type ProjectionContext, type ProjectionEvent } from '../projections';
import type { SagaIntentDeadLetteredEvent, SagaLifecycleEvent } from './SagaEventStore';

const SAGA_LIFECYCLE_AGGREGATE = {
  __aggregateType: 'saga',
  pure: {
    eventProjectors: {
      'intent-dead-lettered': (_state: unknown, _event: { payload: SagaIntentDeadLetteredEvent }) => _state
    }
  }
} as const;

export interface SagaDeadLetterIndexEntry {
  readonly sagaStreamId: string;
  readonly sagaId: string;
  readonly intentKey: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly attempts: number;
  readonly classification: SagaIntentDeadLetteredEvent['deadLetter']['classification'];
  readonly reason: SagaIntentDeadLetteredEvent['deadLetter']['reason'];
  readonly error: SagaIntentDeadLetteredEvent['deadLetter']['error'];
  readonly deadLetteredAt: string;
}

interface SagaDeadLetterIndexDocument {
  entriesByIntentKey: Record<string, SagaDeadLetterIndexEntry>;
}

export interface SagaDeadLetterProjectionQuery {
  readonly sagaId?: string;
  readonly intentKey?: string;
}

const noOpProjectionContext: ProjectionContext = {
  subscribeTo() {
    // no-op for in-memory direct projection application
  },
  getSubscriptions() {
    return [];
  }
};

function toProjectionEvent(event: SagaIntentDeadLetteredEvent, sequence: number): ProjectionEvent {
  return {
    aggregateType: 'saga',
    aggregateId: event.sagaStreamId,
    type: event.type,
    payload: event as unknown as Record<string, unknown>,
    sequence,
    timestamp: event.deadLetteredAt,
    metadata: {
      sagaId: event.lifecycle.metadata.sagaId,
      intentKey: event.lifecycle.intentKey
    }
  };
}

const sagaDeadLetterProjectionDefinition = createProjection<SagaDeadLetterIndexDocument>(
  'saga-dead-letter-index',
  () => ({
    entriesByIntentKey: {}
  })
)
  .from(SAGA_LIFECYCLE_AGGREGATE, {
    'intent-dead-lettered': (state, event) => {
      const deadLetterEvent = event.payload;

      state.entriesByIntentKey[deadLetterEvent.lifecycle.intentKey] = {
        sagaStreamId: deadLetterEvent.sagaStreamId,
        sagaId: deadLetterEvent.lifecycle.metadata.sagaId,
        intentKey: deadLetterEvent.lifecycle.intentKey,
        correlationId: deadLetterEvent.lifecycle.metadata.correlationId,
        causationId: deadLetterEvent.lifecycle.metadata.causationId,
        attempts: deadLetterEvent.deadLetter.attempt,
        classification: deadLetterEvent.deadLetter.classification,
        reason: deadLetterEvent.deadLetter.reason,
        error: deadLetterEvent.deadLetter.error,
        deadLetteredAt: deadLetterEvent.deadLetteredAt
      };
    }
  })
  .build();

function isDeadLetteredEvent(event: SagaLifecycleEvent): event is SagaIntentDeadLetteredEvent {
  return event.type === 'saga.intent-dead-lettered';
}

function matchesQuery(entry: SagaDeadLetterIndexEntry, query: SagaDeadLetterProjectionQuery): boolean {
  if (query.sagaId && entry.sagaId !== query.sagaId) {
    return false;
  }

  if (query.intentKey && entry.intentKey !== query.intentKey) {
    return false;
  }

  return true;
}

export class SagaDeadLetterProjection {
  private readonly document: SagaDeadLetterIndexDocument = sagaDeadLetterProjectionDefinition.initialState('dlq');
  private sequence = 0;

  projectLifecycleEvent(event: SagaLifecycleEvent): void {
    if (!isDeadLetteredEvent(event)) {
      return;
    }

    const projectionEvent = toProjectionEvent(event, this.sequence += 1);
    const handler = sagaDeadLetterProjectionDefinition.fromStream.handlers['intent-dead-lettered'];
    handler?.(this.document, projectionEvent, noOpProjectionContext);
  }

  projectLifecycleEvents(events: readonly SagaLifecycleEvent[]): void {
    for (const event of events) {
      this.projectLifecycleEvent(event);
    }
  }

  query(query: SagaDeadLetterProjectionQuery = {}): SagaDeadLetterIndexEntry[] {
    return Object.values(this.document.entriesByIntentKey)
      .filter(entry => matchesQuery(entry, query))
      .sort((left, right) => {
        if (left.deadLetteredAt === right.deadLetteredAt) {
          return left.intentKey.localeCompare(right.intentKey);
        }

        return left.deadLetteredAt.localeCompare(right.deadLetteredAt);
      });
  }
}

export function querySagaDeadLetterIndex(
  events: readonly SagaLifecycleEvent[],
  query: SagaDeadLetterProjectionQuery = {}
): SagaDeadLetterIndexEntry[] {
  const projection = new SagaDeadLetterProjection();
  projection.projectLifecycleEvents(events);
  return projection.query(query);
}
