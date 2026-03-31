import {
  createProjection,
  type Checkpoint,
  type IProjectionStore,
  type ProjectionDefinition
} from '../../../projections';
import type { SagaCommandMap, SagaIntent } from '../../createSaga';
import {
  SagaRuntimeAggregate,
  type SagaRuntimeDeadLetterIntentPayload,
  type SagaRuntimeFailIntentPayload,
  type SagaRuntimeQueueIntentPayload,
  type SagaRuntimeScheduleRetryPayload,
  type SagaRuntimeStartIntentPayload
} from './SagaRuntimeAggregate';

export type RuntimeIntentProjectionStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'retry_scheduled'
  | 'dead_lettered';

export interface RuntimeIntentProjectionDocument {
  intentKey: string | null;
  sagaStreamId: string | null;
  intentType: string | null;
  intent: SagaIntent<SagaCommandMap> | null;
  status: RuntimeIntentProjectionStatus | null;
  attempts: number;
  queuedAt: string | null;
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  nextAttemptAt: string | null;
  deadLetteredAt: string | null;
  lastErrorMessage: string | null;
}

export interface RuntimeIntentProjectionRecord {
  readonly intentKey: string;
  readonly sagaStreamId: string;
  readonly intentType: string;
  readonly intent: SagaIntent<SagaCommandMap>;
  readonly status: RuntimeIntentProjectionStatus;
  readonly attempts: number;
  readonly queuedAt: string;
  readonly dueAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly deadLetteredAt: string | null;
  readonly lastErrorMessage: string | null;
}

export type RuntimeIntentProjectionRecordFor<TCommandMap extends SagaCommandMap> = Omit<RuntimeIntentProjectionRecord, 'intent'> & {
  readonly intent: SagaIntent<TCommandMap>;
};

export interface RuntimeIntentProjectionQuery {
  readonly statuses?: readonly RuntimeIntentProjectionStatus[];
  readonly dueAtBeforeOrEqual?: string | Date;
  readonly dueAtAfterOrEqual?: string | Date;
}

const RUNTIME_PENDING_STATUSES: readonly RuntimeIntentProjectionStatus[] = ['queued', 'retry_scheduled'];

const SagaRuntimeProjectionSource = {
  ...SagaRuntimeAggregate,
  __aggregateType: 'sagaRuntime' as const
};

const INITIAL_RUNTIME_INTENT_DOCUMENT: RuntimeIntentProjectionDocument = {
  intentKey: null,
  sagaStreamId: null,
  intentType: null,
  intent: null,
  status: null,
  attempts: 0,
  queuedAt: null,
  dueAt: null,
  startedAt: null,
  completedAt: null,
  failedAt: null,
  nextAttemptAt: null,
  deadLetteredAt: null,
  lastErrorMessage: null
};

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toRuntimeIntentProjectionRecord(
  state: RuntimeIntentProjectionDocument
): RuntimeIntentProjectionRecord | null {
  if (!state.intentKey || !state.sagaStreamId || !state.intentType || !state.intent || !state.status || !state.queuedAt || !state.dueAt) {
    return null;
  }

  return {
    intentKey: state.intentKey,
    sagaStreamId: state.sagaStreamId,
    intentType: state.intentType,
    intent: state.intent,
    status: state.status,
    attempts: state.attempts,
    queuedAt: state.queuedAt,
    dueAt: state.dueAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    failedAt: state.failedAt,
    nextAttemptAt: state.nextAttemptAt,
    deadLetteredAt: state.deadLetteredAt,
    lastErrorMessage: state.lastErrorMessage
  };
}

function cloneDocument(document: RuntimeIntentProjectionDocument): RuntimeIntentProjectionDocument {
  return {
    ...document
  };
}

export class InMemoryRuntimeIntentProjectionStore implements IProjectionStore<RuntimeIntentProjectionDocument> {
  private readonly documents = new Map<string, RuntimeIntentProjectionDocument>();

  private readonly checkpoints = new Map<string, Checkpoint>();

  async load(id: string): Promise<RuntimeIntentProjectionDocument | null> {
    const document = this.documents.get(id);
    return document ? cloneDocument(document) : null;
  }

  async save(id: string, state: RuntimeIntentProjectionDocument, cursor: Checkpoint): Promise<void> {
    if (id.startsWith('__cursor__')) {
      this.checkpoints.set(id, cursor);
      return;
    }

    this.documents.set(id, cloneDocument(state));
    this.checkpoints.set(id, cursor);
  }

