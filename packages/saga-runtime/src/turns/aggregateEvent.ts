import type { Event } from '@redemeine/kernel';
import type { SagaTurnSourceEvent } from './contracts';

export interface SagaTurnAggregateEvent extends Event<unknown, string> {
  readonly id: string;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly sequence?: number;
  readonly metadata?: Record<string, unknown>;
}

export function createSagaTurnAggregateEvent(source: SagaTurnSourceEvent): SagaTurnAggregateEvent {
  const metadata = {
    ...source.metadata,
    ...(source.sequence === undefined ? {} : { version: source.sequence }),
    ...(source.correlationId === undefined ? {} : { correlationId: source.correlationId }),
    ...(source.causationId === undefined ? {} : { causationId: source.causationId })
  };
  return {
    id: source.eventId,
    type: source.type,
    payload: source.payload,
    ...(source.aggregateType === undefined ? {} : { aggregateType: source.aggregateType }),
    ...(source.aggregateId === undefined ? {} : { aggregateId: source.aggregateId }),
    ...(source.sequence === undefined ? {} : { sequence: source.sequence }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata })
  };
}
