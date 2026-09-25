import { describe, expect, it, jest } from '@jest/globals';
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
      await expect(runSagaStartHandler({ definition, startInput: { id: 'one' }, metadata }))
        .rejects.toThrow(TypeError);
    }
  });

  it('drafts initial state without mutating it and returns all intents including routing data', async () => {
    const original = { count: 0, ids: [] as string[] };
    const notify = defineSagaPlugin({ plugin_key: 'notify', actions: {
      send: defineOneWay((id: string) => ({ id })),
      ask: defineRequestResponse((id: string) => ({ id }))
    } });
    const definition = createSaga({ identity, plugins: [notify] as const })
      .initialState(() => original)
      .onResponses({ ok: () => undefined })
      .onErrors({ fail: () => undefined })
      .start<{ id: string }>(async (state, start, ctx) => {
        await Promise.resolve();
        state.count += 1;
        state.ids.push(start.id);
        ctx.actions.core.dispatch(aggregate, start.id).rename(start.id);
        ctx.actions.notify.send(start.id);
        ctx.actions.notify.ask(start.id).withData({ id: start.id })
          .onResponse(ctx.onResponse.ok).onError(ctx.onError.fail);
      }).correlateBy((start) => start.id).build();
    const output = await runSagaStartHandler({
      definition, startInput: { id: 'order-2' }, metadata,
      responseHandlers: { ok: { phase: 'response' }, fail: { phase: 'error' } },
      plugins: [notify] as const
    });
    expect(output.state).toEqual({ count: 1, ids: ['order-2'] });
    expect(original).toEqual({ count: 0, ids: [] });
    expect(output.intents).toHaveLength(3);
    expect(output.intents[0]).toMatchObject({ execution_payload: { command: 'custom.order.reserve' }, metadata });
    expect(output.intents[2]).toMatchObject({
      routing_metadata: { handler_data: { id: 'order-2' }, response_handler_key: 'ok', error_handler_key: 'fail' }, metadata
    });
  });
});
