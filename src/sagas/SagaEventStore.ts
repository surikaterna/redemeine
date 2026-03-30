import type { SagaCommandMap, SagaIntent, SagaReducerOutput } from './createSaga';

export interface SagaIntentRecordedEvent<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  readonly type: 'saga.intent-recorded';
  readonly sagaStreamId: string;
  readonly intent: SagaIntent<TCommandMap>;
  readonly recordedAt: string;
}

export interface SagaEventStore {
  appendIntentRecordedBatch<TCommandMap extends SagaCommandMap>(
    sagaStreamId: string,
    events: readonly SagaIntentRecordedEvent<TCommandMap>[]
  ): Promise<void>;
}

export class InMemorySagaEventStore implements SagaEventStore {
  private readonly streams = new Map<string, SagaIntentRecordedEvent[]>();

  async appendIntentRecordedBatch<TCommandMap extends SagaCommandMap>(
    sagaStreamId: string,
    events: readonly SagaIntentRecordedEvent<TCommandMap>[]
  ): Promise<void> {
    const existing = this.streams.get(sagaStreamId) ?? [];

    this.streams.set(sagaStreamId, [
      ...existing,
      ...(events as readonly SagaIntentRecordedEvent[])
    ]);
  }

  async loadIntentRecordedEvents(
    sagaStreamId: string
  ): Promise<readonly SagaIntentRecordedEvent[]> {
    const events = this.streams.get(sagaStreamId) ?? [];
    return [...events];
  }

  clear(): void {
    this.streams.clear();
  }
}

export function createSagaIntentRecordedEvents<TState, TCommandMap extends SagaCommandMap>(
  sagaStreamId: string,
  output: SagaReducerOutput<TState, TCommandMap>,
  createRecordedAt: () => string = () => new Date().toISOString()
): SagaIntentRecordedEvent<TCommandMap>[] {
  return output.intents.map(intent => ({
    type: 'saga.intent-recorded',
    sagaStreamId,
    intent,
    recordedAt: createRecordedAt()
  }));
}

export async function persistSagaReducerOutputIntents<TState, TCommandMap extends SagaCommandMap>(
  sagaStreamId: string,
  output: SagaReducerOutput<TState, TCommandMap>,
  eventStore: SagaEventStore,
  createRecordedAt: () => string = () => new Date().toISOString()
): Promise<readonly SagaIntentRecordedEvent<TCommandMap>[]> {
  const events = createSagaIntentRecordedEvents(sagaStreamId, output, createRecordedAt);
  await eventStore.appendIntentRecordedBatch(sagaStreamId, events);
  return events;
}
