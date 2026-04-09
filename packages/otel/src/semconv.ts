export const RUNTIME_TELEMETRY_KIND_PREFIX = 'redemeine.runtime';

export const RUNTIME_TELEMETRY_SEMANTIC_CONVENTIONS = {
  serviceName: 'service.name',
  sagaId: 'redemeine.saga.id',
  sagaType: 'redemeine.saga.type',
  intentId: 'redemeine.intent.id',
  executionId: 'redemeine.execution.id',
  activityId: 'redemeine.activity.id',
  triggerKey: 'redemeine.trigger.key',
  correlationId: 'redemeine.correlation.id',
  causationId: 'redemeine.causation.id',
  tenantId: 'redemeine.tenant.id',
  sequence: 'redemeine.sequence',
  telemetryKind: 'redemeine.telemetry.kind',
  telemetryLevel: 'redemeine.telemetry.level'
} as const;

export type RuntimeTelemetrySemanticConventionKey = keyof typeof RUNTIME_TELEMETRY_SEMANTIC_CONVENTIONS;
