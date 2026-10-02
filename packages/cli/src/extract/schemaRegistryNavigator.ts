import * as ts from 'typescript';
import { extractCommandPayloads, extractEventPayloads, extractStateType, resolveAggregateType } from './aggregateNavigator';
import { resolveProjectionState } from './projectionNavigator';
import type { SchemaRegistrySelection } from '../schemaRegistryManifest';

export type RegistryDefinition = {
  kind: 'aggregate' | 'projection';
  name: string;
  path: string;
  state: ts.Type;
  commands: Map<string, ts.Type>;
  events: Map<string, ts.Type>;
};

function symbolType(checker: ts.TypeChecker, symbol: ts.Symbol, path: string): ts.Type {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) throw new Error(`${path}: unresolved declaration`);
  return checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

function property(checker: ts.TypeChecker, type: ts.Type, name: string, path: string): ts.Type {
  const symbol = checker.getPropertyOfType(type, name);
  if (!symbol || symbol.flags & ts.SymbolFlags.Optional) throw new Error(`${path}.${name}: required property missing or optional`);
  return symbolType(checker, symbol, `${path}.${name}`);
}

function resolvedObject(checker: ts.TypeChecker, type: ts.Type, path: string): void {
  if (!(type.flags & ts.TypeFlags.Object) || type.isUnion() || type.isIntersection() ||
      checker.getIndexInfosOfType(type).length || checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) {
    throw new Error(`${path}: expected a resolved object with declared properties`);
  }
}

export function registryName(checker: ts.TypeChecker, type: ts.Type, selection: SchemaRegistrySelection): string {
  const key = selection.kind === 'aggregate' ? 'aggregateType' : 'name';
  const identity = property(checker, type, key, selection.export);
  const parts = identity.isUnion() ? identity.types : [identity];
  if (parts.some((part) => !(part.flags & ts.TypeFlags.StringLike))) throw new Error(`${selection.export}.${key}: unresolved or non-string identity`);
  const literal = identity.isStringLiteral() ? identity.value : undefined;
  if (selection.name !== undefined) {
    if (literal !== undefined && literal !== selection.name) throw new Error(`${selection.export}.${key}: explicit name conflicts with literal ${JSON.stringify(literal)}`);
    return selection.name;
  }
  if (!literal?.trim()) throw new Error(`${selection.export}.${key}: supply name explicitly; expected a single nonempty string literal`);
  return literal;
}

function validateHandlers(checker: ts.TypeChecker, handlers: ts.Type, path: string, event: boolean): void {
  resolvedObject(checker, handlers, path);
  for (const handler of checker.getPropertiesOfType(handlers)) {
    const handlerPath = `${path}[${JSON.stringify(handler.getName())}]`;
    if (handler.flags & ts.SymbolFlags.Optional || handler.escapedName !== ts.escapeLeadingUnderscores(handler.getName())) {
      throw new Error(`${handlerPath}: optional or symbol handler unsupported`);
    }
    const type = symbolType(checker, handler, handlerPath);
    const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    const signature = signatures[0];
    if (type.isUnion() || signatures.length !== 1 || !signature || signature.typeParameters?.length) {
      throw new Error(`${handlerPath}: expected one non-generic resolved call signature`);
    }
    const message = event ? eventParameter(checker, signature, handlerPath) : checker.getReturnTypeOfSignature(signature);
    property(checker, message, 'payload', handlerPath);
  }
}

function eventParameter(checker: ts.TypeChecker, signature: ts.Signature, path: string): ts.Type {
  const parameter = signature.getParameters()[1];
  if (!parameter || parameter.flags & ts.SymbolFlags.Optional) throw new Error(`${path}: missing required event parameter`);
  const declaration = parameter.valueDeclaration;
  if (declaration && ts.isParameter(declaration) && (declaration.questionToken || declaration.dotDotDotToken || declaration.initializer)) {
    throw new Error(`${path}: event parameter must be required and non-rest`);
  }
  return symbolType(checker, parameter, `${path}.event`);
}

function aggregateMembers(program: ts.Program, type: ts.Type, path: string) {
  const checker = program.getTypeChecker();
  resolvedObject(checker, type, path);
  const state = property(checker, type, 'initialState', path);
  if (checker.getSignaturesOfType(state, ts.SignatureKind.Call).length) throw new Error(`${path}: expected aggregate initialState value, not factory`);
  const commands = property(checker, type, 'commandCreators', path);
  const pure = property(checker, type, 'pure', path);
  const events = property(checker, pure, 'eventProjectors', `${path}.pure`);
  validateHandlers(checker, commands, `${path}.commandCreators`, false);
  validateHandlers(checker, events, `${path}.pure.eventProjectors`, true);
  const node = program.getSourceFiles()[0];
  if (!node) throw new Error(`${path}: missing compiler source`);
  const extractedState = extractStateType(checker, type, node);
  if (!extractedState) throw new Error(`${path}: unresolved initialState`);
  return { state: extractedState, commands: extractCommandPayloads(checker, type, node), events: extractEventPayloads(checker, type, node) };
}

export function navigateRegistries(program: ts.Program, selections: readonly SchemaRegistrySelection[]): RegistryDefinition[] {
  const options = program.getCompilerOptions();
  if (!(options.strictNullChecks ?? options.strict)) throw new Error('enable strictNullChecks (or strict) for faithful schema registries');
  const checker = program.getTypeChecker();
  const identities = new Set<string>();
  return selections.map((selection) => {
    const type = resolveAggregateType(program, checker, selection.entry, selection.export);
    const name = registryName(checker, type, selection);
    const identity = JSON.stringify([selection.kind, name]);
    if (identities.has(identity)) throw new Error(`${selection.export}: duplicate ${selection.kind} name ${JSON.stringify(name)}`);
    identities.add(identity);
    const members = selection.kind === 'aggregate' ? aggregateMembers(program, type, selection.export) : {
      state: resolveProjectionState(program, selection.entry, selection.export), commands: new Map<string, ts.Type>(), events: new Map<string, ts.Type>(),
    };
    return { kind: selection.kind, name, path: selection.export, ...members };
  });
}
