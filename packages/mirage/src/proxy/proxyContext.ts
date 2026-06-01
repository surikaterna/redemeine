import type { ReadonlyDeep } from '@redemeine/kernel';
import type { BuiltAggregate } from '@redemeine/aggregate';
import type { MirageCore } from '../MirageCore';
import type { MountMetadata, InvocationContext, DispatchResult } from '../mirage.types';

/**
 * Shared context passed to all proxy factories, replacing closure-captured variables.
 * SAFETY: `any` in return types is required because proxy factories return opaque Proxy objects
 * whose shape depends on runtime state paths and cannot be statically typed.
 */
export interface ProxyContext {
    core: MirageCore<unknown>;
    mounts: Record<string, MountMetadata>;
    // SAFETY: selectors have heterogeneous signatures that cannot be unified without `any`
    selectors: Record<string, (state: ReadonlyDeep<any>, ...args: any[]) => unknown>;
    // SAFETY: BuiltAggregate generic params erased; used only for runtime property access
    builder: BuiltAggregate<any, any, any, any>;
    resolvePath: (path: string[]) => unknown;
    toCommandName: (path: string[]) => string;
    getMountForRoot: (rootProp: string) => MountMetadata | undefined;
    invokeByPath: (commandPath: string[], args: unknown[], context: InvocationContext) => DispatchResult<unknown>;
    invokeSelector: (selectorName: string, args: unknown[], context: InvocationContext) => unknown;
    makeDeepProxy: (statePath: string[], commandPath: string[], context: InvocationContext) => unknown;
    makeCollectionProxy: (collectionPath: string[], commandPrefixPath: string[], mount: MountMetadata, context: InvocationContext) => unknown;
    makeMapProxy: (mapPath: string[], commandPrefixPath: string[], mount: MountMetadata, context: InvocationContext) => unknown;
    makeEntityMirageProxy: (collectionPath: string[], commandPrefixPath: string[], selection: InvocationContext) => unknown;
}

export type { MountMetadata, InvocationContext, DispatchResult } from '../mirage.types';
