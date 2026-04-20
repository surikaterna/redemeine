import { describe, expect, it } from '@jest/globals';
import {
  createSaga,
  defineOneWay,
  defineSagaPlugin,
  runSagaHandler,
  type CanonicalSagaIdentityInput,
  type SagaAggregateEventByName,
  type SagaPluginOneWayIntent
} from '../src';

const REGISTRY_PRECEDENCE_IDENTITY: CanonicalSagaIdentityInput = {
  namespace: 'plugins',
  name: 'plugin_registry_precedence',
  version: 1
};

const EventAggregate = {
  aggregateType: 'event',
  pure: {
    eventProjectors: {
      received: (_state: unknown, _event: { payload: { id: string } }) => undefined
    }
  },
  commandCreators: {}
} as const;

const HttpPluginV1 = defineSagaPlugin({
  plugin_key: 'http',
  version: '1.0.0',
  actions: {
    get: defineOneWay((url: string) => ({ url, source: 'v1' as const })),
    post: defineOneWay((url: string) => ({ url, source: 'v1' as const }))
  }
});

const HttpPluginV2 = defineSagaPlugin({
  plugin_key: 'http',
  version: '2.0.0',
  actions: {
    get: defineOneWay((url: string) => ({ url, source: 'v2' as const })),
    put: defineOneWay((url: string) => ({ url, source: 'v2' as const }))
  }
});

describe('plugin registry composition and precedence', () => {
  it('composes duplicate plugin keys deterministically and uses last manifest override precedence', async () => {
    const saga = createSaga({
      identity: REGISTRY_PRECEDENCE_IDENTITY,
      plugins: [HttpPluginV1, HttpPluginV2] as const
    })
      .initialState(() => ({ attempts: 0 }))
      .on(EventAggregate, {
        received: async (state, _event, ctx) => {
          const httpActions = ctx.actions.http as unknown as {
            get: (url: string) => SagaPluginOneWayIntent<'http', 'get', { url: string; source: 'v1' | 'v2' }>;
            post: (url: string) => SagaPluginOneWayIntent<'http', 'post', { url: string; source: 'v1' | 'v2' }>;
            put: (url: string) => SagaPluginOneWayIntent<'http', 'put', { url: string; source: 'v1' | 'v2' }>;
          };

          const getIntent = httpActions.get('https://example.com/get');
          const postIntent = httpActions.post('https://example.com/post');
          const putIntent = httpActions.put('https://example.com/put');

          expect(getIntent.execution_payload.source).toBe('v2');
          expect(postIntent.execution_payload.source).toBe('v1');
          expect(putIntent.execution_payload.source).toBe('v2');

          state.attempts += 1;
        }
      })
      .build();

    expect(saga.plugins).toEqual([
      {
        plugin_key: 'http',
        plugin_kind: 'manifest',
        action_names: ['get', 'post', 'put'],
        version: '2.0.0'
      }
    ]);

    const output = await runSagaHandler(
      { attempts: 0 },
      { type: 'event.received.event', payload: { id: 'evt-1' } } as SagaAggregateEventByName<typeof EventAggregate, 'received'>,
      saga.handlers[0]!.handlers.received,
      {
        sagaId: 'saga-registry',
        correlationId: 'corr-registry',
        causationId: 'cause-registry'
      },
      {},
      [HttpPluginV1, HttpPluginV2] as const
    );

    const oneWayIntents = output.intents as readonly SagaPluginOneWayIntent<'http', 'get' | 'post' | 'put', { url: string; source: 'v1' | 'v2' }>[];
    expect(oneWayIntents).toHaveLength(3);
    expect(oneWayIntents[0]).toMatchObject({ action_name: 'get', execution_payload: { source: 'v2' } });
    expect(oneWayIntents[1]).toMatchObject({ action_name: 'post', execution_payload: { source: 'v1' } });
    expect(oneWayIntents[2]).toMatchObject({ action_name: 'put', execution_payload: { source: 'v2' } });
  });
});
