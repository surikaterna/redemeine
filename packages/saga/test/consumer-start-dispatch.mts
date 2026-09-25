import { createSaga, createSagaCommandsFor, runSagaStartHandler } from '@redemeine/saga';

const aggregate = {
  aggregateType: 'order',
  pure: { eventProjectors: {} },
  commandCreators: {
    local: (id: string) => ({ type: 'order.renamed.command' as const, payload: { id } })
  }
};
const commands = createSagaCommandsFor(aggregate, 'a1', {
  sagaId: 's1', correlationId: 'c1', causationId: 'e1'
});
const command: 'order.renamed.command' = commands.local('one').execution_payload.command;
// @ts-expect-error persisted identity is the creator override, not the local method name
const localKey: 'local' = commands.local('one').execution_payload.command;
// @ts-expect-error invalid command creator arguments
commands.local(7);
// @ts-expect-error unknown local command method
commands.missing('one');

const definition = createSaga({ identity: { namespace: 'orders', name: 'consumer', version: 1 } })
  .initialState(() => ({ ids: [] as string[] }))
  .start<{ id: string }>((state, start, ctx) => {
    state.ids.push(start.id);
    ctx.actions.core.dispatch(aggregate, start.id).local(start.id);
    // @ts-expect-error start input is not a number
    const invalidInput: number = start.id;
    // @ts-expect-error draft state has no count member
    state.count = 1;
    void invalidInput;
  })
  .correlateBy((start) => start.id)
  .build();

const metadata = { sagaId: 's1', correlationId: 'c1', causationId: 'e1' };
void runSagaStartHandler({ definition, startInput: { id: 'one' }, metadata });
// @ts-expect-error built start input retains the start type
void runSagaStartHandler({ definition, startInput: { wrong: 'one' }, metadata });
void command;
void localKey;
