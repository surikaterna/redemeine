import { type Command, type Event, type ReadonlyDeep } from '@redemeine/kernel';
import { MirageCore, assertEventCount } from './MirageCore';
import { hydrateStateFromEvents } from './hydration';
import { createProxyContext } from './proxy/deepProxy';
import { getCore, registerCore } from './coreAccess';
import { builderPlugins, erasePlugins, type MirageBuilder, type RuntimeBuilder } from './runtimeDefinition';
import type { MirageInstance, MirageOf, MirageSetup, HydrationEvents, BuiltAggregateState, BuiltAggregatePlugins, DispatchResult, NoMirageCollisions } from './mirage.types';
import { validateMirageNames } from './validateMirageNames';
import { cloneState } from './stateViews';

export { HYDRATION_REPLAY_YIELD_THRESHOLD } from './hydration';
export * from './mirage.types';

export function createMirage<B extends MirageBuilder>(builder: B & NoMirageCollisions<NoInfer<B>>, id: string,
  setup?: MirageSetup<BuiltAggregateState<B>, BuiltAggregatePlugins<B>> & { events?: undefined }): MirageOf<B>;
export function createMirage<B extends MirageBuilder>(builder: B & NoMirageCollisions<NoInfer<B>>, id: string,
  setup: MirageSetup<BuiltAggregateState<B>, BuiltAggregatePlugins<B>> & { events: HydrationEvents<Event> }): Promise<MirageOf<B>>;
export function createMirage<B extends MirageBuilder>(builder: B & NoMirageCollisions<NoInfer<B>>, id: string,
  setup: MirageSetup<BuiltAggregateState<B>, BuiltAggregatePlugins<B>>): MirageOf<B> | Promise<MirageOf<B>>;
export function createMirage<B extends MirageBuilder>(builder: B & NoMirageCollisions<NoInfer<B>>, id: string,
  setup?: MirageSetup<BuiltAggregateState<B>, BuiltAggregatePlugins<B>>): MirageOf<B> | Promise<MirageOf<B>> {
  type State = BuiltAggregateState<B>;
  const initialVersion = setup?.initialVersion === undefined ? 0 : setup.initialVersion;
  assertEventCount(initialVersion);
  // These correlated state/process/apply types originate from the same built aggregate.
  const runtime = builder as unknown as RuntimeBuilder<State>;
  const state = cloneState(setup?.snapshot ?? builder.initialState) as State;
  try {
    builder.validateState?.(state);
  } catch (error) {
    if (setup?.events) return Promise.reject(error);
    throw error;
  }
  validateMirageNames(builder, state);
  const plugins = [...builderPlugins(builder), ...erasePlugins(setup?.plugins ?? [])];
  const make = (current: State, version: number): MirageOf<B> => {
    const core = new MirageCore(runtime, id, current, setup?.contract, setup?.strict, plugins, version);
    const context = createProxyContext(core, builder.mounts ?? {}, builder.selectors ?? {}, builder);
    const instance = context.makeDeepProxy([], [], { idsPayload: {}, packPrefix: [] });
    if (!instance || typeof instance !== 'object') throw new Error('Invalid root proxy');
    registerCore(instance, core);
    // Dynamic property dispatch is implemented by the tested proxy boundary, not a plain object.
    return instance as MirageOf<B>;
  };
  if (!setup?.events) return make(state, initialVersion);
  return hydrateStateFromEvents(runtime, id, state, setup.events, plugins, initialVersion)
    .then(result => make(result.state, initialVersion + result.appliedCount));
}

export function extractUncommittedEvents<S>(
  mirage: MirageInstance<S>
): Event[] {
  return structuredClone(getCore<S>(mirage).uncommitted);
}

export function clearUncommittedEvents<S>(
  mirage: MirageInstance<S>
): void {
  getCore<S>(mirage).clearPendingResults();
}

export function extractState<S>(
  mirage: MirageInstance<S>
): ReadonlyDeep<S> {
  return getCore<S>(mirage).stateView();
}

export function subscribe<S>(
  mirage: MirageInstance<S>, listener: (state: ReadonlyDeep<S>) => void
): () => void {
  return getCore<S>(mirage).subscribe(listener);
}

export function dispatch<S>(
  mirage: MirageInstance<S>, command: Command<unknown, string>
): DispatchResult<S> {
  return getCore<S>(mirage).dispatch(command);
}
