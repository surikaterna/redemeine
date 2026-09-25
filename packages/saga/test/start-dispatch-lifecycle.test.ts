import { describe, expect, it, jest } from '@jest/globals';
import { immerable, type Draft } from 'immer';
import {
  createSaga,
  createSagaCommandsFor,
  defineOneWay,
  defineRequestResponse,
  defineSagaPlugin,
  runSagaStartHandler
} from '../src';

const identity = { namespace: 'orders', name: 'start_dispatch', version: 1 };
const metadata = { sagaId: 's1', correlationId: 'c1', causationId: 'e1' };
interface StartState {
  readonly count: number;
  readonly nested: { readonly ids: string[] };
}
const aggregate = {
  aggregateType: 'order',
  pure: { eventProjectors: {} },
  commandCreators: {
    defaultName: jest.fn((id: string) => ({ type: 'defaultName' as const, payload: { id } })),
    reserve: jest.fn((id: string) => ({ type: 'order.reserve.command' as const, payload: { id } })),
    rename: jest.fn((id: string) => ({ type: 'custom.order.reserve' as const, payload: { id } }))
  }
};

describe('saga SDK initiation and command identity', () => {
  it('keeps the local method but emits the creator identity and payload once', () => {
    const commands = createSagaCommandsFor(aggregate, 'order-1', metadata, { causationId: 'override' });
    expect(commands.defaultName('zero').execution_payload.command).toBe('defaultName');
    expect(commands.reserve('one')).toMatchObject({
      execution_payload: { command: 'order.reserve.command', payload: { id: 'one' }, aggregateId: 'order-1' },
      metadata: { ...metadata, causationId: 'override' }
    });
    expect(commands.rename('two').execution_payload.command).toBe('custom.order.reserve');
    expect(aggregate.commandCreators.reserve).toHaveBeenCalledTimes(1);
    expect(aggregate.commandCreators.defaultName).toHaveBeenCalledTimes(1);
    expect(aggregate.commandCreators.rename).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid creator output before emission', async () => {
    for (const envelope of [
      { type: '', payload: {} },
      { type: ' invalid ', payload: {} },
      { type: 17, payload: {} },
      { type: 'valid' },
      { type: 'valid', payload: undefined }
    ]) {
      const invalid = {
        aggregateType: 'order', pure: { eventProjectors: {} },
        commandCreators: { invalid: () => envelope }
      };
      const definition = createSaga({ identity }).initialState(() => ({ count: 0 }))
        .start<{ id: string }>((state, start, ctx) => {
          state.count += 1;
          ctx.commandsFor(invalid, start.id).invalid();
        }).correlateBy((start) => start.id).build();
      await expect(runSagaStartHandler({
        definition, startInput: { id: 'one' }, metadata, plugins: [], responseHandlers: {}
      }))
        .rejects.toThrow(TypeError);
    }
  });

  it('drafts initial state without mutating it and returns all intents including routing data', async () => {
    const original: StartState = { count: 0, nested: { ids: [] } };
    const notify = defineSagaPlugin({ plugin_key: 'notify', actions: {
      send: defineOneWay((id: string) => ({ id })),
      ask: defineRequestResponse((id: string) => ({ id }))
    } });
    const definition = createSaga({ identity, plugins: [notify] as const })
      .initialState(() => original)
      .onResponses({ ok: () => undefined })
      .onErrors({ fail: () => undefined })
      .onRetries({ again: () => undefined })
      .start<{ id: string }>(async (state, start, ctx) => {
        await Promise.resolve();
        state.count += 1;
        state.nested.ids.push(start.id);
        ctx.actions.core.dispatch(aggregate, start.id).rename(start.id);
        ctx.actions.notify.send(start.id);
        ctx.actions.notify.ask(start.id).withData({ id: start.id })
          .onResponse(ctx.onResponse.ok).onError(ctx.onError.fail);
        void ctx.onRetry.again;
      }).correlateBy((start) => start.id).build();
    const output = await runSagaStartHandler({
      definition, startInput: { id: 'order-2' }, metadata,
      responseHandlers: { ok: { phase: 'response' }, fail: { phase: 'error' }, again: { phase: 'retry' } },
      plugins: [notify] as const
    });
    expect(output.state).toEqual({ count: 1, nested: { ids: ['order-2'] } });
    expect(original).toEqual({ count: 0, nested: { ids: [] } });
    expect(output.intents).toHaveLength(3);
    expect(output.intents[0]).toMatchObject({ execution_payload: { command: 'custom.order.reserve' }, metadata });
    expect(output.intents[2]).toMatchObject({
      routing_metadata: { handler_data: { id: 'order-2' }, response_handler_key: 'ok', error_handler_key: 'fail' }, metadata
    });
  });

  it('revokes escaped drafts on immediate and awaited failures without returning partial intents', async () => {
    for (const asynchronous of [false, true]) {
      const original: StartState = { count: 0, nested: { ids: [] } };
      const escaped: { draft?: Draft<StartState> } = {};
      const failure = new Error('start failed');
      const definition = createSaga({ identity }).initialState(() => original)
        .start<{ id: string }>((state, _start, ctx) => {
          escaped.draft = state;
          state.count += 1;
          ctx.schedule('partial', 100);
          if (asynchronous) {
            return Promise.resolve().then(() => { throw failure; });
          }
          throw failure;
        }).correlateBy((start) => start.id).build();

      await expect(runSagaStartHandler({
        definition, startInput: { id: 'one' }, metadata, plugins: [], responseHandlers: {}
      })).rejects.toBe(failure);
      expect(original).toEqual({ count: 0, nested: { ids: [] } });
      expect(escaped.draft).toBeDefined();
      expect(() => {
        if (escaped.draft === undefined) throw new Error('handler did not receive a draft');
        escaped.draft.count += 1;
      }).toThrow();
      expect(original).toEqual({ count: 0, nested: { ids: [] } });
    }
  });

  it('accepts Immer draftable object shapes but rejects non-draftable classes before the handler', async () => {
    // This SDK helper drafts arrays and marked classes; durable JSON state validation is a separate runtime boundary.
    class MarkedState { [immerable] = true; count = 0; }
    class UnmarkedState { count = 0; }
    for (const initialState of [() => ({ count: 0 }), () => [0], () => new MarkedState()]) {
      const handler = jest.fn((state: Draft<{ count: number } | number[] | MarkedState>) => {
        if ('count' in state) state.count += 1;
        else state.push(1);
      });
      const definition = createSaga({ identity }).initialState(initialState).start(handler).correlateBy(() => 'one').build();
      await expect(runSagaStartHandler({ definition, startInput: undefined, metadata, plugins: [], responseHandlers: {} }))
        .resolves.toBeDefined();
      expect(handler).toHaveBeenCalledTimes(1);
    }
    const handler = jest.fn((_state: Draft<UnmarkedState>) => undefined);
    const definition = createSaga({ identity }).initialState(() => new UnmarkedState()).start(handler).correlateBy(() => 'one').build();
    await expect(runSagaStartHandler({ definition, startInput: undefined, metadata, plugins: [], responseHandlers: {} }))
      .rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
