import type { EntityCommandTarget } from './types/entityMount';

/** A compiled local command registration, not a wire name or proxy path. */
export type CommandMetadata = Readonly<{
  localName: string;
  wireType: string;
  winnerLocalName: string;
  isWireWinner: boolean;
  isStatic: boolean;
  targets: readonly Omit<EntityCommandTarget, 'initialState'>[];
}>;

// Share compiled structural snapshots across ESM/CJS and shallow definition copies.
// Symbol enumerability preserves spread/assign without exposing keys to JSON.
const registrations = Symbol.for('@redemeine/aggregate/compiled-command-metadata/v1');
type Registered = { readonly [registrations]: Readonly<Record<string, CommandMetadata>> };

function registered(host: object): host is Registered {
  return Object.hasOwn(host, registrations);
}

/**
 * Query a built aggregate, supported plugin decoration, or shallow copy of either.
 * Unknown local keys and objects without the compiled snapshot have no registration.
 * The snapshot describes compilation, not the authenticity of later definition edits.
 * Targets are deeply readonly, detached structural data; no executable definitions escape.
 */
export function commandMetadata(aggregate: object, commandKey: string): CommandMetadata | undefined {
  if (!registered(aggregate) || !Object.hasOwn(aggregate[registrations], commandKey)) return undefined;
  return aggregate[registrations][commandKey];
}

export function attachCommandMetadata(host: object, records: ReadonlyMap<string, CommandMetadata>): void {
  Object.defineProperty(host, registrations, { value: Object.freeze(Object.fromEntries(records)), enumerable: true });
}

export function copyCommandMetadata(source: object, destination: object): void {
  if (registered(source)) Object.defineProperty(destination, registrations, {
    value: source[registrations], enumerable: true, writable: false, configurable: false
  });
}
