import { beforeEach, describe, expect, it } from '@jest/globals';
import { createAggregate } from '@redemeine/aggregate';
import type { CanonicalInspectionEnvelope, Event } from '@redemeine/kernel';
import { clearAdapters, registerAdapter } from '@redemeine/otel';
import { createDepot, type EventStore } from '../../mirage/src';
import { InMemoryProjectionStore } from '../../projection/src/InMemoryProjectionStore';
import { ProjectionDaemon } from '../../projection/src/ProjectionDaemon';
import { createProjection } from '../../projection/src/createProjection';
import type { IEventSubscription } from '../../projection/src/IEventSubscription';
import type { Checkpoint, ProjectionEvent } from '../../projection/src/types';
import { createReferenceAdaptersV1, runReferenceAdapterFlowV1 } from '../src/referenceAdapters';

describe('otel inspection continuity e2e', () => {
  beforeEach(() => {
    clearAdapters();
    registerAdapter({
      id: 'default',
      extract: (carrier) => ({
        values: {
          correlationId: carrier.correlationId,
          causationId: carrier.causationId
        }
      }),
      inject: (context, carrier) => {
        const correlationId = context.values?.correlationId;
        const causationId = context.values?.causationId;
        if (typeof correlationId === 'string') {
          carrier.correlationId = correlationId;
        }
        if (typeof causationId === 'string') {
          carrier.causationId = causationId;
        }
      }
    });
  });

  it('preserves correlation across command->event->outbox->side-effect->projection hooks', async () => {
    const correlationId = 'corr-chain-1';
    const commandId = 'cmd-chain-1';
    const eventId = 'evt-chain-1';
    const inspectionEvents: CanonicalInspectionEnvelope[] = [];
    const stream = new Map<string, Event[]>();

    const eventStore: EventStore = {
      readStream: async function* (id: string) {
        for (const event of stream.get(id) ?? []) {
          yield event;
        }
      },
      saveEvents: async (id: string, events: Event[]) => {
        stream.set(id, [...(stream.get(id) ?? []), ...events]);
      }
    };

    const aggregate = createAggregate<{ id: string | null; status: string }, 'order'>('order', {
      id: null,
      status: 'new'
    })
      .events({
        opened: (state, event: Event<{ orderId: string }>) => {
          state.id = event.payload.orderId;
          state.status = 'opened';
        }
      })
      .commands(() => ({
        open: (_state: unknown, payload: { orderId: string; correlationId: string; causationId: string; eventId: string }) => ({
          id: payload.eventId,
          type: 'order.opened.event',
          payload: { orderId: payload.orderId },
          metadata: {
            correlationId: payload.correlationId,
            causationId: payload.causationId
          }
        })
      }))
      .build();

    const depot = createDepot(aggregate, eventStore, {
      inspection: (event) => {
        inspectionEvents.push(event);
      },
      plugins: [
        {
          key: 'inspection-hooks',
          onBeforeAppend: async () => undefined,
          onAfterCommit: async () => undefined
        }
      ]
    });

    const mirage = await depot.get('order-1');
    const command = aggregate.commandCreators.open({
      orderId: 'order-1',
      correlationId,
      causationId: commandId,
      eventId
    });
    command.id = commandId;
    command.headers = { correlationId };

    await mirage.dispatch(command);
    await depot.save(mirage);

    const persistedEvent = (stream.get('order-1') ?? [])[0];
    expect(persistedEvent?.id).toBe(eventId);

    await runReferenceAdapterFlowV1(createReferenceAdaptersV1(), {
      sagaId: 'saga-chain-1',
      telemetryAdapterId: 'default',
      inspection: (event) => {
        inspectionEvents.push(event);
      },
      intents: [
        {
          type: 'plugin-request',
          plugin_key: 'payments',
          action_name: 'authorize',
          action_kind: 'request_response',
          execution_payload: { orderId: 'order-1' },
          routing_metadata: {
            response_handler_key: 'payments.authorize.ok',
            error_handler_key: 'payments.authorize.failed',
            handler_data: { orderId: 'order-1' }
          },
          metadata: {
            sagaId: 'saga-chain-1',
            correlationId,
            causationId: eventId
          }
        }
      ]
    });

    const projection = createProjection<{ count: number; lastCorrelationId?: string }>('order-observability', () => ({
      count: 0,
      lastCorrelationId: undefined
    }))
      .from({
        __aggregateType: 'order',
        initialState: {},
        pure: { eventProjectors: {} }
      }, {
        'order.opened.event': (state, event) => {
          state.count += 1;
          const observedCorrelation = event.metadata?.correlationId;
          state.lastCorrelationId = typeof observedCorrelation === 'string' ? observedCorrelation : undefined;
        }
      })
      .build();

    const projectedEvents = (stream.get('order-1') ?? []).map((event, index): ProjectionEvent => ({
      aggregateType: 'order',
      aggregateId: String((event.payload as { orderId?: string }).orderId ?? 'order-1'),
      type: event.type,
      payload: event.payload as Record<string, unknown>,
      sequence: index + 1,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      metadata: event.metadata as Record<string, unknown> | undefined
    }));

    const subscription: IEventSubscription = {
      poll: async (cursor: Checkpoint, batchSize: number) => {
        const events = projectedEvents
          .filter((event) => event.sequence > cursor.sequence)
          .slice(0, batchSize);
        const last = events[events.length - 1];
        return {
          events,
          nextCursor: last ? { sequence: last.sequence, timestamp: last.timestamp } : cursor
        };
      }
    };

    const projectionStore = new InMemoryProjectionStore<{ count: number; lastCorrelationId?: string }>();
    const daemon = new ProjectionDaemon({
      projection,
      subscription,
      store: projectionStore,
      inspection: (event) => {
        inspectionEvents.push(event);
      },
      telemetryAdapterId: 'default'
    });

    await daemon.processBatch();

    const requiredHooks = [
      'command.ingress',
      'event.append',
      'outbox.enqueue',
      'outbox.dequeue',
      'side_effect.execution',
      'projection.batch.processing'
    ] as const;

    for (const hook of requiredHooks) {
      const envelope = inspectionEvents.find((event) => event.hook === hook);
      expect(envelope).toBeDefined();
      expect(envelope?.ids.correlationId).toBe(correlationId);

      const telemetry = (envelope?.payload as {
        telemetry?: {
          mode?: string;
          propagatedCarrier?: { correlationId?: string };
        };
      }).telemetry;

      expect(telemetry).toBeDefined();
      expect(telemetry?.mode).toBe('adapter');
      expect(telemetry?.propagatedCarrier?.correlationId).toBe(correlationId);
    }

    const projected = await projectionStore.load('order-1');
    expect(projected?.count).toBe(1);
    expect(projected?.lastCorrelationId).toBe(correlationId);
  });
});
