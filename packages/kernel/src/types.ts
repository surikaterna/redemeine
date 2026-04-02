import { ReadonlyDeep } from './utils/types/ReadonlyDeep';

// types.ts

/**
 * The foundational string type for Redemeine events. Used to enforce proper suffixing in type boundaries.
 */
export type EventType = `${string}.event`;

/**
 * The foundational string type for Redemeine commands. Used to enforce proper suffixing in type boundaries.
 */
export type CommandType = `${string}.command`;

export type EnvelopeHeaders = Record<string, unknown>;

/**
 * Interface controlling the "Targeted Naming" engine used to automatically route and identify events and commands.
 */
export interface NamingStrategy {
  /**
   * Transforms a given property name (and optionally its path) into a fully qualified command type string.
   * 
   * @example
   * // Given aggregate 'order' and prop 'cancelItem', standard output: 'order.cancel_item.command'
   */
  command: (aggregateName: string, prop: string, path?: string) => string;
  
  /**
   * Transforms a given property name (and optionally its path) into a fully qualified event type string.
   * 
   * @example
   * // Given aggregate 'order' and prop 'itemCancelled', standard output: 'order.item_cancelled.event'
   */
  event: (aggregateName: string, prop: string, path?: string) => string;
}

export interface AggregateHooks<State> {
  onBeforeCommand?: (command: CommandType | Command<any, any>, state: ReadonlyDeep<State>) => void;
  onAfterCommand?: (command: CommandType | Command<any, any>, events: Event<any, any>[], state: ReadonlyDeep<State>) => void;
  onEventApplied?: (event: Event<any, any>, state: ReadonlyDeep<State>) => void;
}

export interface PluginExtensions {
  intents?: Record<string, unknown>;
  context?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export type PluginIntents<TPlugins extends PluginExtensions = {}> =
  TPlugins['intents'] extends Record<string, unknown>
    ? TPlugins['intents']
    : never;

export type PluginContext<TPlugins extends PluginExtensions = {}> =
  TPlugins['context'] extends Record<string, unknown>
    ? TPlugins['context']
    : {};

export type PluginMeta<TPlugins extends PluginExtensions = {}> =
  TPlugins['meta'] extends Record<string, unknown>
    ? TPlugins['meta']
    : Record<string, unknown>;

export interface CommandInterceptorContext<
  TPlugins extends PluginExtensions = {},
  TPayload = unknown
> {
  pluginKey: string;
  aggregateId: string;
  commandType: string;
  payload: TPayload;
  meta: PluginMeta<TPlugins> | undefined;
}

export interface EventInterceptorContext<
  TPlugins extends PluginExtensions = {},
  TPayload = unknown
> {
  pluginKey: string;
  aggregateId: string;
  eventType: string;
  payload: TPayload;
  meta: PluginMeta<TPlugins> | undefined;
}

export interface AfterCommitContext<
  TPlugins extends PluginExtensions = {},
  TEvent extends Event<any, any> = Event<any, any>
> {
  pluginKey: string;
  aggregateId: string;
  events: TEvent[];
  intents: PluginIntents<TPlugins>;
}

export interface RedemeinePlugin<
  TExtensions extends PluginExtensions = {}
> {
  key: string;
  onBeforeCommand?: (ctx: CommandInterceptorContext<TExtensions, unknown>) => void | Promise<void>;
  onBeforeAppend?: (ctx: EventInterceptorContext<TExtensions, unknown>) => unknown | void | Promise<unknown | void>;
  onHydrateEvent?: (ctx: EventInterceptorContext<TExtensions, unknown>) => unknown | void | Promise<unknown | void>;
  onAfterCommit?: (ctx: AfterCommitContext<TExtensions>) => void | Promise<void>;
}

export type ExtractPluginExtensions<TPlugin> =
  TPlugin extends RedemeinePlugin<infer TExtensions>
    ? TExtensions
    : {};

export type UnionToIntersection<U> = (
  U extends unknown ? (arg: U) => void : never
) extends ((arg: infer I) => void)
  ? I
  : never;

export type MergePluginExtensions<TPlugins extends readonly RedemeinePlugin<any>[]> =
  UnionToIntersection<ExtractPluginExtensions<TPlugins[number]>>;

/**
 * Represents a dictionary mapping string keys to selector functions.
 * Selectors are pure functions injecting localized state queries directly into command contexts.
 */
export type SelectorsMap<S> = Record<string, (state: ReadonlyDeep<S>, ...args: any[]) => any>;

export type CommandContext<TIntents extends Record<string, unknown>> = {
  [K in keyof TIntents]: (payload: TIntents[K]) => { command: K; payload: TIntents[K] };
} & {
  [key: string]: (payload: unknown) => { command: string; payload: unknown };
};

export type CommandIntents<TCommands> = {
  [K in keyof TCommands]: TCommands[K] extends { payload: infer P }
    ? P
    : TCommands[K];
};

/**
 * A foundational building block representing a domain event. 
 * Records an intent that has successfully altered the aggregate state.
 */
export interface Event<P = any, T extends EventType | string = EventType> {
  id?: string;
  type: T;
  payload: P;
  headers?: EnvelopeHeaders;
  metadata?: any;
}

/**
 * A foundational building block representing a domain command.
 * Requests a state change and houses the necessary payload for processing validation.
 */
export interface Command<P = any, T extends CommandType | string = CommandType> {
  id?: string;
  type: T;
  payload: P;
  headers?: EnvelopeHeaders;
  metadata?: any;
}

export type CommandResult<TEvent, TPlugins extends PluginExtensions = {}> =
  | TEvent[]
  | TEvent
  | (PluginIntents<TPlugins> extends never
      ? {
          events: TEvent[];
          intents?: never;
        }
      : {
          events: TEvent[];
          intents: PluginIntents<TPlugins>;
        });

export type PluginHookName = 'onBeforeCommand' | 'onHydrateEvent' | 'onBeforeAppend' | 'onAfterCommit';

export class RedemeinePluginHookError extends Error {
  readonly pluginKey: string;
  readonly hook: PluginHookName;
  readonly aggregateId: string;
  readonly cause: unknown;

