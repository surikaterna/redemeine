import type { CommandMetadata } from './commandMetadata';
import type { CompiledEventRegistration } from './applyEvent';
import type { EventOrigin } from './build/eventDefinitions';

export type SchemaBinding = Readonly<{ wireType: string; winnerSchemaId: string; isWireWinner: boolean }>;
export type SchemaBindingMap = Readonly<{
  schemaToWire: Readonly<Record<string, SchemaBinding>>;
  wireToSchema: Readonly<Record<string, string>>;
}>;
export type SchemaBindings = Readonly<{ aggregateType: string; commands: SchemaBindingMap; events: SchemaBindingMap }>;

const carrier = Symbol.for('@redemeine/aggregate/schema-bindings/v1');
type Carrier = { [carrier]: Readonly<{ snapshot?: SchemaBindings; error?: string }> };
type Forward = { wireType: string; registration: CompiledEventRegistration };

/** Query compiled registrations, not inferred names. Unsupported ownership fails closed. */
export function schemaBindings(aggregate: object): SchemaBindings {
  if (!Object.hasOwn(aggregate, carrier)) throw new Error('schemaBindings requires a registered built aggregate');
  const value = (aggregate as Carrier)[carrier];
  if (value.error) throw new Error(value.error);
  return value.snapshot!;
}

export function copySchemaBindings(source: object, destination: object): void {
  if (Object.hasOwn(source, carrier)) Object.defineProperty(destination, carrier, { value: (source as Carrier)[carrier] });
}

export function attachSchemaBindings(host: object, aggregateType: string, commands: ReadonlyMap<string, CommandMetadata>,
  forward: readonly Forward[], dispatch: ReadonlyMap<string, CompiledEventRegistration>): void {
  let value: Carrier[typeof carrier];
  try {
    const commandForward = [...commands].map(([schemaId, record]) => [schemaId, record.wireType] as const);
    const commandReverse = [...commands.values()].map(record => [record.wireType, record.winnerLocalName] as const);
    value = Object.freeze({ snapshot: Object.freeze({ aggregateType,
      commands: bindingMap(commandForward, commandReverse), events: eventBindings(forward, dispatch) }) });
  } catch (error) {
    value = Object.freeze({ error: error instanceof Error ? error.message : String(error) });
  }
  Object.defineProperty(host, carrier, { value });
}

function bindingMap(forward: readonly (readonly [string, string])[], reverse: readonly (readonly [string, string])[]): SchemaBindingMap {
  const wireToSchema = Object.freeze(Object.fromEntries(reverse));
  const schemaToWire = Object.freeze(Object.fromEntries(forward.map(([schemaId, wireType]) => [schemaId,
    Object.freeze({ wireType, winnerSchemaId: wireToSchema[wireType]!, isWireWinner: wireToSchema[wireType] === schemaId })])));
  return Object.freeze({ schemaToWire, wireToSchema });
}

function eventBindings(forward: readonly Forward[], dispatch: ReadonlyMap<string, CompiledEventRegistration>): SchemaBindingMap {
  const origins = new Map<string, { origin: EventOrigin; wireType: string }>();
  const entries = forward.map(({ wireType, registration }) => {
    const schemaId = eventSchemaId(registration);
    const origin = registration.schemaOrigin!;
    const previous = origins.get(schemaId);
    if (previous && (previous.wireType !== wireType || !sameOrigin(previous.origin, origin))) {
      throw new Error(`Ambiguous event schema registration: ${schemaId}`);
    }
    origins.set(schemaId, { origin, wireType });
    return [schemaId, wireType] as const;
  });
  return bindingMap(entries, [...dispatch].map(([wire, registration]) => [wire, eventSchemaId(registration)] as const));
}

function eventSchemaId(registration: CompiledEventRegistration): string {
  const origin = registration.schemaOrigin;
  if (!origin || registration.unsupportedSchema) {
    throw new Error(`Unsupported direct mixin event schema registration: ${origin?.segments.join('.') ?? 'unknown'}`);
  }
  return origin.segments.join('.');
}

function sameOrigin(left: EventOrigin, right: EventOrigin): boolean {
  return left.declaration === right.declaration && left.member === right.member
    && JSON.stringify(left.segments) === JSON.stringify(right.segments);
}
