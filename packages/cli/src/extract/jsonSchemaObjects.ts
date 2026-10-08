import * as ts from 'typescript';
import type { JsonSchema, JsonSchemaConverter } from './jsonSchemaConverter';

export function convertJsonObject(converter: JsonSchemaConverter, type: ts.Type, path: string, declaration?: ts.Node): JsonSchema {
  const { checker, program } = converter;
  if (checker.isTupleType(type)) return converter.fail(type, path, 'tuples are unsupported');
  if (type.getCallSignatures().length || type.getConstructSignatures().length) {
    return converter.fail(type, path, 'functions and constructors are unsupported');
  }
  const symbol = type.getSymbol();
  const library = symbol?.declarations?.some(node => program.isSourceFileDefaultLibrary(node.getSourceFile()));
  if (symbol?.getName() === 'Date' && library) return { type: 'string' };
  validateHeritage(converter, type, path);
  if (checker.isArrayType(type) || (symbol?.getName() === 'ReadonlyArray' && library)) {
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    if (!element) return converter.fail(type, path, 'unresolved array element');
    return { type: 'array', items: converter.convert(element, `${path}[]`, declaration ?? type.aliasSymbol?.declarations?.[0]) };
  }
  return convertProperties(converter, type, path, declaration);
}

export function validateHeritage(converter: JsonSchemaConverter, type: ts.Type, path: string, seen = new Set<ts.Type>()): void {
  if (seen.has(type) || seen.size >= 60) converter.fail(type, path, 'cyclic or excessively deep inheritance');
  seen.add(type);
  const declarations = type.getSymbol()?.declarations ?? [];
  for (const declaration of declarations) converter.validateDataDeclaration(declaration, path);
  if (declarations.some(node => ts.isClassDeclaration(node) || ts.isClassExpression(node)) && !type.getProperties().length) {
    converter.fail(type, path, 'class without declared data fields is unsupported');
  }
  const bases = declarations.filter(node => ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
    .flatMap(node => node.heritageClauses?.flatMap(clause => clause.types) ?? []);
  for (const base of bases) {
    const resolved = converter.checker.getTypeAtLocation(base);
    if (resolved.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) converter.fail(type, path, `unresolved inherited contract ${base.getText()}`);
    validateHeritage(converter, resolved, path, new Set(seen));
  }
}

function convertProperties(converter: JsonSchemaConverter, type: ts.Type, path: string, declaration?: ts.Node): JsonSchema {
  const properties = [...converter.checker.getPropertiesOfType(type)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const fields = properties.map(property => convertProperty(converter, type, property, path));
  const indexes = converter.checker.getIndexInfosOfType(type);
  const index = indexes[0];
  if (indexes.length > 1 || (index && index.keyType.flags !== ts.TypeFlags.String)) {
    return converter.fail(type, path, 'only string-index records are supported');
  }
  if (index) {
    for (const field of fields) {
      const unbounded = field.type.flags & ts.TypeFlags.Any && !(index.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
      if (unbounded || !converter.checker.isTypeAssignableTo(field.type, index.type)) {
        converter.fail(type, `${path}[${JSON.stringify(field.name)}]`, 'property conflicts with string-index constraint');
      }
    }
  }
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map(field => [field.name, field.schema])),
    required: fields.filter(field => !field.optional).map(field => field.name),
    ...(index ? { additionalProperties: converter.convert(index.type, `${path}[string]`, index.declaration ?? declaration) } : {}),
  };
}

function convertProperty(converter: JsonSchemaConverter, parent: ts.Type, property: ts.Symbol, path: string) {
  const name = property.getName();
  const propertyPath = `${path}[${JSON.stringify(name)}]`;
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  if (!declaration || property.escapedName !== ts.escapeLeadingUnderscores(name)) {
    return converter.fail(parent, propertyPath, 'unresolved or symbol property');
  }
  for (const member of property.declarations ?? [declaration]) converter.validateDataDeclaration(member, propertyPath);
  const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : [];
  if (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)
    || modifiers?.some(item => item.kind === ts.SyntaxKind.PrivateKeyword || item.kind === ts.SyntaxKind.ProtectedKeyword)) {
    return converter.fail(parent, propertyPath, 'only public data fields are supported');
  }
  const type = converter.checker.getTypeOfSymbolAtLocation(property, declaration);
  const optional = !!(property.flags & ts.SymbolFlags.Optional);
  if (parent.isIntersection() && type.flags & ts.TypeFlags.Never) converter.fail(parent, propertyPath, 'conflicting intersection property');
  return { name, optional, type, schema: converter.convert(type, propertyPath, declaration) };
}
