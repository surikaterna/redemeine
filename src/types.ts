// types.ts

export type EventType = `${string}.event`;
export type CommandType = `${string}.command`;

export interface Event<P = any, T extends EventType = EventType> {
  type: T;
  payload: P;
  metadata?: any;
}

export type ResolveEventName<AggregateName extends string, K, EOverrides> = 
  K extends keyof EOverrides 
    ? (EOverrides[K] extends EventType ? EOverrides[K] : `${AggregateName}.${Extract<K, string>}.event`)
    : `${AggregateName}.${Extract<K, string>}.event`;

/**
 * SMART EMITTER FACTORY
 * Checks the number of arguments in the event projector function.
 */
export type EventEmitterFactory<AggregateName extends string, E, EOverrides> = {
  [K in keyof E]: E[K] extends (...args: any[]) => any
    ? Parameters<E[K]>['length'] extends 0 | 1
      ? () => Event<void, ResolveEventName<AggregateName, K, EOverrides>> // Only state arg = zero payload
      : E[K] extends (state: any, event: Event<infer P, any>) => void
        ? [P] extends [void] | [undefined]
          ? () => Event<P, ResolveEventName<AggregateName, K, EOverrides>> // No payload arg
          : (payload: P) => Event<P, ResolveEventName<AggregateName, K, EOverrides>> // Payload arg required
        : (payload: any) => Event<any, ResolveEventName<AggregateName, K, EOverrides>>
    : never;
};