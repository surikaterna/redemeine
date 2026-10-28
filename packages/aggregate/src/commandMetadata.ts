import type { ResolvedCommandTargets } from './types/entityMount';

/** A compiled local command registration, not a wire name or proxy path. */
export type CommandMetadata = Readonly<{
  localName: string;
  wireType: string;
  winnerLocalName: string;
  isWireWinner: boolean;
  targets: ResolvedCommandTargets[string];
}>;

// ESM and CJS definitions can meet in one host. A non-enumerable carrier survives
// only explicit library decoration, not arbitrary spreads of a built definition.
const registrations = Symbol.for('@redemeine/aggregate/compiled-command-metadata/v1');
type Registered = { readonly [registrations]: Readonly<Record<string, CommandMetadata>> };

function registered(host: object): host is Registered {
  return Object.hasOwn(host, registrations);
}

/**
 * Query an actual built aggregate (including supported plugin decorations).
 * Unknown local keys and arbitrary object clones have no registration.
 * Targets are deeply readonly, detached structural data; no executable definitions escape.
 */
export function commandMetadata(aggregate: object, commandKey: string): CommandMetadata | undefined {
  if (!registered(aggregate) || !Object.hasOwn(aggregate[registrations], commandKey)) return undefined;
  return aggregate[registrations][commandKey];
}

export function attachCommandMetadata(host: object, records: ReadonlyMap<string, CommandMetadata>): void {
  Object.defineProperty(host, registrations, { value: Object.freeze(Object.fromEntries(records)) });
}

export function copyCommandMetadata(source: object, destination: object): void {
  if (registered(source)) Object.defineProperty(destination, registrations, { value: source[registrations] });
}
