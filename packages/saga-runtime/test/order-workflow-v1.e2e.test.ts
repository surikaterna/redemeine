import { describe, expect, it } from '@jest/globals';
import {
  createReferenceAdaptersV1,
  createRuntimeAuditLifecycleReadModel,
  createSagaExecutionBridge,
  type SagaIntent
} from '../src';
import {
  createOrderWorkflowSaga,
  InventoryPlugin,
  NotificationPlugin,
  orderWorkflowScenarios,
  PaymentsPlugin,
  ShippingPlugin,
  type OrderWorkflowScenario,
  type OrderWorkflowState
} from './fixtures/order-workflow-v1.fixture';

const isoAt = (secondsOffset: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, secondsOffset)).toISOString();

const sideEffectIntentTypes = new Set<SagaIntent['type']>(['plugin-one-way', 'plugin-request', 'run-activity']);

const countSideEffects = (intentTypes: readonly string[]): number => intentTypes
  .filter((intentType) => sideEffectIntentTypes.has(intentType as SagaIntent['type']))
  .length;

const runScenario = async (scenario: OrderWorkflowScenario) => {
  const adapters = createReferenceAdaptersV1();
  const bridge = createSagaExecutionBridge<OrderWorkflowState>({
    definition: createOrderWorkflowSaga(),
    adapters,
    runtimePlugins: [PaymentsPlugin, InventoryPlugin, ShippingPlugin, NotificationPlugin] as const
  });

  const dispatchResults = [] as Array<Awaited<ReturnType<typeof bridge.dispatch>>>;

  for (let eventIndex = 0; eventIndex < scenario.events.length; eventIndex += 1) {
    const event = scenario.events[eventIndex];
    const result = await bridge.dispatch({
      sagaId: scenario.sagaId,
      event: {
        ...event,
        aggregateType: 'orders',
        aggregateId: String(event.payload.orderId),
        eventId: `${scenario.sagaId}:evt:${eventIndex + 1}`,
        occurredAt: isoAt(eventIndex + 1)
      },
      nowIso: isoAt(eventIndex + 2)
    });

    expect(result.handled).toBe(true);
    expect(result.intents.map((intent) => intent.type)).toEqual(event.expectedIntentTypes);
    expect(result.adapterResults).toHaveLength(1);
    expect(result.adapterResults[0]?.persistedExecutions).toHaveLength(countSideEffects(event.expectedIntentTypes));

    dispatchResults.push(result);
  }

  return {
    adapters,
    bridge,
    dispatchResults
  };
};

describe('order workflow runtime v1 e2e', () => {
  for (const scenario of orderWorkflowScenarios) {
    it(`validates progression, intents, and audit behavior for ${scenario.name}`, async () => {
      const { adapters, bridge } = await runScenario(scenario);

      const sagaState = bridge.getSagaState(scenario.sagaId);
      expect(sagaState).toEqual({
        progression: scenario.expectedProgression,
        lastOrderId: String(scenario.events[scenario.events.length - 1]?.payload.orderId)
      });

      const expectedTotalIntents = scenario.events.reduce(
        (sum, event) => sum + event.expectedIntentTypes.length,
        0
      );
      const expectedTotalExecutions = scenario.events.reduce(
        (sum, event) => sum + countSideEffects(event.expectedIntentTypes),
        0
      );

      const aggregateState = bridge.getAggregateState(scenario.sagaId);
      expect(aggregateState.totals.observedEvents).toBe(scenario.events.length);
      expect(aggregateState.totals.intents).toBe(expectedTotalIntents);

      const persistedExecutions = adapters.persistence.listIntentExecutionsBySagaId(scenario.sagaId);
      expect(persistedExecutions).toHaveLength(expectedTotalExecutions);
      expect(persistedExecutions.every((entry) => entry.status === 'succeeded')).toBe(true);

      const readModel = createRuntimeAuditLifecycleReadModel();
      readModel.upsertSaga(aggregateState);
      for (const execution of persistedExecutions) {
        readModel.upsertIntentExecution(execution);
      }

      const sagaHistory = readModel.querySagaLifecycleHistory({
        sagaId: scenario.sagaId,
        limit: 500
      });

      expect(sagaHistory.items.filter((entry) => entry.kind === 'source_event_observed')).toHaveLength(scenario.events.length);
      expect(sagaHistory.items.filter((entry) => entry.kind === 'intent_lifecycle_recorded')).toHaveLength(expectedTotalIntents);

      const executionHistory = readModel.queryIntentExecutionLifecycleHistory({
        sagaId: scenario.sagaId,
        limit: 500
      });
      const executionIds = new Set(persistedExecutions.map((entry) => entry.id));

      for (const executionId of executionIds) {
        const entries = executionHistory.items.filter((entry) => entry.executionId === executionId);
        expect(entries.map((entry) => entry.kind)).toContain('created');
      }

      const scheduled = adapters.scheduler.listScheduled().map((entry) => entry.id);
      if (scenario.expectedProgression.includes('packed') && !scenario.expectedProgression.includes('delivered')) {
        expect(scheduled).toEqual(['delivery-followup']);
      }
      if (scenario.expectedProgression.includes('delivered')) {
        expect(scheduled).toEqual([]);
      }
    });
  }
});
