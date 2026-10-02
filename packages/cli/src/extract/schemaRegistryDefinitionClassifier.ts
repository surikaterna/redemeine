import * as ts from 'typescript';
import { aggregateReferenceEvidence, canonicalCreatorSignature, definitionEvidence, runtimeProjectionContract, type DefinitionEvidence } from './schemaRegistryProvenance';
import { valueType } from './schemaRegistryIdentity';

function concrete(type: ts.Type, path: string): void {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter) || type.isUnion()) {
    throw new Error(`${path}: unresolved built contract`);
  }
}

function member(checker: ts.TypeChecker, type: ts.Type, key: string, path: string): ts.Type {
  const symbol = checker.getPropertyOfType(type, key);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration || symbol.flags & ts.SymbolFlags.Optional) throw new Error(`${path}.${key}: required built member missing or optional`);
  return checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

function object(type: ts.Type, path: string): void {
  concrete(type, path);
  if (type.isIntersection()) {
    for (const part of type.types) object(part, path);
    return;
  }
  if (!(type.flags & ts.TypeFlags.Object)) throw new Error(`${path}: expected built contract object`);
}

function callable(checker: ts.TypeChecker, type: ts.Type, path: string, parameters: number): ts.Signature {
  concrete(type, path);
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const signature = signatures[0];
  if (signatures.length !== 1 || !signature || signature.typeParameters?.length || signature.parameters.length < parameters) {
    throw new Error(`${path}: expected one non-generic built function with ${parameters} parameters`);
  }
  return signature;
}

function mapFunction(checker: ts.TypeChecker, type: ts.Type, path: string, parameters: number): void {
  // AggregateBuilder declares raw command processors as the standard Function interface.
  const symbol = type.getSymbol();
  if (parameters === 0 && symbol?.name === 'Function' &&
      symbol.declarations?.every((node) => /[\\/]lib\.[^/\\]+\.d\.ts$/.test(node.getSourceFile().fileName))) return;
  const signature = callable(checker, type, path, parameters);
  if (parameters === 3 && !(checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void)) {
    throw new Error(`${path}: expected void projection handler`);
  }
  if (parameters === 3) {
    parameter(checker, signature, 0, `${path}.state`);
    const event = parameter(checker, signature, 1, `${path}.event`);
    message(checker, event, `${path}.event`);
    stringType(member(checker, event, 'aggregateId', path), `${path}.event.aggregateId`);
    const context = parameter(checker, signature, 2, `${path}.context`);
    for (const key of ['subscribeTo', 'unsubscribeFrom']) callable(checker, member(checker, context, key, path), `${path}.context.${key}`, 2);
  }
}

function stringType(type: ts.Type, path: string): void {
  const parts = type.isUnion() ? type.types : [type];
  if (!parts.every((part) => !!(part.flags & ts.TypeFlags.StringLike))) throw new Error(`${path}: expected string`);
}

function parameter(checker: ts.TypeChecker, signature: ts.Signature, index: number, path: string): ts.Type {
  const symbol = signature.parameters[index];
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration || symbol.flags & ts.SymbolFlags.Optional) throw new Error(`${path}: required parameter missing`);
  if (ts.isParameter(declaration) && (declaration.questionToken || declaration.dotDotDotToken || declaration.initializer)) {
    throw new Error(`${path}: parameter must be required and non-rest`);
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter)) throw new Error(`${path}: unresolved parameter`);
  return type;
}

function message(checker: ts.TypeChecker, type: ts.Type, path: string): void {
  object(type, path);
  stringType(member(checker, type, 'type', path), `${path}.type`);
  member(checker, type, 'payload', path);
}

