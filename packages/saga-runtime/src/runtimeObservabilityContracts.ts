import type {
  IntentExecutionProjectionRecord,
  SagaAggregateState,
  SagaRecentWindowLimits
} from './SagaAggregate';

export type RuntimeTelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export type RuntimeTelemetryKind =
  | 'saga.lifecycle'
  | 'saga.transition'
  | 'source_event.observed'
  | 'intent.lifecycle'
  | 'intent.execution'
  | 'activity.lifecycle'
  | 'scheduler.trigger'
  | 'scheduler.misfire'
  | 'dispatch.attempt'
  | 'dispatch.response'
  | 'runtime.invariant';

export interface RuntimeTelemetryContext {
  sagaId?: string;
  sagaType?: string;
  intentId?: string;
  executionId?: string;
  activityId?: string;
  triggerKey?: string;
  correlationId?: string;
  causationId?: string;
  tenantId?: string;
  sequence?: number;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTelemetryRecord {
  kind: RuntimeTelemetryKind;
  level: RuntimeTelemetryLevel;
  occurredAt: string;
  message?: string;
  context: RuntimeTelemetryContext;
  attributes?: Record<string, unknown>;
}

export interface RuntimeTelemetryPublisherContract {
  publish(record: RuntimeTelemetryRecord): void | Promise<void>;
  publishBatch?(records: RuntimeTelemetryRecord[]): void | Promise<void>;
}

export type RuntimeAuditCategory =
  | 'command'
  | 'event'
  | 'projection'
  | 'scheduler'
  | 'invariant'
  | 'dispatch';

export interface RuntimeAuditActor {
  type: 'system' | 'user' | 'service';
  id: string;
  displayName?: string;
}

export interface RuntimeAuditReference {
  type: 'saga' | 'intent_execution' | 'activity' | 'trigger' | 'event' | 'command';
  id: string;
  version?: number;
}

export interface RuntimeAuditRecord {
  auditId: string;
  category: RuntimeAuditCategory;
  action: string;
  recordedAt: string;
  sagaId: string;
  intentExecutionId?: string;
  correlationId?: string;
  causationId?: string;
  actor?: RuntimeAuditActor;
  before?: unknown;
  after?: unknown;
  diff?: Record<string, unknown>;
  references?: RuntimeAuditReference[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeAuditCursor {
  recordedAt: string;
  auditId: string;
}

export interface RuntimeAuditQuery {
  sagaId?: string;
  intentExecutionId?: string;
  categories?: RuntimeAuditCategory[];
  actions?: string[];
  fromRecordedAt?: string;
  toRecordedAt?: string;
  cursor?: RuntimeAuditCursor;
  limit?: number;
}

export interface RuntimeAuditQueryResult {
  items: RuntimeAuditRecord[];
  nextCursor?: RuntimeAuditCursor;
  totalApproximate?: number;
}

export interface RuntimeAuditWriterContract {
  append(record: RuntimeAuditRecord): void | Promise<void>;
  appendBatch?(records: RuntimeAuditRecord[]): void | Promise<void>;
}

export interface RuntimeAuditReaderContract {
  query(query: RuntimeAuditQuery): RuntimeAuditQueryResult | Promise<RuntimeAuditQueryResult>;
  getByAuditId(auditId: string): RuntimeAuditRecord | null | Promise<RuntimeAuditRecord | null>;
}

export type RuntimeSagaReadModel = SagaAggregateState;

export type RuntimeIntentExecutionReadModel = IntentExecutionProjectionRecord;

export interface RuntimeReadModelWindowRequest {
  recent?: Partial<SagaRecentWindowLimits>;
}

export interface RuntimeIntentExecutionQuery {
  sagaId: string;
  statuses?: RuntimeIntentExecutionReadModel['status'][];
  limit?: number;
  cursor?: string;
}

export interface RuntimeIntentExecutionQueryResult {
  items: RuntimeIntentExecutionReadModel[];
  nextCursor?: string;
}

export interface RuntimeReadModelContract {
  getSagaById(id: string, options?: RuntimeReadModelWindowRequest): RuntimeSagaReadModel | null | Promise<RuntimeSagaReadModel | null>;
  getIntentExecutionById(id: string): RuntimeIntentExecutionReadModel | null | Promise<RuntimeIntentExecutionReadModel | null>;
  queryIntentExecutions(query: RuntimeIntentExecutionQuery): RuntimeIntentExecutionQueryResult | Promise<RuntimeIntentExecutionQueryResult>;
}

export interface RuntimeObservabilityReadApiContract {
  telemetry: RuntimeTelemetryPublisherContract;
  audit: RuntimeAuditReaderContract & RuntimeAuditWriterContract;
  readModel: RuntimeReadModelContract;
}
