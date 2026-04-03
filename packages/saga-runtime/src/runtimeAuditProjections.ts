import type {
  IntentExecutionProjectionRecord,
  SagaActivityLifecycleRecord,
  SagaAggregateState,
  SagaIntentLifecycleRecord,
  SagaObservedSourceEventRecord,
  SagaStateTransitionRecord
} from './SagaAggregate';
import type {
  RuntimeIntentExecutionQuery,
  RuntimeIntentExecutionQueryResult,
  RuntimeReadModelContract,
  RuntimeReadModelWindowRequest,
  RuntimeSagaReadModel
} from './runtimeObservabilityContracts';

type SagaLifecycleHistoryKind =
  | 'source_event_observed'
  | 'state_transition_recorded'
  | 'intent_lifecycle_recorded'
  | 'activity_lifecycle_recorded';

type IntentExecutionLifecycleChangeKind =
  | 'created'
  | 'status_changed'
  | 'attempt_changed'
  | 'response_ref_recorded'
  | 'metadata_changed';

export interface SagaLifecycleHistoryEntry {
  sagaId: string;
  transitionVersion: number;
  kind: SagaLifecycleHistoryKind;
  recordedAt: string;
  tieBreakerKey: string;
  record:
    | SagaObservedSourceEventRecord
    | SagaStateTransitionRecord
    | SagaIntentLifecycleRecord
    | SagaActivityLifecycleRecord;
}

export interface IntentExecutionLifecycleHistoryEntry {
  executionId: string;
  sagaId: string;
  intentId: string;
  sequence: number;
  recordedAt: string;
  kind: IntentExecutionLifecycleChangeKind;
  previous: IntentExecutionProjectionRecord | null;
  current: IntentExecutionProjectionRecord;
}

export interface LifecycleHistoryQuery {
  readonly sagaId?: string;
  readonly executionId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface LifecycleHistoryQueryResult<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor?: string;
}

export interface RuntimeAuditLifecycleReadModel extends RuntimeReadModelContract {
  upsertSaga(record: SagaAggregateState): void;
  upsertIntentExecution(record: IntentExecutionProjectionRecord): void;
  querySagaLifecycleHistory(query: LifecycleHistoryQuery & { readonly sagaId: string }): LifecycleHistoryQueryResult<SagaLifecycleHistoryEntry>;
  queryIntentExecutionLifecycleHistory(query: LifecycleHistoryQuery): LifecycleHistoryQueryResult<IntentExecutionLifecycleHistoryEntry>;
}

const sagaLifecycleKindRank: Record<SagaLifecycleHistoryKind, number> = {
  source_event_observed: 0,
  state_transition_recorded: 1,
  intent_lifecycle_recorded: 2,
  activity_lifecycle_recorded: 3
};

const cloneState = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const toIso8601 = (value: string): string => {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return new Date(0).toISOString();
};

const normalizeLimit = (limit?: number): number => {
  if (!Number.isFinite(limit)) {
    return 50;
  }

  return Math.max(0, Math.floor(limit!));
};

const encodeCursor = (index: number): string => `i:${index}`;

