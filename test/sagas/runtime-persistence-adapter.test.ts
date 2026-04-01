import { describe, expect, it } from '@jest/globals';
import type { Event } from '../../src/types';
import { createDepot, type EventStore } from '../../src/Depot';
import {
  createSaga,
  persistSagaReducerOutputThroughRuntimeAggregate,
  SagaRuntimeAggregate,
  type SagaReducerOutput,
  type SagaRuntimeDepotLike
} from '../../src/sagas/internal/runtime';

type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
};

class InMemoryEventStore implements EventStore {
  private readonly streams = new Map<string, Event[]>();

  async *readStream(id: string): AsyncIterable<Event> {
    const events = this.streams.get(id) ?? [];
    for (const event of events) {
      yield event;
    }
  }

  async saveEvents(id: string, events: Event[]): Promise<void> {
    const existing = this.streams.get(id) ?? [];
    this.streams.set(id, [...existing, ...events]);
  }

  getStream(id: string): readonly Event[] {
    return this.streams.get(id) ?? [];
  }
}

describe('R3 runtime aggregate persistence adapter', () => {
  it('translates fluent reducer intents and persists via runtime aggregate path', async () => {
    const store = new InMemoryEventStore();
    const runtimeDepot = createDepot(SagaRuntimeAggregate, store) as unknown as SagaRuntimeDepotLike;

    const saga = createSaga<BillingCommandMap>()
      .initialState(() => ({ invoiceId: 'inv-1' }))
      .on('invoice', {
        created: ctx => ({
          state: ctx.state,
          intents: [
            ctx.dispatch('billing.charge', {
              invoiceId: 'inv-1',
              amount: 250
            })
          ]
        })
      })
      .build();

    const output = await saga.handlers[0].handlers.created({
      state: { invoiceId: 'inv-1' },
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      },
      dispatch: (command, payload, metadata = {}) => ({
        type: 'dispatch',
        command,
        payload,
        metadata: {
          sagaId: metadata.sagaId ?? 'saga-1',
          correlationId: metadata.correlationId ?? 'corr-1',
          causationId: metadata.causationId ?? 'cause-2'
        }
      }),
      commandsFor: () => ({}) as never,
      schedule: () => ({
        type: 'schedule',
        id: 'timer-1',
        delay: 1000,
        metadata: {
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-3'
        }
      }),
      cancelSchedule: () => ({
        type: 'cancel-schedule',
        id: 'timer-1',
        metadata: {
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-4'
        }
      }),
      runActivity: (name, closure) => ({
        type: 'run-activity',
        name,
        closure,
        metadata: {
          sagaId: 'saga-1',
          correlationId: 'corr-1',
          causationId: 'cause-5'
        }
      })
    });

    await persistSagaReducerOutputThroughRuntimeAggregate(
      output as SagaReducerOutput<{ invoiceId: string }, BillingCommandMap>,
      runtimeDepot,
      {
        sagaStreamId: 'saga-runtime-stream-1',
        createQueuedAt: () => '2026-03-31T00:00:00.000Z'
      }
    );

    const events = store.getStream('saga-runtime-stream-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('sagaRuntime.intentQueued.event');
    expect(events[0].payload).toMatchObject({
      intentType: 'dispatch',
      intent: output.intents[0],
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-2'
      },
      queuedAt: '2026-03-31T00:00:00.000Z'
    });
    expect(events[0].payload.intentKey).toBe(events[0].payload.idempotencyKey);
    expect(events[0].payload.idempotencyKey).toContain('saga-runtime-stream-1:0:');
  });
});
