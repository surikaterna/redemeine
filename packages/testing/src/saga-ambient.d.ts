// Ambient declaration for @redemeine/saga (not yet strict-TS-clean)
// TODO: Remove once saga package passes strict typecheck and produces DTS
declare module '@redemeine/saga' {
  export const runSagaHandler: any;
  export const runSagaErrorHandler: any;
  export const runSagaResponseHandler: any;
  export type SagaAggregateDefinition<A = any, B = any, C = any> = any;
  export type SagaCommandCreators = any;
  export type SagaErrorTokenKey<T = any> = string;
  export type SagaExecutableHandlerFailureReason = any;
  export type SagaIntent<T = any> = any;
  export type SagaIntentMetadata = any;
  export type SagaPluginManifestList = any;
  export type SagaReducerOutput<T = any> = any;
  export type SagaResponseHandlerTokenBindings = any;
  export type SagaResponseHandlerTokenBinding<T = any> = any;
  export type SagaResponseTokenKey<T = any> = string;
  export type SagaDefinition<A = any, B = any, C = any, D = any, E = any> = any;
}