const decodeCursor = (cursor?: string): number | null => {
  if (!cursor) {
    return null;
  }

  if (!cursor.startsWith('i:')) {
    return null;
  }

  const parsed = Number.parseInt(cursor.slice(2), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
};

const cloneSagaWithWindow = (record: SagaAggregateState, options?: RuntimeReadModelWindowRequest): RuntimeSagaReadModel => {
  const view = cloneState(record);
  if (!options?.recent) {
    return view;
  }

  const transitionsLimit = normalizeLimit(options.recent.transitions ?? view.recent.transitions.length);
  const eventsLimit = normalizeLimit(options.recent.events ?? view.recent.events.length);
  const intentsLimit = normalizeLimit(options.recent.intents ?? view.recent.intents.length);
  const activitiesLimit = normalizeLimit(options.recent.activities ?? view.recent.activities.length);

  return {
    ...view,
    recent: {
      transitions: view.recent.transitions.slice(0, transitionsLimit),
      events: view.recent.events.slice(0, eventsLimit),
      intents: view.recent.intents.slice(0, intentsLimit),
      activities: view.recent.activities.slice(0, activitiesLimit)
    }
  };
};

const sortSagaLifecycleHistory = (entries: SagaLifecycleHistoryEntry[]): SagaLifecycleHistoryEntry[] =>
  [...entries].sort((a, b) => {
    const atOrder = a.recordedAt.localeCompare(b.recordedAt);
    if (atOrder !== 0) {
      return atOrder;
    }

    const versionOrder = a.transitionVersion - b.transitionVersion;
    if (versionOrder !== 0) {
      return versionOrder;
    }

    const kindOrder = sagaLifecycleKindRank[a.kind] - sagaLifecycleKindRank[b.kind];
    if (kindOrder !== 0) {
      return kindOrder;
    }

    return a.tieBreakerKey.localeCompare(b.tieBreakerKey);
  });

const sortIntentExecutionHistory = (entries: IntentExecutionLifecycleHistoryEntry[]): IntentExecutionLifecycleHistoryEntry[] =>
  [...entries].sort((a, b) => {
    const atOrder = a.recordedAt.localeCompare(b.recordedAt);
    if (atOrder !== 0) {
      return atOrder;
    }

    const executionOrder = a.executionId.localeCompare(b.executionId);
    if (executionOrder !== 0) {
      return executionOrder;
    }

    return a.sequence - b.sequence;
  });

const toSagaHistoryEntries = (record: SagaAggregateState): SagaLifecycleHistoryEntry[] => {
  if (!record.id) {
    return [];
  }

  const sagaId = record.id;
  const entries: SagaLifecycleHistoryEntry[] = [];

  for (const eventRecord of record.recent.events) {
    entries.push({
      sagaId,
      transitionVersion: record.transitionVersion,
      kind: 'source_event_observed',
      recordedAt: toIso8601(eventRecord.observedAt),
      tieBreakerKey: `event:${eventRecord.eventId ?? eventRecord.eventType}`,
      record: cloneState(eventRecord)
    });
  }

  for (const transitionRecord of record.recent.transitions) {
    entries.push({
      sagaId,
      transitionVersion: record.transitionVersion,
      kind: 'state_transition_recorded',
      recordedAt: toIso8601(transitionRecord.transitionAt),
      tieBreakerKey: `transition:${transitionRecord.fromState}->${transitionRecord.toState}`,
      record: cloneState(transitionRecord)
    });
  }

  for (const intentRecord of record.recent.intents) {
    entries.push({
      sagaId,
      transitionVersion: record.transitionVersion,
      kind: 'intent_lifecycle_recorded',
      recordedAt: toIso8601(intentRecord.recordedAt),
      tieBreakerKey: `intent:${intentRecord.intentId}:${intentRecord.stage}`,
      record: cloneState(intentRecord)
    });
  }

  for (const activityRecord of record.recent.activities) {
    entries.push({
      sagaId,
      transitionVersion: record.transitionVersion,
      kind: 'activity_lifecycle_recorded',
      recordedAt: toIso8601(activityRecord.recordedAt),
      tieBreakerKey: `activity:${activityRecord.activityId}:${activityRecord.stage}`,
      record: cloneState(activityRecord)
    });
  }

  return sortSagaLifecycleHistory(entries);
};

const deriveIntentLifecycleEntries = (
  previous: IntentExecutionProjectionRecord | null,
  current: IntentExecutionProjectionRecord,
  sequence: number
): IntentExecutionLifecycleHistoryEntry[] => {
  if (!previous) {
    return [
      {
        executionId: current.id,
        sagaId: current.sagaId,
        intentId: current.intentId,
        sequence,
        recordedAt: toIso8601(current.createdAt),
        kind: 'created',
        previous: null,
        current: cloneState(current)
      }
    ];
  }

  const entries: IntentExecutionLifecycleHistoryEntry[] = [];
  let localSequence = sequence;

  if (previous.status !== current.status) {
    entries.push({
      executionId: current.id,
      sagaId: current.sagaId,
      intentId: current.intentId,
      sequence: localSequence,
      recordedAt: toIso8601(current.updatedAt),
      kind: 'status_changed',
      previous: cloneState(previous),
      current: cloneState(current)
    });
    localSequence += 1;
  }

  if (previous.attempt !== current.attempt) {
    entries.push({
      executionId: current.id,
      sagaId: current.sagaId,
      intentId: current.intentId,
      sequence: localSequence,
      recordedAt: toIso8601(current.updatedAt),
      kind: 'attempt_changed',
      previous: cloneState(previous),
      current: cloneState(current)
    });
    localSequence += 1;
  }

  if (JSON.stringify(previous.responseRef) !== JSON.stringify(current.responseRef) && current.responseRef) {
    entries.push({
      executionId: current.id,
      sagaId: current.sagaId,
      intentId: current.intentId,
      sequence: localSequence,
      recordedAt: toIso8601(current.updatedAt),
      kind: 'response_ref_recorded',
      previous: cloneState(previous),
      current: cloneState(current)
    });
    localSequence += 1;
  }

  if (JSON.stringify(previous.metadata ?? null) !== JSON.stringify(current.metadata ?? null)) {
    entries.push({
      executionId: current.id,
      sagaId: current.sagaId,
      intentId: current.intentId,
      sequence: localSequence,
      recordedAt: toIso8601(current.updatedAt),
      kind: 'metadata_changed',
      previous: cloneState(previous),
      current: cloneState(current)
    });
  }

  return entries;
};

export function createRuntimeAuditLifecycleReadModel(): RuntimeAuditLifecycleReadModel {
  const sagas = new Map<string, SagaAggregateState>();
  const sagaHistory = new Map<string, SagaLifecycleHistoryEntry[]>();
  const executions = new Map<string, IntentExecutionProjectionRecord>();
  const executionHistory = new Map<string, IntentExecutionLifecycleHistoryEntry[]>();
  const executionSequence = new Map<string, number>();

  return {
    upsertSaga(record) {
      if (!record.id) {
        return;
      }

      const normalized = cloneState(record);
      sagas.set(record.id, normalized);
      sagaHistory.set(record.id, toSagaHistoryEntries(normalized));
    },
    upsertIntentExecution(record) {
      const normalized = cloneState(record);
      const previous = executions.get(record.id) ?? null;
      executions.set(record.id, normalized);

      const sequence = (executionSequence.get(record.id) ?? 1);
      const entries = deriveIntentLifecycleEntries(previous, normalized, sequence);
      if (entries.length === 0) {
        return;
      }

      executionSequence.set(record.id, sequence + entries.length);
      executionHistory.set(record.id, sortIntentExecutionHistory([...(executionHistory.get(record.id) ?? []), ...entries]));
    },
    getSagaById(id, options) {
      const found = sagas.get(id);
      if (!found) {
        return null;
      }

      return cloneSagaWithWindow(found, options);
    },
    getIntentExecutionById(id) {
      const found = executions.get(id);
      return found ? cloneState(found) : null;
    },
    queryIntentExecutions(query: RuntimeIntentExecutionQuery): RuntimeIntentExecutionQueryResult {
      const filtered = [...executions.values()]
        .filter((entry) => entry.sagaId === query.sagaId)
        .filter((entry) => !query.statuses || query.statuses.includes(entry.status))
        .sort((a, b) => {
          const updatedAtOrder = b.updatedAt.localeCompare(a.updatedAt);
          if (updatedAtOrder !== 0) {
            return updatedAtOrder;
          }

          return a.id.localeCompare(b.id);
        });

      const limit = normalizeLimit(query.limit);
      const start = decodeCursor(query.cursor) ?? 0;
      const items = filtered.slice(start, start + limit).map((entry) => cloneState(entry));
      const nextIndex = start + items.length;

      return {
        items,
        nextCursor: nextIndex < filtered.length ? encodeCursor(nextIndex) : undefined
      };
    },
    querySagaLifecycleHistory(query) {
      const entries = sagaHistory.get(query.sagaId) ?? [];
      const limit = normalizeLimit(query.limit);
      const start = decodeCursor(query.cursor) ?? 0;
      const items = entries.slice(start, start + limit).map((entry) => cloneState(entry));
      const nextIndex = start + items.length;

      return {
        items,
        nextCursor: nextIndex < entries.length ? encodeCursor(nextIndex) : undefined
      };
    },
    queryIntentExecutionLifecycleHistory(query) {
      const candidates = query.executionId
        ? (executionHistory.get(query.executionId) ?? [])
        : [...executionHistory.values()].flat();

      const filtered = candidates
        .filter((entry) => !query.sagaId || entry.sagaId === query.sagaId)
        .sort((a, b) => {
          const atOrder = a.recordedAt.localeCompare(b.recordedAt);
          if (atOrder !== 0) {
            return atOrder;
          }

          const executionOrder = a.executionId.localeCompare(b.executionId);
          if (executionOrder !== 0) {
            return executionOrder;
          }

          return a.sequence - b.sequence;
        });

      const limit = normalizeLimit(query.limit);
      const start = decodeCursor(query.cursor) ?? 0;
      const items = filtered.slice(start, start + limit).map((entry) => cloneState(entry));
      const nextIndex = start + items.length;

      return {
        items,
        nextCursor: nextIndex < filtered.length ? encodeCursor(nextIndex) : undefined
      };
    }
  };
}
