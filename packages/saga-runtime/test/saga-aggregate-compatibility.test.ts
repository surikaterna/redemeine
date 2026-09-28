import { describe, expect, it } from '@jest/globals';
import { createSagaAggregate as fromRoot } from '../src/index';
import { createSagaAggregate as fromSagaAggregate } from '../src/SagaAggregate';
import { createSagaAggregate as fromLegacyFactory, normalizeSagaAggregateState as normalizeLegacy } from '../src/sagaAggregateFactory';

const recordedAt = '2026-09-21T12:00:00.000Z';
const businessPayload = {
  schemaVersion: 1 as const,
  sagaKey: 'commerce/checkout',
  definitionVersion: 2,
  correlation: { type: 'string' as const, value: 'order-42' },
  sourceTriggerId: 'trigger-1',
  state: { status: 'pending' },
  recordedAt
};

describe('saga aggregate compatibility', () => {
  it('preserves the root, definition and legacy factory builder identity', () => {
    expect(fromRoot).toBe(fromSagaAggregate);
    expect(fromLegacyFactory).toBe(fromSagaAggregate);
    expect(normalizeLegacy({ businessState: { status: 'pending' } }).businessState).toEqual({ status: 'pending' });
  });

  it('keeps all six event types and business state schema for the default and custom names', () => {
    for (const name of ['saga', 'checkoutSaga']) {
      const aggregate = fromRoot({ aggregateName: name });
      expect(aggregate.aggregateType).toBe(name);
      expect(aggregate.eventCreators.instanceCreated({ id: 'one', sagaType: 'checkout', lifecycleState: 'active', createdAt: recordedAt }).type).toBe(
        `${name}.instance_created.event`
      );
      expect(aggregate.eventCreators.sourceEventObserved({ record: { eventType: 'orders.placed', observedAt: recordedAt } }).type).toBe(
        `${name}.source_event_observed.event`
      );
      expect(aggregate.eventCreators.stateTransitioned({ record: { fromState: 'active', toState: 'completed', transitionAt: recordedAt } }).type).toBe(
        `${name}.state_transitioned.event`
      );
      expect(aggregate.eventCreators.intentLifecycleRecorded({ record: { intentId: 'one', intentType: 'send', stage: 'created', recordedAt } }).type).toBe(
        `${name}.intent_lifecycle_recorded.event`
      );
      expect(
        aggregate.eventCreators.activityLifecycleRecorded({ record: { activityId: 'one', activityName: 'send', stage: 'started', recordedAt } }).type
      ).toBe(`${name}.activity_lifecycle_recorded.event`);
      expect(aggregate.eventCreators.businessStateRecorded(businessPayload)).toMatchObject({
        type: 'saga.business_state_recorded.event',
        payload: businessPayload
      });
    }
  });

  it('replays legacy state and replaces business state without changing persisted payloads', () => {
    const aggregate = fromLegacyFactory({ aggregateName: 'checkoutSaga' });
    const legacy = { ...aggregate.initialState, id: 'one', sagaType: 'checkout', lifecycleState: 'active' as const };
    const first = aggregate.eventCreators.businessStateRecorded(businessPayload);
    const second = aggregate.eventCreators.businessStateRecorded({ ...businessPayload, sourceTriggerId: 'trigger-2', state: { status: 'paid' } });
    const replayed = aggregate.apply(aggregate.apply(legacy, first), second);
    expect(replayed.businessState).toEqual({ status: 'paid' });
    expect(replayed.transitionVersion).toBe(2);
    const draft = { ...legacy };
    aggregate.applyToDraft(draft, first);
    expect(draft.businessState).toEqual(businessPayload.state);
  });
});
