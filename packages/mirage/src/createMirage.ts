import { type Command, type Event, type RedemeinePlugin, type ReadonlyDeep, createReadonlyDeepProxy } from '@redemeine/kernel';
import type { AggregateEntityRegistry, BuiltAggregate } from '@redemeine/aggregate';
import { MirageCore } from './MirageCore';
import { hydrateStateFromEvents } from './hydration';
import { createProxyContext } from './proxy/deepProxy';
import type {
    Mirage,
    MirageOptions,
    HydrationEvents,
    BuiltAggregateCommands,
    BuiltAggregateState,
    BuiltAggregateRegistry,
    BuiltAggregateSelectors,
    BuiltAggregatePlugins,
    MountMetadata,
    InvocationContext,
    DispatchResult,
} from './mirage.types';
import { MirageCoreSymbol } from './mirage.types';

export { HYDRATION_REPLAY_YIELD_THRESHOLD } from './hydration';
export * from './mirage.types';

// SAFETY: BuiltAggregate generic params are erased at runtime; type inference requires `any` in constraint position
export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string
): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>;
export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string,
    setup: MirageOptions<BuiltAggregatePlugins<BA>> & { snapshot?: BuiltAggregateState<BA>; events: HydrationEvents<Event> }
): Promise<Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>>;
export function createMirage<BA extends BuiltAggregate<any, any, any, any, any>>(
    builder: BA,
    id: string,
    setup?: MirageOptions<BuiltAggregatePlugins<BA>> & { snapshot?: BuiltAggregateState<BA>; events?: HydrationEvents<Event> }
): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>> | Promise<Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>> {

    const makeMirage = (state: BuiltAggregateState<BA>, plugins: RedemeinePlugin[]): Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>> => {
        const core = new MirageCore(builder, id, state, setup?.contract, setup?.strict, plugins);
        const mounts = (builder.mounts || {}) as Record<string, MountMetadata>;
        // SAFETY: selectors have heterogeneous signatures; unified type requires `any` for args/return
        const selectors = (builder.selectors || {}) as Record<string, (...args: any[]) => any>;

        const ctx = createProxyContext(core, mounts, selectors, builder);
        const rootContext: InvocationContext = { idsPayload: {}, packPrefix: [] };

        return ctx.makeDeepProxy([], [], rootContext) as Mirage<BuiltAggregateState<BA>, BuiltAggregateCommands<BA>, BuiltAggregateRegistry<BA>, BuiltAggregateSelectors<BA>>;
    };

    const baseState = setup?.snapshot ?? builder.initialState;
    const setupEvents = setup?.events;
    const plugins = [...(builder.plugins || []), ...(setup?.plugins || [])] as RedemeinePlugin[];

    if (!setupEvents) {
        return makeMirage(baseState, plugins);
    }

    return (async () => {
        const hydratedState = await hydrateStateFromEvents(builder, id, baseState, setupEvents, plugins);
        return makeMirage(hydratedState, plugins);
    })();
}

/**
 * Returns a copy of all uncommitted events currently buffered by a Mirage instance.
 */
export function extractUncommittedEvents<S, M extends Record<string, unknown>, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, unknown> = {}>(
    mirage: Mirage<S, M, Registry, Sel>
): Event[] {
    // SAFETY: accessing internal symbol on opaque Proxy-wrapped Mirage
    const core = (mirage as any)[MirageCoreSymbol] as MirageCore<S>;
    if (!core) {
        throw new Error('Target is not a valid Mirage Instance.');
    }
    return [...core.uncommitted];
}

/**
 * Clears the uncommitted event buffer for a Mirage instance.
 */
export function clearUncommittedEvents<S, M extends Record<string, unknown>, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, unknown> = {}>(
    mirage: Mirage<S, M, Registry, Sel>
): void {
    // SAFETY: accessing internal symbol on opaque Proxy-wrapped Mirage
    const core = (mirage as any)[MirageCoreSymbol] as MirageCore<S>;
    if (!core) {
        throw new Error('Target is not a valid Mirage Instance.');
    }
    core.clearPendingResults();
}

/**
 * Returns a readonly deep copy of the current state for a Mirage instance.
 */
export function extractState<S, M extends Record<string, unknown>, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, unknown> = {}>(
    mirage: Mirage<S, M, Registry, Sel>
): ReadonlyDeep<S> {
    // SAFETY: accessing internal symbol on opaque Proxy-wrapped Mirage
    const core = (mirage as any)[MirageCoreSymbol] as MirageCore<S>;
    if (!core) {
        throw new Error('Target is not a valid Mirage Instance.');
    }
    return createReadonlyDeepProxy(core.state) as ReadonlyDeep<S>;
}

/**
 * Subscribes to state changes on a Mirage instance.
 * Returns an unsubscribe function.
 */
export function subscribe<S, M extends Record<string, unknown>, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, unknown> = {}>(
    mirage: Mirage<S, M, Registry, Sel>,
    listener: (state: S) => void
): () => void {
    // SAFETY: accessing internal symbol on opaque Proxy-wrapped Mirage
    const core = (mirage as any)[MirageCoreSymbol] as MirageCore<S>;
    if (!core) {
        throw new Error('Target is not a valid Mirage Instance.');
    }
    return core.subscribe(listener);
}

/**
 * Dispatches a raw command to a Mirage instance.
 */
export function dispatch<S, M extends Record<string, unknown>, Registry extends AggregateEntityRegistry = {}, Sel extends Record<string, unknown> = {}>(
    mirage: Mirage<S, M, Registry, Sel>,
    command: Command
): DispatchResult<S> {
    // SAFETY: accessing internal symbol on opaque Proxy-wrapped Mirage
    const core = (mirage as any)[MirageCoreSymbol] as MirageCore<S>;
    if (!core) {
        throw new Error('Target is not a valid Mirage Instance.');
    }
    return core.dispatch(command);
}
