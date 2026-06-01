/**
 * Temporary ambient type shim for @redemeine/saga.
 * All types are `any` because saga doesn't ship proper DTS yet.
 * TODO: Remove this file when @redemeine/saga exports proper types.
 * @see https://github.com/surikaterna/redemeine/issues/57
 */
declare module '@redemeine/saga' {
  export const runSagaHandler: any; // SAFETY: saga types from ambient declarations (no DTS available)
  export const runSagaErrorHandler: any; // SAFETY: saga types from ambient declarations (no DTS available)
  export const runSagaResponseHandler: any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaAggregateDefinition<A = any, B = any, C = any> = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaCommandCreators = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaErrorTokenKey<T = any> = string; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaExecutableHandlerFailureReason = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaIntent<T = any> = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaIntentMetadata = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaPluginManifestList = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaReducerOutput<T = any> = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaResponseHandlerTokenBindings = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaResponseHandlerTokenBinding<T = any> = any; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaResponseTokenKey<T = any> = string; // SAFETY: saga types from ambient declarations (no DTS available)
  export type SagaDefinition<A = any, B = any, C = any, D = any, E = any> = any; // SAFETY: saga types from ambient declarations (no DTS available)
}
