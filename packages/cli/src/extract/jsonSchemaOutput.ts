import * as ts from 'typescript';
import { JsonSchemaConverter, type JsonSchema } from './jsonSchemaConverter';

export interface SchemaOutputOptions {
  format?: 'zod' | 'json-schema';
  target?: 'draft-7' | 'draft-2020-12';
}

export function validateSchemaOutput(options: SchemaOutputOptions & { dateHandling?: string; typeOverrides?: object }): void {
  if (options.format !== undefined && options.format !== 'zod' && options.format !== 'json-schema') throw new Error('--format must be zod or json-schema');
  if (options.target !== undefined && options.target !== 'draft-7' && options.target !== 'draft-2020-12') throw new Error('--target must be draft-7 or draft-2020-12');
  if (options.target !== undefined && options.format !== 'json-schema') throw new Error('--target requires --format json-schema');
  if (options.format !== 'json-schema') return;
  if (options.dateHandling === 'date') throw new Error('JSON Schema requires --date-handling string');
  if (options.typeOverrides !== undefined) throw new Error('Code-string typeOverrides are unsupported for JSON Schema');
}

export function jsonSchemaDocument(schema: JsonSchema, target: SchemaOutputOptions['target']): JsonSchema {
  if (typeof schema === 'boolean') return schema;
  const dialect = target === 'draft-7' ? 'http://json-schema.org/draft-07/schema#' : 'https://json-schema.org/draft/2020-12/schema';
  return { $schema: dialect, ...schema };
}

function propertyType(checker: ts.TypeChecker, type: ts.Type, key: string, path: string): ts.Type {
  const property = checker.getPropertyOfType(type, key);
  const declaration = property?.valueDeclaration ?? property?.declarations?.[0];
  if (!property || !declaration) throw new Error(`${path}.${key}: missing resolved aggregate property`);
  const result = checker.getTypeOfSymbolAtLocation(property, declaration);
  if (result.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) throw new Error(`${path}.${key}: unresolved aggregate property`);
  return result;
}

function completePayloads(checker: ts.TypeChecker, handlers: ts.Type, payloads: Map<string, ts.Type>, path: string, events: boolean): void {
  for (const property of checker.getPropertiesOfType(handlers)) {
    if (payloads.has(property.name)) continue;
    const type = propertyType(checker, handlers, property.name, path);
    const signature = type.getCallSignatures()[0];
    if (events && signature && signature.getParameters().length < 2) payloads.set(property.name, checker.getVoidType());
    else throw new Error(`${path}[${JSON.stringify(property.name)}]: missing resolved payload`);
  }
  if (checker.getIndexInfosOfType(handlers).length) throw new Error(`${path}: unresolved handler keys`);
}

function payloadDeclaration(checker: ts.TypeChecker, handlers: ts.Type, key: string, path: string, event: boolean): ts.Declaration | undefined {
  const signature = propertyType(checker, handlers, key, path).getCallSignatures()[0];
  if (!signature) throw new Error(`${path}[${JSON.stringify(key)}]: unresolved handler signature`);
  let container = checker.getReturnTypeOfSignature(signature);
  if (event) {
    const parameter = signature.getParameters()[1];
    const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
    if (!parameter || !declaration) return undefined;
    container = checker.getTypeOfSymbolAtLocation(parameter, declaration);
  }
  const payload = checker.getPropertyOfType(container, 'payload');
  return payload?.valueDeclaration ?? payload?.declarations?.[0];
}

export function aggregateJsonOutput(
  program: ts.Program, aggregate: ts.Type, commands: Map<string, ts.Type>, events: Map<string, ts.Type>,
  state: ts.Type | null, options: SchemaOutputOptions & { aggregateExport: string; includeState?: boolean },
): string {
  const converter = new JsonSchemaConverter(program);
  const { checker } = converter;
  const name = options.aggregateExport;
  const creators = propertyType(checker, aggregate, 'commandCreators', name);
  completePayloads(checker, creators, commands, `${name}.commands`, false);
  const pure = propertyType(checker, aggregate, 'pure', name);
  const projectors = propertyType(checker, pure, 'eventProjectors', `${name}.pure`);
  completePayloads(checker, projectors, events, `${name}.events`, true);
  const convertMap = (types: Map<string, ts.Type>, group: string, handlers: ts.Type) => Object.fromEntries([...types].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, type]) => {
      const declaration = type.aliasSymbol?.declarations?.[0] ?? payloadDeclaration(checker, handlers, key, name, group === 'events');
      return [key, jsonSchemaDocument(converter.convert(type, `${name}.${group}[${JSON.stringify(key)}]`, declaration), options.target)];
    }));
  if (options.includeState !== false && !state) throw new Error(`${name}.state: missing resolved initialState`);
  const stateSymbol = checker.getPropertyOfType(aggregate, 'initialState');
  const stateDeclaration = stateSymbol?.valueDeclaration ?? stateSymbol?.declarations?.[0];
  const output = {
    commands: convertMap(commands, 'commands', creators),
    events: convertMap(events, 'events', projectors),
    ...(options.includeState !== false && state ? { state: jsonSchemaDocument(converter.convert(state, `${name}.state`, stateDeclaration), options.target) } : {}),
  };
  return `${JSON.stringify(output, null, 2)}\n`;
}
