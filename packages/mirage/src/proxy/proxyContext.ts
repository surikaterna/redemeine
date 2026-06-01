import type { ReadonlyDeep } from '@redemeine/kernel';
import type { BuiltAggregate } from '@redemeine/aggregate';
import type { MirageCore } from '../MirageCore';
import type { MountMetadata, InvocationContext, DispatchResult } from '../mirage.types';

/**
 * Shared context passed to all proxy factories, replacing closure-captured variables.
 */
export interface ProxyContext {
    core: MirageCore<any>;
    mounts: Record<string, MountMetadata>;
    selectors: Record<string, (state: ReadonlyDeep<any>, ...args: any[]) => any>;
    builder: BuiltAggregate<any, any, any, any>;
    resolvePath: (path: string[]) => any;
    toCommandName: (path: string[]) => string;
    getMountForRoot: (rootProp: string) => MountMetadata | undefined;
    invokeByPath: (commandPath: string[], args: unknown[], context: InvocationContext) => DispatchResult<any>;
    invokeSelector: (selectorName: string, args: unknown[], context: InvocationContext) => any;
    makeDeepProxy: (statePath: string[], commandPath: string[], context: InvocationContext) => any;
    makeCollectionProxy: (collectionPath: string[], commandPrefixPath: string[], mount: MountMetadata, context: InvocationContext) => any;
    makeMapProxy: (mapPath: string[], commandPrefixPath: string[], mount: MountMetadata, context: InvocationContext) => any;
    makeEntityMirageProxy: (collectionPath: string[], commandPrefixPath: string[], selection: InvocationContext) => any;
}

export type { MountMetadata, InvocationContext, DispatchResult } from '../mirage.types';
