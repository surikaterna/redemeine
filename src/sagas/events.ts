/** Canonical saga event names used by runtime and docs taxonomy. */
export const SAGA_EVENT_NAMES = [
  'saga.event-observed',
  'saga.intent-recorded',
  'saga.intent-started',
  'saga.intent-dispatched',
  'saga.intent-succeeded',
  'saga.intent-failed',
  'saga.intent-retry-scheduled',
  'saga.intent-dead-lettered',
  'saga.started',
  'saga.advanced',
  'saga.completed',
  'saga.compensating',
  'saga.compensated',
  'saga.failed'
] as const;

/** Union type of canonical saga event names. */
export type SagaEventName = (typeof SAGA_EVENT_NAMES)[number];