  constructor(args: {
    pluginKey: string;
    hook: PluginHookName;
    aggregateId: string;
    cause: unknown;
  }) {
    const causeMessage = args.cause instanceof Error ? `: ${args.cause.message}` : '';
    super(`Plugin hook failed (${args.pluginKey}.${args.hook})${causeMessage}`);
    this.name = 'RedemeinePluginHookError';
    this.pluginKey = args.pluginKey;
    this.hook = args.hook;
    this.aggregateId = args.aggregateId;
    this.cause = args.cause;
  }
}

/**
 * Describes the originating command attached to emitted event metadata.
 * This supports command-to-event traceability, including one-command-many-events flows.
 */
export interface EventCommandLink<P = any, T extends CommandType | string = CommandType> {
  id?: string;
  type: T;
  summary?: P;
  storeRef?: string;
}

/**
 * The foundational base for state objects that are treated as entities.
 * Enforces a required structural `id`.
 */
export interface BaseEntity {
  id: string | number;
}

/**
 * Represents the underlying record map managed by the `EntityArray` utility.
 * Foundational for strong typing arrays of `BaseEntity`.
 */
export type Collection<T extends BaseEntity> = T[];

/**
 * Utility toolkit for safely managing collections (arrays) of entities within Immer event handlers.
 * Ensures references are correctly mutated without mutating the entire array instance, preserving predictability.
 */
export const EntityArray = {
  /**
   * Updates an entity by ID if it exists; otherwise, appends it strictly.
   * 
   * @example
   * EntityArray.upsert(state.orderLines, { id: 'line-1', sku: 'A1' });
   */
  upsert<T extends BaseEntity>(array: T[], item: T): void {
    const index = array.findIndex(e => e.id === item.id);
    if (index >= 0) {
      Object.assign(array[index], item);
    } else {
      array.push(item);
    }
  },

  /**
   * Applies partial updates to an entity matching the given ID. Fails silently if missing.
   * 
   * @example
   * EntityArray.update(state.orderLines, 'line-1', { isCancelled: true });
   */
  update<T extends BaseEntity>(array: T[], id: string | number, patch: Partial<T>): void {
    const index = array.findIndex(e => e.id === id);
    if (index >= 0) {
      Object.assign(array[index], patch);
    }
  },

  /**
   * Slices the entity matching the ID out of the collection entirely.
   * 
   * @example
   * EntityArray.remove(state.orderLines, 'line-1');
   */
  remove<T extends BaseEntity>(array: T[], id: string | number): void {
    const index = array.findIndex(e => e.id === id);
    if (index >= 0) {
      array.splice(index, 1);
    }
  }
};