function aggregateFunction(checker: ts.TypeChecker, type: ts.Type, state: ts.Type, key: string, path: string): void {
  const signature = callable(checker, member(checker, type, key, path), `${path}.${key}`, 2);
  const input = parameter(checker, signature, 0, `${path}.${key}.state`);
  if (!checker.isTypeAssignableTo(state, input)) throw new Error(`${path}.${key}: incompatible state parameter`);
  message(checker, parameter(checker, signature, 1, `${path}.${key}.message`), `${path}.${key}.message`);
  const result = checker.getReturnTypeOfSignature(signature);
  if (result.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) throw new Error(`${path}.${key}: unresolved return`);
  if (key === 'process') message(checker, arrayElement(checker, result, `${path}.process result`), `${path}.process result[]`);
  if (key === 'apply' && !checker.isTypeAssignableTo(result, state)) throw new Error(`${path}.apply: incompatible state return`);
  if (key === 'applyToDraft' && !(result.flags & ts.TypeFlags.Void)) throw new Error(`${path}.applyToDraft: expected void`);
}

function functionMap(checker: ts.TypeChecker, type: ts.Type, path: string, parameters: number): void {
  object(type, path);
  for (const symbol of checker.getPropertiesOfType(type)) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) throw new Error(`${path}.${symbol.name}: unresolved handler`);
    const value = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const parts = value.isUnion() ? value.types.filter((part) => !(part.flags & ts.TypeFlags.Undefined)) : [value];
    if (parts.length !== 1 || !parts[0]) throw new Error(`${path}.${symbol.name}: ambiguous handler`);
    mapFunction(checker, parts[0], `${path}.${symbol.name}`, parameters);
  }
  for (const index of checker.getIndexInfosOfType(type)) mapFunction(checker, index.type, `${path}[]`, parameters);
}

function arrayElement(checker: ts.TypeChecker, type: ts.Type, path: string): ts.Type {
  concrete(type, path);
  if (!checker.isArrayType(type)) throw new Error(`${path}: expected array`);
  const element = checker.getTypeArguments(type as ts.TypeReference)[0];
  if (!element) throw new Error(`${path}: unresolved array element`);
  return element;
}

function aggregateContract(checker: ts.TypeChecker, type: ts.Type, path: string): void {
  stringType(member(checker, type, 'aggregateType', path), `${path}.aggregateType`);
  const state = member(checker, type, 'initialState', path);
  for (const key of ['process', 'apply', 'applyToDraft']) aggregateFunction(checker, type, state, key, path);
  functionMap(checker, member(checker, type, 'commandCreators', path), `${path}.commandCreators`, 0);
  functionMap(checker, member(checker, type, 'eventCreators', path), `${path}.eventCreators`, 0);
  functionMap(checker, member(checker, type, 'selectors', path), `${path}.selectors`, 0);
  const pure = member(checker, type, 'pure', path);
  object(pure, `${path}.pure`);
  functionMap(checker, member(checker, pure, 'commandProcessors', `${path}.pure`), `${path}.pure.commandProcessors`, 0);
  functionMap(checker, member(checker, pure, 'eventProjectors', `${path}.pure`), `${path}.pure.eventProjectors`, 2);
  creatorReturns(checker, member(checker, type, 'commandCreators', path), `${path}.commandCreators`);
  creatorReturns(checker, member(checker, type, 'eventCreators', path), `${path}.eventCreators`,
    member(checker, pure, 'eventProjectors', `${path}.pure`));
}

function creatorReturns(checker: ts.TypeChecker, creators: ts.Type, path: string, projectors?: ts.Type): void {
  for (const symbol of checker.getPropertiesOfType(creators)) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) throw new Error(`${path}.${symbol.name}: unresolved creator`);
    const signature = callable(checker, checker.getTypeOfSymbolAtLocation(symbol, declaration), `${path}.${symbol.name}`, 0);
    const result = checker.getReturnTypeOfSignature(signature);
    message(checker, result, `${path}.${symbol.name} result`);
    if (projectors) creatorProjector(checker, projectors, symbol.name, signature, path);
  }
  for (const index of checker.getIndexInfosOfType(creators)) {
    const signature = callable(checker, index.type, `${path}[]`, 0);
    message(checker, checker.getReturnTypeOfSignature(signature), `${path}[] result`);
  }
  if (projectors) creatorCoverage(checker, creators, projectors, path);
}

