export interface ConsumerFacts {
  readonly startupConsumerDetailsCount: number;
  readonly startupQueueConsumerCountShape: 'absent' | 'invalid' | 'integer';
  readonly startupQueueConsumerCount?: number;
  readonly startupConsumerActive?: boolean;
  readonly startupConsumerTagMatches?: boolean;
}

export function consumerFacts(queue: Record<string, unknown>, values: unknown[], tag?: string): ConsumerFacts {
  const count = queue.consumers;
  const boundedCount = smallCount(count);
  const first = values.length === 1 ? values[0] : undefined;
  const value = first && typeof first === 'object' && !Array.isArray(first) ? first : undefined;
  return { startupConsumerDetailsCount: values.length,
    startupQueueConsumerCountShape: !Object.hasOwn(queue, 'consumers') ? 'absent' : boundedCount ? 'integer' : 'invalid',
    ...(boundedCount ? { startupQueueConsumerCount: count } : {}),
    ...(value && 'active' in value && typeof value.active === 'boolean' ? { startupConsumerActive: value.active } : {}),
    ...(value && tag !== undefined && 'consumer_tag' in value ? { startupConsumerTagMatches: value.consumer_tag === tag } : {}) };
}

function smallCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 16;
}

export function consumerHealthFacts(value: object): Partial<ConsumerFacts> {
  const count: unknown = Object.getOwnPropertyDescriptor(value, 'startupQueueConsumerCount')?.value;
  const details: unknown = Object.getOwnPropertyDescriptor(value, 'startupConsumerDetailsCount')?.value;
  const shape: unknown = Object.getOwnPropertyDescriptor(value, 'startupQueueConsumerCountShape')?.value;
  const active: unknown = Object.getOwnPropertyDescriptor(value, 'startupConsumerActive')?.value;
  const matches: unknown = Object.getOwnPropertyDescriptor(value, 'startupConsumerTagMatches')?.value;
  return { ...(smallCount(count) ? { startupQueueConsumerCount: count } : {}),
    ...(smallCount(details) ? { startupConsumerDetailsCount: details } : {}),
    ...(shape === 'absent' || shape === 'invalid' || shape === 'integer' ? { startupQueueConsumerCountShape: shape } : {}),
    ...(typeof active === 'boolean' ? { startupConsumerActive: active } : {}),
    ...(typeof matches === 'boolean' ? { startupConsumerTagMatches: matches } : {}) };
}
