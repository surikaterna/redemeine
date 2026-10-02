import type * as ts from 'typescript';
import { ProjectionTypeConverter } from './projectionTypeConverter';
import type { RegistryDefinition } from './schemaRegistryNavigator';

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function renderHandlers(converter: ProjectionTypeConverter, handlers: Map<string, ts.Type>, path: string): string {
  return `{${[...handlers].sort(([a], [b]) => compare(a, b)).map(([name, type]) =>
    `[${JSON.stringify(name)}]: ${converter.convert(type, `${path}[${JSON.stringify(name)}].payload`)}`,
  ).join(', ')}}`;
}

function renderEntry(converter: ProjectionTypeConverter, definition: RegistryDefinition): string {
  const state = converter.convert(definition.state, `${definition.path}.initialState`);
  const value = definition.kind === 'projection' ? state :
    `{state: ${state}, commands: ${renderHandlers(converter, definition.commands, `${definition.path}.commands`)}, events: ${renderHandlers(converter, definition.events, `${definition.path}.events`)}}`;
  return `  [${JSON.stringify(definition.name)}, ${value}]`;
}

export function generateSchemaRegistryOutput(checker: ts.TypeChecker, definitions: readonly RegistryDefinition[]): string {
  const converter = new ProjectionTypeConverter(checker, true);
  const sorted = [...definitions].sort((a, b) => compare(a.kind, b.kind) || compare(a.name, b.name));
  const aggregate = sorted.filter((definition) => definition.kind === 'aggregate').map((definition) => renderEntry(converter, definition));
  const projection = sorted.filter((definition) => definition.kind === 'projection').map((definition) => renderEntry(converter, definition));
  return `// Generated schema registries. Do not edit.
import { z } from 'zod';

type AggregateSchemaBundle = { state: z.ZodType; commands: Record<string, z.ZodType>; events: Record<string, z.ZodType> };
function jsonSchema(schema: z.ZodType) { return z.toJSONSchema(schema); }
type JsonSchema = ReturnType<typeof jsonSchema>;
type AggregateJsonSchemaBundle = { state: JsonSchema; commands: Record<string, JsonSchema>; events: Record<string, JsonSchema> };

export const aggregateSchemas = new Map<string, AggregateSchemaBundle>([
${aggregate.join(',\n')}
]);
export const projectionSchemas = new Map<string, z.ZodType>([
${projection.join(',\n')}
]);

function jsonHandlers(handlers: Record<string, z.ZodType>): Record<string, JsonSchema> {
  return Object.fromEntries(Object.entries(handlers).map(([name, schema]) => [name, jsonSchema(schema)]));
}

export const aggregateJsonSchemas = new Map<string, AggregateJsonSchemaBundle>(
  [...aggregateSchemas].map(([name, bundle]) => [name, {
    state: jsonSchema(bundle.state), commands: jsonHandlers(bundle.commands), events: jsonHandlers(bundle.events),
  }]),
);
export const projectionJsonSchemas = new Map<string, JsonSchema>(
  [...projectionSchemas].map(([name, schema]) => [name, jsonSchema(schema)]),
);
`;
}
