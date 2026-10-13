import type { Command, Event } from '@redemeine/kernel';
import type { MountMetadata, InvocationContext } from '../mirage.types';
import type { MirageBuilder } from '../runtimeDefinition';

export interface ProxyCore {
  readonly state: unknown;
  readonly version: number;
  dispatch(command: Command<unknown, string>): unknown;
  stateView(): unknown;
  getPendingResults(): { events: Event[]; intents: Record<string, unknown> };
}

export interface ProxyContext {
  core: ProxyCore;
  mounts: Record<string, MountMetadata>;
  selectors: object;
  builder: MirageBuilder;
  resolvePath(path: string[]): unknown;
  toCommandName(path: string[]): string;
  getMountForRoot(rootProp: string): MountMetadata | undefined;
  invokeByPath(path: string[], args: unknown[], context: InvocationContext): unknown;
  invokeSelector(name: string, args: unknown[], context: InvocationContext): unknown;
  makeDeepProxy(statePath: string[], commandPath: string[], context: InvocationContext): unknown;
  makeCollectionProxy(path: string[], prefix: string[], mount: MountMetadata, context: InvocationContext): unknown;
  makeMapProxy(path: string[], prefix: string[], mount: MountMetadata, context: InvocationContext): unknown;
  makeEntityMirageProxy(path: string[], prefix: string[], selection: InvocationContext): unknown;
}
