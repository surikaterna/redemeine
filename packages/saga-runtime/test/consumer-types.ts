import { createSagaAggregate, normalizeSagaAggregateState, type SagaAggregate, type SagaAggregateState } from '@redemeine/saga-runtime';

interface CheckoutState {
  status: string;
  attempts: number;
}

const named = createSagaAggregate({ aggregateName: 'checkoutSaga' });
const literalName: 'checkoutSaga' = named.aggregateType;
const defaultName: 'saga' = createSagaAggregate().aggregateType;
const typed: SagaAggregate<CheckoutState> = createSagaAggregate<'saga', CheckoutState>();
const payload = {
  schemaVersion: 1 as const,
  sagaKey: 'commerce/checkout',
  definitionVersion: 2,
  correlation: { type: 'string' as const, value: 'order-42' },
  sourceTriggerId: 'trigger-1',
  state: { status: 'pending', attempts: 1 },
  recordedAt: '2026-09-21T12:00:00.000Z'
};

const command = typed.commandCreators.recordBusinessState(payload);
typed.process(typed.initialState, command);
const event = typed.eventCreators.businessStateRecorded(payload);
const projected: SagaAggregateState<CheckoutState> = typed.apply(typed.initialState, event);
const state: CheckoutState | null = normalizeSagaAggregateState(projected).businessState;
const projectorState = { ...typed.initialState };
typed.pure.eventProjectors.businessStateRecorded(projectorState, event);
const fromProjector: CheckoutState | null = projectorState.businessState;

// @ts-expect-error the recordBusinessState command creator retains the explicit state type
typed.commandCreators.recordBusinessState({ ...payload, state: { status: 'pending', attempts: 'wrong' } });
// @ts-expect-error known command creator requires an id and a saga type
typed.commandCreators.createInstance({ id: 'one' });
// @ts-expect-error known event creator requires a valid business state schema version
typed.eventCreators.businessStateRecorded({ ...payload, schemaVersion: 2 });

// The inherited process/apply signatures accept broad Command/Event and eventCreators has
// an index signature; they do not reject arbitrary names or payload shapes at compile time.
typed.process(typed.initialState, { type: 'unknown.command', payload: { unexpected: true } });
typed.apply(typed.initialState, { type: 'unknown.event', payload: { unexpected: true } });
const arbitraryCreator = typed.eventCreators.arbitraryEvent;
if (arbitraryCreator) arbitraryCreator({ unexpected: true });
void [literalName, defaultName, state, fromProjector];
