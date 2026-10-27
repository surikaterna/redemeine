import { produce, type Draft } from 'immer';
import type { Event } from '@redemeine/kernel';
import type { UnmatchedEventHandler } from './createAggregate';
import type { EntityCommandTarget } from './types/entityMount';
import { assertSynchronous } from './plugins/descriptor';
import { selectedCommandState } from './build/entityCommandTarget';

/** An exact wire registration owns its projector and target chain together. */
export type CompiledEventRegistration = {
    readonly projector: Function;
    readonly targets: readonly EntityCommandTarget[];
};

export type CompiledEventDispatch = ReadonlyMap<string, CompiledEventRegistration>;

/** Applies to a caller-owned mutable draft without wrapping it in Immer. */
export function applyEventToDraft<S>(
    aggregateName: string,
    draft: Draft<S>,
    event: Event,
    dispatch: CompiledEventDispatch,
    unmatchedEventHandler?: UnmatchedEventHandler
): void {
    const registration = dispatch.get(event.type);
    if (registration) {
        const { projector, targets } = registration;
        const target = selectedCommandState(draft, event.payload, targets);
        assertSynchronous(projector(target, event));
        return;
    }
    if (unmatchedEventHandler) {
        assertSynchronous(unmatchedEventHandler(event.type, aggregateName));
    } else {
        console.warn(`[redemeine] Event "${event.type}" has no projector on aggregate "${aggregateName}" — event was silently dropped`);
    }
}

export function applyEvent<S>(
    aggregateName: string,
    state: S,
    event: Event,
    dispatch: CompiledEventDispatch,
    unmatchedEventHandler?: UnmatchedEventHandler
): S {
    return produce(state, (draft: Draft<S>) => {
        applyEventToDraft(aggregateName, draft, event, dispatch, unmatchedEventHandler);
    }) as S;
}
