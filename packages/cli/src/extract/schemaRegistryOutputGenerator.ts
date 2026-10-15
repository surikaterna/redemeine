import type * as ts from 'typescript';
import { ProjectionTypeConverter } from './projectionTypeConverter';
import type { RegistryDefinition } from './schemaRegistryNavigator';
import { schemaAwareConversion } from './schemaAwareConversion';
import { schemaPolicyForEntry } from './schemaConfig';

type Converter = { convert(type: ts.Type, path: string, declaration?: ts.Node): string };

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function renderHandlers(converter: Converter, handlers: Map<string, ts.Type>, path: string, declarations?: Map<string, ts.Node>): string {
  return `{${[...handlers].sort(([a], [b]) => compare(a, b)).map(([name, type]) =>
    `[${JSON.stringify(name)}]: ${converter.convert(type, `${path}[${JSON.stringify(name)}].payload`, declarations?.get(name))}`,
  ).join(', ')}}`;
}

function renderEntry(converter: Converter, definition: RegistryDefinition): string {
   const state = converter.convert(definition.state, `${definition.path}.initialState`, definition.declarations?.state);
  const value = definition.kind === 'projection' ? state :
    `{state: ${state}, commands: ${renderHandlers(converter, definition.commands, `${definition.path}.commands`, definition.declarations?.commands)}, events: ${renderHandlers(converter, definition.events, `${definition.path}.events`, definition.declarations?.events)}}`;
  return `  [${JSON.stringify(definition.name)}, ${value}]`;
}

export function generateSchemaRegistryOutput(checker: ts.TypeChecker, definitions: readonly RegistryDefinition[], context?: { program: ts.Program; outFile: string }): string {
  const sorted = [...definitions].sort((a, b) => compare(a.kind, b.kind) || compare(a.name, b.name));
  const imports: string[] = [];
  const rendered = sorted.map((definition, index) => {
    const linked = context && definition.entry ? schemaAwareConversion(context.program, schemaPolicyForEntry(definition.entry), context.outFile, `_registry${index}_`, true) : undefined;
    const value = renderEntry(linked ?? new ProjectionTypeConverter(checker, true), definition);
    if (linked) imports.push(...linked.imports);
    return { kind: definition.kind, value };
  });
  const aggregate = rendered.filter(item => item.kind === 'aggregate').map(item => item.value);
  const projection = rendered.filter(item => item.kind === 'projection').map(item => item.value);
  return `// Generated schema registries. Do not edit.
import { z } from 'zod';
${imports.join('\n')}

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
