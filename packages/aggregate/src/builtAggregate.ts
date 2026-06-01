import type { Event, Command, AggregateHooks, PluginExtensions, RedemeinePlugin } from '@redemeine/kernel';
import type { AggregateEntityRegistry, MountedStructureMetadata } from './createAggregate';
import type { AnyFunction } from './redemeineComponent';

/**
 * The compiled output of createAggregate(...).build().
 * Represents a fully configured aggregate ready for use with Mirage, projections, or testing.
 */
export interface BuiltAggregate<
    S = unknown,
    // SAFETY: `any` in generic defaults required for structural subtyping when BuiltAggregate is used as a constraint
    M extends Record<string, any> = Record<string, any>,
    E = unknown,
    Registry extends AggregateEntityRegistry = AggregateEntityRegistry,
    Sel extends Record<string, any> = Record<string, any>,
    TPlugins extends PluginExtensions = {}
> {
    /** The aggregate type identifier (e.g., 'invoice', 'order') */
    aggregateType: string;
    /** Default initial state for new aggregate instances */
    initialState: S;
    /** Processes a command against state, returning domain events */
    process: (state: S, command: Command<unknown, string>) => Event[];
    /** Applies an event immutably via Immer — returns new state */
    apply: (state: S, event: Event) => S;
    /** Applies an event to a mutable draft — used by projections to avoid double-Immer */
    applyToDraft: (draft: S, event: Event) => void;
    /** Type-safe command creator functions keyed by command name */
    commandCreators: {
        // SAFETY: `any[]` required for variadic tuple inference in command arg spreading
        [K in keyof M]: M[K] extends { args: infer Args; payload: infer P }
            ? (...args: Args extends any[] ? Args : never) => { type: string; payload: P }
            : [M[K]] extends [void] | [undefined] | [never]
                ? () => { type: string; payload: void }
                : (payload: M[K]) => { type: string; payload: M[K] };
    };
    /** Event creator/emitter factory functions */
    eventCreators: E;
    /** Raw domain functions for isolated unit testing — do NOT use to bypass Mirage dispatch */
    pure: {
        commandProcessors: Record<string, AnyFunction>;
        eventProjectors: Record<string, AnyFunction>;
    };
    /** Query selectors derived from state */
    selectors: Sel;
    /** Lifecycle hooks for command/event interception */
    hooks?: AggregateHooks<S>;
    /** Entity/collection mount metadata */
    mounts?: Record<string, MountedStructureMetadata>;
    /** Command and event metadata */
    // SAFETY: `any` in metadata values — consumed by plugins with heterogeneous meta shapes
    metadata?: {
        commands?: Record<string, { meta?: any }>;
        events?: Record<string, { meta?: any }>;
    };
    /** Resolved type strings for commands and events */
    types?: {
        commands: Record<string, string>;
        events: Record<string, string>;
    };
    /** Registered plugins */
    plugins?: RedemeinePlugin<TPlugins>[];
    /** Phantom type for entity registry inference */
    __registryType?: Registry;
}