function creatorCoverage(checker: ts.TypeChecker, creators: ts.Type, projectors: ts.Type, path: string): void {
  for (const projector of checker.getPropertiesOfType(projectors)) {
    if (checker.getPropertyOfType(creators, projector.name)) continue;
    const indexed = checker.getIndexTypeOfType(creators, ts.IndexKind.String);
    if (!indexed) throw new Error(`${path}.${projector.name}: missing corresponding event creator`);
    const signature = callable(checker, indexed, `${path}[]`, 0);
    creatorProjector(checker, projectors, projector.name, signature, path);
  }
}

function creatorProjector(checker: ts.TypeChecker, projectors: ts.Type, name: string, creator: ts.Signature, path: string): void {
  const projector = checker.getPropertyOfType(projectors, name);
  if (!projector) throw new Error(`${path}.${name}: missing corresponding event projector`);
  const declaration = projector.valueDeclaration ?? projector.declarations?.[0];
  if (!declaration) throw new Error(`${path}.${name}: unresolved event projector`);
  const signature = callable(checker, checker.getTypeOfSymbolAtLocation(projector, declaration), `${path}.${name}`, 2);
  const event = parameter(checker, signature, 1, `${path}.${name}.event`);
  const payload = member(checker, checker.getReturnTypeOfSignature(creator), 'payload', path);
  const expected = member(checker, event, 'payload', path);
  // EventEmitterFactory's supported fallback deliberately erases some inferred payloads to unknown.
  if (payload.flags & ts.TypeFlags.Unknown && canonicalCreatorSignature(creator)) return;
  if (payload.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined) && expected.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return;
  if (payload.flags & ts.TypeFlags.Any) throw new Error(`${path}.${name}: unresolved creator payload`);
  if (!checker.isTypeAssignableTo(payload, expected) || !checker.isTypeAssignableTo(expected, payload)) {
    throw new Error(`${path}.${name}: creator/projector payload mismatch`);
  }
}

function aggregateReference(checker: ts.TypeChecker, type: ts.Type, path: string, runtimePrimary = false): void {
  object(type, path);
  const evidence = aggregateReferenceEvidence(checker, type, new Map());
  if (!evidence) throw new Error(`${path}: expected a genuine aggregate contract reference`);
  if (evidence === 'built') {
    aggregateContract(checker, type, path);
    return;
  }
  // Erasure must preserve the mandatory members of the canonical origin and the primary-stream slot.
  stringType(member(checker, type, 'aggregateType', path), `${path}.aggregateType`);
  if (runtimePrimary || evidence === 'definition') member(checker, type, 'initialState', path);
  if (runtimePrimary || evidence === 'definition' || evidence === 'source') {
    const pure = member(checker, type, 'pure', path);
    object(pure, `${path}.pure`);
    const projectors = member(checker, pure, 'eventProjectors', `${path}.pure`);
    if (evidence === 'source' && !runtimePrimary) object(projectors, `${path}.pure.eventProjectors`);
    else functionMap(checker, projectors, `${path}.pure.eventProjectors`, 0);
  }
}

function streamContract(checker: ts.TypeChecker, type: ts.Type, path: string, runtimePrimary = false): void {
  object(type, path);
  const aggregate = member(checker, type, 'aggregate', path);
  aggregateReference(checker, aggregate, `${path}.aggregate`, runtimePrimary);
  functionMap(checker, member(checker, type, 'handlers', path), `${path}.handlers`, 3);
}

function optionalParts(checker: ts.TypeChecker, type: ts.Type, key: string): ts.Type[] {
  const symbol = checker.getPropertyOfType(type, key);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration) return [];
  const value = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  return value.isUnion() ? value.types.filter((part) => !(part.flags & ts.TypeFlags.Undefined)) : [value];
}

