import type { PluginHookName } from './types';

export type CanonicalInspectionHookName =
  | 'command.ingress'
  | 'event.hydration'
  | 'event.append'
  | 'outbox.enqueue'
  | 'outbox.dequeue'
  | 'source_event.observed'
  | 'side_effect.execution'
  | 'retry.dead_letter'
  | 'projection.batch.processing';

export type CanonicalInspectionRuntime = 'mirage' | 'saga-runtime' | 'projection';

export interface CanonicalInspectionIdentity {
  correlationId: string;
  causationId?: string;
  aggregateId?: string;
  aggregateType?: string;
  eventType?: string;
  eventId?: string;
  intentId?: string;
  executionId?: string;
  sagaId?: string;
  projectionName?: string;
}

export interface CanonicalInspectionCompatibility {
  legacyHook?: PluginHookName | 'runtime.telemetry' | 'projection.onBatch';
  legacyContext?: Record<string, unknown>;
}

export interface CanonicalInspectionEnvelope<TPayload = Record<string, unknown>> {
  schema: 'redemeine.inspection/v1';
  hook: CanonicalInspectionHookName;
  runtime: CanonicalInspectionRuntime;
  boundary: string;
  emittedAt: string;
  ids: CanonicalInspectionIdentity;
  payload: TPayload;
  compatibility?: CanonicalInspectionCompatibility;
}

export type InspectionEventPublisher = (
  event: CanonicalInspectionEnvelope
) => void | Promise<void>;

export const resolveInspectionCorrelationId = (
  value: unknown,
  fallback: string
): string => (typeof value === 'string' && value.length > 0 ? value : fallback);

export const resolveInspectionCausationId = (
  value: unknown,
  fallback?: string
): string | undefined => {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return fallback;
};

export async function emitCanonicalInspection(
  publisher: InspectionEventPublisher | undefined,
  event: Omit<CanonicalInspectionEnvelope, 'schema' | 'emittedAt'>
): Promise<void> {
  if (!publisher) {
    return;
  }

  try {
    await publisher({
      schema: 'redemeine.inspection/v1',
      emittedAt: new Date().toISOString(),
      ...event
    });
  } catch {
    // Inspection emission is best-effort and must not alter domain behavior.
  }
}