  async delete(id: string): Promise<void> {
    this.documents.delete(id);
    this.checkpoints.delete(id);
  }

  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    return this.checkpoints.get(id) ?? null;
  }

  getByIntentKey(intentKey: string): RuntimeIntentProjectionRecord | null {
    const document = this.documents.get(`intent:${intentKey}`);
    if (!document) {
      return null;
    }

    return toRuntimeIntentProjectionRecord(document);
  }

  query(query: RuntimeIntentProjectionQuery = {}): RuntimeIntentProjectionRecord[] {
    const statuses = query.statuses ? new Set(query.statuses) : null;
    const dueAtBefore = query.dueAtBeforeOrEqual ? toIsoString(query.dueAtBeforeOrEqual) : null;
    const dueAtAfter = query.dueAtAfterOrEqual ? toIsoString(query.dueAtAfterOrEqual) : null;

    const records = Array.from(this.documents.values())
      .map(toRuntimeIntentProjectionRecord)
      .filter((record): record is RuntimeIntentProjectionRecord => record !== null)
      .filter(record => {
        if (statuses && !statuses.has(record.status)) {
          return false;
        }

        if (dueAtBefore && record.dueAt > dueAtBefore) {
          return false;
        }

        if (dueAtAfter && record.dueAt < dueAtAfter) {
          return false;
        }

        return true;
      });

    return records.sort((left, right) => {
      if (left.dueAt === right.dueAt) {
        return left.intentKey.localeCompare(right.intentKey);
      }

      return left.dueAt.localeCompare(right.dueAt);
    });
  }

  getPendingIntents(): RuntimeIntentProjectionRecord[] {
    return this.query({
      statuses: RUNTIME_PENDING_STATUSES
    });
  }

  getDueIntents(now: string | Date = new Date()): RuntimeIntentProjectionRecord[] {
    return this.query({
      statuses: RUNTIME_PENDING_STATUSES,
      dueAtBeforeOrEqual: now
    });
  }
}

export function createRuntimeIntentProjection(): ProjectionDefinition<RuntimeIntentProjectionDocument> {
  return createProjection<RuntimeIntentProjectionDocument>('saga-runtime-pending-due-intents', () => ({
    ...INITIAL_RUNTIME_INTENT_DOCUMENT
  }))
    .identity(event => {
      const payloadIntentKey = (event.payload as { intentKey?: unknown }).intentKey;
      return typeof payloadIntentKey === 'string'
        ? `intent:${payloadIntentKey}`
        : `ignored:${event.aggregateId}:${event.sequence}`;
    })
    .from(SagaRuntimeProjectionSource, {
      intentQueued: (state, event) => {
        const payload = event.payload as SagaRuntimeQueueIntentPayload;

        state.intentKey = payload.intentKey;
        state.sagaStreamId = event.aggregateId;
        state.intentType = payload.intentType;
        state.intent = payload.intent;
        state.status = 'queued';
        state.attempts = 0;
        state.queuedAt = payload.queuedAt;
        state.dueAt = payload.queuedAt;
        state.startedAt = null;
        state.completedAt = null;
        state.failedAt = null;
        state.nextAttemptAt = null;
        state.deadLetteredAt = null;
        state.lastErrorMessage = null;
      },
      intentStarted: (state, event) => {
        const payload = event.payload as SagaRuntimeStartIntentPayload;

        state.intentKey = payload.intentKey;
        state.sagaStreamId = event.aggregateId;
        state.status = 'in_progress';
        state.attempts = Math.max(state.attempts + 1, 1);
        state.startedAt = payload.startedAt;
        state.completedAt = null;
        state.failedAt = null;
        state.nextAttemptAt = null;
        state.deadLetteredAt = null;
        state.lastErrorMessage = null;
      },
      intentCompleted: (state, event) => {
        const payload = event.payload as { intentKey: string; completedAt: string };

        state.intentKey = payload.intentKey;
        state.sagaStreamId = event.aggregateId;
        state.status = 'completed';
        state.completedAt = payload.completedAt;
        state.failedAt = null;
        state.nextAttemptAt = null;
        state.deadLetteredAt = null;
        state.lastErrorMessage = null;
      },
      intentFailed: (state, event) => {
        const payload = event.payload as SagaRuntimeFailIntentPayload;

        state.intentKey = payload.intentKey;
        state.sagaStreamId = event.aggregateId;
        state.status = 'failed';
        state.failedAt = payload.failedAt;
        state.completedAt = null;
        state.nextAttemptAt = null;
        state.deadLetteredAt = null;
        state.lastErrorMessage = payload.errorMessage;
      },
      intentRetryScheduled: (state, event) => {
        const payload = event.payload as SagaRuntimeScheduleRetryPayload;

        state.intentKey = payload.intentKey;
        state.sagaStreamId = event.aggregateId;
        state.status = 'retry_scheduled';
        state.attempts = payload.attempt;
        state.nextAttemptAt = payload.nextAttemptAt;
        state.dueAt = payload.nextAttemptAt;
        state.completedAt = null;
        state.failedAt = null;
        state.deadLetteredAt = null;
      },
      intentDeadLettered: (state, event) => {
        const payload = event.payload as SagaRuntimeDeadLetterIntentPayload;

        state.intentKey = payload.intentKey;
        state.sagaStreamId = event.aggregateId;
        state.status = 'dead_lettered';
        state.attempts = payload.attempt;
        state.deadLetteredAt = payload.deadLetteredAt;
        state.completedAt = null;
        state.nextAttemptAt = null;
        state.lastErrorMessage = payload.errorMessage;
      }
    })
    .build();
}