function deduplication(checker: ts.TypeChecker, policy: ts.Type, path: string): void {
  object(policy, path);
  const strategy = member(checker, policy, 'strategy', path);
  const parts = strategy.isUnion() ? strategy.types : [strategy];
  if (!parts.every((part) => part.isStringLiteral() && ['own_record', 'in_document', 'none'].includes(part.value))) {
    throw new Error(`${path}.strategy: unsupported deduplication policy`);
  }
  if (strategy.isStringLiteral() && strategy.value === 'none') {
    const acknowledgement = member(checker, policy, 'duplicateEffects', path);
    if (!acknowledgement.isStringLiteral() || acknowledgement.value !== 'acknowledged') throw new Error(`${path}: missing duplicate effects acknowledgement`);
    stringType(member(checker, policy, 'reason', path), `${path}.reason`);
  }
}

function projectionOptionalContract(checker: ts.TypeChecker, type: ts.Type, path: string): void {
  for (const key of ['joinStreams', 'reverseSubscribeStreams']) {
    for (const value of optionalParts(checker, type, key)) streamContract(checker, arrayElement(checker, value, `${path}.${key}`), `${path}.${key}[]`);
  }
  for (const hooks of optionalParts(checker, type, 'hooks')) {
    object(hooks, `${path}.hooks`);
    for (const hook of optionalParts(checker, hooks, 'afterEach')) callable(checker, hook, `${path}.hooks.afterEach`, 2);
  }
  for (const policy of optionalParts(checker, type, 'deduplication')) deduplication(checker, policy, `${path}.deduplication`);
}

function projectionContract(checker: ts.TypeChecker, type: ts.Type, path: string, commit: boolean): void {
  stringType(member(checker, type, 'name', path), `${path}.name`);
  const factory = callable(checker, member(checker, type, 'initialState', path), `${path}.initialState`, 1);
  stringType(parameter(checker, factory, 0, `${path}.initialState.id`), `${path}.initialState.id`);
  const identity = callable(checker, member(checker, type, 'identity', path), `${path}.identity`, 1);
  const event = parameter(checker, identity, 0, `${path}.identity.event`);
  stringType(member(checker, event, 'aggregateId', path), `${path}.identity.event.aggregateId`);
  stringType(member(checker, event, 'type', path), `${path}.identity.event.type`);
  const result = checker.getReturnTypeOfSignature(identity);
  for (const part of result.isUnion() ? result.types : [result]) {
    stringType(checker.isArrayType(part) ? arrayElement(checker, part, `${path}.identity`) : part, `${path}.identity`);
  }
  streamContract(checker, member(checker, type, 'fromStream', path), `${path}.fromStream`, runtimeProjectionContract(checker, type));
  const subscription = arrayElement(checker, member(checker, type, 'subscriptions', path), `${path}.subscriptions`);
  const aggregate = member(checker, subscription, 'aggregate', `${path}.subscriptions[]`);
  aggregateReference(checker, aggregate, `${path}.subscriptions[].aggregate`);
  stringType(member(checker, subscription, 'aggregateId', path), `${path}.subscriptions[].aggregateId`);
  if (commit) {
    const policy = member(checker, type, 'deduplication', path);
    for (const part of policy.isUnion() ? policy.types : [policy]) deduplication(checker, part, `${path}.deduplication`);
  }
  projectionOptionalContract(checker, type, path);
}

export type DefinitionCandidate = { evidence: DefinitionEvidence; validate: () => void };

export function classifyDefinition(checker: ts.TypeChecker, symbol: ts.Symbol,
  cache = new Map<string, string | undefined>()): DefinitionCandidate | undefined {
  const type = valueType(checker, symbol);
  const evidence = definitionEvidence(checker, symbol, type, cache);
  if (!evidence) return;
  return { evidence, validate: () => {
    object(type, symbol.name);
    if (evidence.kind === 'aggregate') aggregateContract(checker, type, symbol.name);
    else projectionContract(checker, type, symbol.name, evidence.commit);
  } };
}
