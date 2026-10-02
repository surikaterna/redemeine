import * as ts from 'typescript';
import { resolveAggregateType } from './aggregateNavigator';

export function resolveProjectionState(program: ts.Program, entry: string, exportName: string): ts.Type {
  const options = program.getCompilerOptions();
  if (!(options.strictNullChecks ?? options.strict)) {
    throw new Error(`${exportName}: enable strictNullChecks (or strict) in tsconfig for faithful projection schemas`);
  }
  const checker = program.getTypeChecker();
  const definition = resolveAggregateType(program, checker, entry, exportName);
  for (const name of ['name', 'fromStream', 'identity', 'subscriptions']) {
    if (!checker.getPropertyOfType(definition, name)) {
      throw new Error(`${exportName}: expected a built projection definition; missing ${name}`);
    }
  }
  const factory = checker.getPropertyOfType(definition, 'initialState');
  const declaration = factory?.valueDeclaration ?? factory?.declarations?.[0];
  if (!factory || !declaration) {
    throw new Error(`${exportName}.initialState: expected a callable state factory`);
  }
  const type = checker.getTypeOfSymbolAtLocation(factory, declaration);
  if (type.isUnion() || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    throw new Error(`${exportName}.initialState: expected a resolved, non-optional callable state factory`);
  }
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const signature = signatures[0];
  if (signatures.length !== 1 || !signature || signature.typeParameters?.length) {
    throw new Error(`${exportName}.initialState: expected one non-generic resolved call signature`);
  }
  return checker.getReturnTypeOfSignature(signature);
}
