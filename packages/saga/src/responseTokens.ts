export type SagaResponseHandlerPhase = 'response' | 'error' | 'retry';

declare const sagaResponseHandlerTokenBrand: unique symbol;

type SagaPhaseToken<TToken extends string, TPhase extends SagaResponseHandlerPhase> = TToken & {
  readonly [sagaResponseHandlerTokenBrand]: TPhase;
};

export type TResponseToken<TToken extends string = string> = SagaPhaseToken<TToken, 'response'>;

export type TErrorToken<TToken extends string = string> = SagaPhaseToken<TToken, 'error'>;

export type TRetryToken<TToken extends string = string> = SagaPhaseToken<TToken, 'retry'>;

export interface SagaResponseHandlerTokenBinding<
  TPhase extends SagaResponseHandlerPhase = SagaResponseHandlerPhase
> {
  readonly phase: TPhase;
}

export type SagaResponseHandlerTokenBindings = Record<string, SagaResponseHandlerTokenBinding>;

export type SagaResponseTokenKey<TBindings extends SagaResponseHandlerTokenBindings> =
  SagaResponseHandlerKeysByPhase<TBindings, 'response'>;

export type SagaErrorTokenKey<TBindings extends SagaResponseHandlerTokenBindings> =
  SagaResponseHandlerKeysByPhase<TBindings, 'error'>;

export type SagaRetryTokenKey<TBindings extends SagaResponseHandlerTokenBindings> =
  SagaResponseHandlerKeysByPhase<TBindings, 'retry'>;

type SagaResponseHandlerTokenForPhase<
  TToken extends string,
  TPhase extends SagaResponseHandlerPhase
> = TPhase extends 'response'
  ? TResponseToken<TToken>
  : TPhase extends 'error'
    ? TErrorToken<TToken>
    : TRetryToken<TToken>;

export type SagaResponseHandlerKeysByPhase<
  TBindings extends SagaResponseHandlerTokenBindings,
  TPhase extends SagaResponseHandlerPhase
> = {
  [THandlerKey in keyof TBindings & string]: TBindings[THandlerKey]['phase'] extends TPhase
    ? THandlerKey
    : never;
}[keyof TBindings & string];

export type SagaResponseHandlerTokenNamespace<
  TBindings extends SagaResponseHandlerTokenBindings,
  TPhase extends SagaResponseHandlerPhase
> = {
  readonly [THandlerKey in SagaResponseHandlerKeysByPhase<TBindings, TPhase>]: SagaResponseHandlerTokenForPhase<
    THandlerKey,
    TPhase
  >;
};

export type SagaResponseHandlerTokenAccess<TBindings extends SagaResponseHandlerTokenBindings> = {
  readonly onResponse: SagaResponseHandlerTokenNamespace<TBindings, 'response'>;
  readonly onError: SagaResponseHandlerTokenNamespace<TBindings, 'error'>;
  readonly onRetry: SagaResponseHandlerTokenNamespace<TBindings, 'retry'>;
};

export type SagaBindingsFromResponseHandlers<THandlers extends Record<string, unknown>> = {
  [TKey in keyof THandlers & string]: SagaResponseHandlerTokenBinding<'response'>;
};

export type SagaBindingsFromErrorHandlers<THandlers extends Record<string, unknown>> = {
  [TKey in keyof THandlers & string]: SagaResponseHandlerTokenBinding<'error'>;
};

export type SagaBindingsFromRetryHandlers<THandlers extends Record<string, unknown>> = {
  [TKey in keyof THandlers & string]: SagaResponseHandlerTokenBinding<'retry'>;
};
