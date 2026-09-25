import { createSaga, createSagaCommandsFor, defineOneWay, defineRequestResponse, defineSagaPlugin, type SagaPluginActionExecutionPayload } from '@redemeine/saga';

const plugin = defineSagaPlugin({ plugin_key: 'mailer', actions: {
  send: defineOneWay((id: string) => ({ id })),
  ask: defineRequestResponse((id: string) => ({ id }))
} });
type Payload = SagaPluginActionExecutionPayload<typeof plugin.actions.ask>;
const payload: Payload = { id: 'a1' };
// @ts-expect-error payload type survives installation
const wrongPayload: Payload = { id: 1 };
const aggregate = { aggregateType: 'invoice', pure: { eventProjectors: {} }, commandCreators: {
  pay: (id: string) => ({ type: 'custom.invoice.charge', payload: { id } })
} };
const command = createSagaCommandsFor(aggregate, 'a1', { sagaId: 's', correlationId: 'c', causationId: 'e' });
const commandPayload: string = command.pay('a1').execution_payload.payload.id;
// @ts-expect-error creator payload remains string
command.pay(42);
const definition = createSaga({ identity: { namespace: 'orders', name: 'wire', version: 1 }, plugins: [plugin] })
  .initialState(() => ({ count: 0 }))
  .onResponses({ ok: () => undefined })
  .onErrors({ failed: () => undefined })
  .start<{ id: string }>((state, start, ctx) => {
    state.count += 1;
    const oneWay = ctx.actions.mailer.send(start.id);
    const request = ctx.actions.mailer.ask(start.id).withData({ id: start.id })
      .onResponse(ctx.onResponse.ok).onError(ctx.onError.failed);
    const responseToken: 'ok' = request.routing_metadata.response_handler_key;
    const errorToken: 'failed' = request.routing_metadata.error_handler_key;
    const handlerData: string = request.routing_metadata.handler_data.id;
    // @ts-expect-error response token cannot be the error token
    const wrongResponseToken: 'failed' = request.routing_metadata.response_handler_key;
    // @ts-expect-error error token cannot be the response token
    const wrongErrorToken: 'ok' = request.routing_metadata.error_handler_key;
    // @ts-expect-error a completed request has mandatory routing
    const missingRouting: typeof request = { type: 'plugin-intent', plugin_key: 'mailer', action_name: 'ask', interaction: 'request_response', execution_payload: { id: start.id }, metadata: { sagaId: 's', correlationId: 'c', causationId: 'e' } };
    // @ts-expect-error request needs routing before emission
    const incomplete: typeof request = ctx.actions.mailer.ask(start.id);
    // @ts-expect-error error token not valid in response phase
    ctx.actions.mailer.ask(start.id).onResponse(ctx.onError.failed);
    // @ts-expect-error response token not valid in error phase
    ctx.actions.mailer.ask(start.id).onResponse(ctx.onResponse.ok).onError(ctx.onResponse.ok);
    // @ts-expect-error handler data id is a string
    const wrongData: number = request.routing_metadata.handler_data.id;
    void [oneWay, responseToken, errorToken, handlerData, incomplete, wrongData, wrongResponseToken, wrongErrorToken, missingRouting];
  }).correlateBy(start => start.id).build();
void [payload, wrongPayload, commandPayload, definition];
