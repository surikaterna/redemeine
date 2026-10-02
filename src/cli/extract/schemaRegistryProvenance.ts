import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { canonicalSymbol } from './schemaRegistryIdentity';

export type DefinitionEvidence = { kind: 'aggregate' | 'projection'; commit: boolean };
const packageNames = new Set(['@redemeine/aggregate', '@redemeine/projection', '@redemeine/projection-runtime-core']);

export function canonicalCreatorSignature(signature: ts.Signature): boolean {
  const declaration = signature.declaration;
  if (!declaration || packageName(declaration.getSourceFile().fileName, new Map()) !== '@redemeine/aggregate') return false;
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'EventEmitterFactory') return true;
  }
  return false;
}

export function aggregateReferenceEvidence(checker: ts.TypeChecker, type: ts.Type,
  cache: Map<string, string | undefined>): 'built' | 'definition' | 'source' | 'narrow' | undefined {
  for (const key of ['aggregateType', 'process', 'initialState']) {
    for (const node of checker.getPropertyOfType(type, key)?.declarations ?? []) {
      if (declarationEvidence(node, cache)?.kind === 'aggregate') return 'built';
    }
  }
  for (const node of checker.getPropertyOfType(type, 'aggregateType')?.declarations ?? []) {
    const packageId = packageName(node.getSourceFile().fileName, cache);
    if (packageId !== '@redemeine/projection' && packageId !== '@redemeine/projection-runtime-core') continue;
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if (!ts.isInterfaceDeclaration(parent) && !ts.isTypeAliasDeclaration(parent)) continue;
      if (parent.name.text === 'AggregateDefinition') return 'definition';
      if (parent.name.text === 'ProjectionAggregateSource') return 'source';
      if (['ProjectionStreamDefinition', 'ProjectionDefinition', 'JoinStreamDefinition',
        'ReverseSubscribeStreamDefinition'].includes(parent.name.text)) return 'narrow';
    }
  }
}

export function runtimeProjectionContract(checker: ts.TypeChecker, type: ts.Type): boolean {
  const cache = new Map<string, string | undefined>();
  const declarations = [...(type.aliasSymbol?.declarations ?? []), ...(type.getSymbol()?.declarations ?? [])];
  for (const key of ['name', 'initialState', 'fromStream']) {
    declarations.push(...(checker.getPropertyOfType(type, key)?.declarations ?? []));
  }
  return declarations.some((node) => packageName(node.getSourceFile().fileName, cache) === '@redemeine/projection-runtime-core' &&
    declarationEvidence(node, cache)?.kind === 'projection');
}

function packageName(file: string, cache: Map<string, string | undefined>): string | undefined {
  if (cache.has(file)) return cache.get(file);
  let directory = dirname(file);
  let name: string | undefined;
  while (dirname(directory) !== directory) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const data: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (data && typeof data === 'object' && 'name' in data && typeof data.name === 'string') name = data.name;
      break;
    }
    directory = dirname(directory);
  }
  cache.set(file, name);
  return name;
}

function declarationEvidence(node: ts.Node, cache: Map<string, string | undefined>): DefinitionEvidence | undefined {
  const packageId = packageName(node.getSourceFile().fileName, cache);
  if (!packageId || !packageNames.has(packageId)) return;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (!ts.isInterfaceDeclaration(current) && !ts.isTypeAliasDeclaration(current)) continue;
    const name = current.name.text;
    if (packageId === '@redemeine/aggregate' && name === 'BuiltAggregate') return { kind: 'aggregate', commit: false };
    if (packageId !== '@redemeine/aggregate' && ['ProjectionDefinition', 'ProjectionCommitDefinition'].includes(name)) {
      return { kind: 'projection', commit: name === 'ProjectionCommitDefinition' };
    }
    if (packageId === '@redemeine/aggregate' && name === 'AggregateBuilder') {
      // Only the build return contract, never the builder's other members.
      let member: ts.Node = node;
      while (member.parent && member.parent !== current) member = member.parent;
      if (ts.isPropertySignature(member) && member.name.getText() === 'build') return { kind: 'aggregate', commit: false };
    }
  }
}

export function definitionEvidence(checker: ts.TypeChecker, symbol: ts.Symbol, type: ts.Type,
  cache: Map<string, string | undefined>): DefinitionEvidence | undefined {
  if (type.isUnion()) {
    for (const part of type.types) {
      const evidence = definitionEvidence(checker, symbol, part, cache);
      if (evidence) return evidence;
    }
  }
  const declarations = [...(type.aliasSymbol?.declarations ?? []), ...(type.getSymbol()?.declarations ?? [])];
  for (const declaration of declarations) {
    const evidence = declarationEvidence(declaration, cache);
    if (evidence) return evidence;
  }
  for (const key of ['aggregateType', 'name', 'process', 'initialState', 'fromStream']) {
    for (const declaration of checker.getPropertyOfType(type, key)?.declarations ?? []) {
      const evidence = declarationEvidence(declaration, cache);
      if (evidence) return evidence;
    }
  }
  let declaration: ts.Declaration | undefined;
  try {
    declaration = canonicalSymbol(checker, symbol).valueDeclaration;
  } catch {
    // Without retained contract evidence an unresolved alias is unrelated, not a candidate.
    return;
  }
  let expression = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer :
    declaration && ts.isExportAssignment(declaration) ? declaration.expression : undefined;
  while (expression && (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) ||
      ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression))) expression = expression.expression;
  if (!expression || !ts.isCallExpression(expression)) return;
  const signature = checker.getResolvedSignature(expression);
  if (!signature?.declaration) return;
  const evidence = declarationEvidence(signature.declaration, cache);
  if (evidence) return evidence;
  const packageId = packageName(signature.declaration.getSourceFile().fileName, cache);
  if (!packageId || !packageNames.has(packageId)) return;
  const returnType = checker.getReturnTypeOfSignature(signature);
  for (const node of returnType.getSymbol()?.declarations ?? []) {
    const result = declarationEvidence(node, cache);
    if (result) return result;
  }
}
