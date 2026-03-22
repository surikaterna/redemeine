// types.ts

export type EventType = `${string}.event`;
export type CommandType = `${string}.command`;

export interface NamingStrategy {
  command: (aggregateName: string, prop: string) => string;
  event: (aggregateName: string, prop: string) => string;
}

export type SelectorsMap<S> = Record<string, (state: S, ...args: any[]) => any>;

export interface Event<P = any, T extends EventType | string = EventType> {
  type: T;
  payload: P;
  metadata?: any;
}

export interface Command<P = any, T extends CommandType | string = CommandType> {
  type: T;
  payload: P;
  metadata?: any;
}

export interface BaseEntity {
  id: string | number;
}

export type Collection<T extends BaseEntity> = T[];

export const EntityArray = {
  upsert<T extends BaseEntity>(array: T[], item: T): void {
    const index = array.findIndex(e => e.id === item.id);
    if (index >= 0) {
      Object.assign(array[index], item);
    } else {
      array.push(item);
    }
  },
  update<T extends BaseEntity>(array: T[], id: string | number, patch: Partial<T>): void {
    const index = array.findIndex(e => e.id === id);
    if (index >= 0) {
      Object.assign(array[index], patch);
    }
  },
  remove<T extends BaseEntity>(array: T[], id: string | number): void {
    const index = array.findIndex(e => e.id === id);
    if (index >= 0) {
      array.splice(index, 1);
    }
  }
};

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
      ? (...args: [...ids: (string | number)[]]) => Event<void, any>
      : E[K] extends (state: any, event: Event<infer P, any>) => void
        ? [P] extends [void] | [undefined]
          ? (...args: [...ids: (string | number)[]]) => Event<void, any>
          : (...args: [...ids: (string | number)[], payload: P]) => Event<P, any>
        : (...args: [...ids: (string | number)[], payload: any]) => Event<any, any>
    : never;
} & Record<string, (...args: any[]) => Event<any, any>>;