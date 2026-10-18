import * as ts from 'typescript';
import { arrayAnnotation, assertSupportedGenerics, branchAnnotation, recordAnnotations } from './schemaProvenance';
import { instantiatedProperty } from './instantiatedProperty';

/** Strict, structural conversion isolated from the legacy aggregate policy. */
export class ProjectionTypeConverter {
  private readonly active = new Set<ts.Type>();

  constructor(private readonly checker: ts.TypeChecker, private readonly sortProperties = false, private readonly maxDepth = 60,
    private readonly resolveSchema?: (type: ts.Type, declaration?: ts.Node) => string | null,
    private readonly aggregateModel = false) {}

  convert(type: ts.Type, path: string, declaration?: ts.Node): string {
    const schema = this.resolveSchema?.(type, declaration);
    if (schema) return schema;
    assertSupportedGenerics(this.checker, type, path, declaration);
    if (this.active.has(type)) return this.fail(type, path, 'recursive state is unsupported');
    if (this.active.size > this.maxDepth) return this.fail(type, path, `state depth exceeds maxDepth (${this.maxDepth})`);
    this.active.add(type);
    try {
      return this.convertValue(type, path, declaration);
    } finally {
      this.active.delete(type);
    }
  }

  private fail(type: ts.Type, path: string, reason: string): never {
    throw new Error(`${path}: ${reason}; resolved type ${this.checker.typeToString(type)}. Use an explicit JSON-compatible initialState return type.`);
  }

  private convertValue(type: ts.Type, path: string, declaration?: ts.Node): string {
    const flags = type.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return this.fail(type, path, 'any/unknown or unresolved type');
    if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return this.fail(type, path, 'undefined is only supported at a syntactically optional property boundary');
    if (type.isIntersection()) return this.convertIntersection(type, path, declaration);
    if (type.isUnion()) return `z.union([${type.types.map((part) => this.convert(part, path, branchAnnotation(this.checker, part, declaration))).join(', ')}])`;
    if (flags & ts.TypeFlags.StringLiteral) return `z.literal(${JSON.stringify((type as ts.StringLiteralType).value)})`;
    if (flags & ts.TypeFlags.NumberLiteral) {
      const value = (type as ts.NumberLiteralType).value;
      if (!Number.isFinite(value)) return this.fail(type, path, 'non-finite literals are not JSON-compatible');
      return `z.literal(${value})`;
    }
    if (flags & ts.TypeFlags.BooleanLiteral) return `z.literal(${this.checker.typeToString(type)})`;
    if (flags & ts.TypeFlags.String) return 'z.string()';
    if (flags & ts.TypeFlags.Number) return 'z.number()';
    if (flags & ts.TypeFlags.Boolean) return 'z.boolean()';
    if (flags & ts.TypeFlags.Null) return 'z.null()';
    if (!(flags & ts.TypeFlags.Object)) return this.fail(type, path, 'unsupported non-JSON type');
    return this.convertObject(type, path, declaration);
  }

  private convertIntersection(type: ts.IntersectionType, path: string, declaration?: ts.Node): string {
    if (!this.aggregateModel) return this.fail(type, path, 'intersections are unsupported');
    for (const part of type.types) {
      if (!(part.flags & ts.TypeFlags.Object) || this.checker.isArrayType(part) || this.checker.isTupleType(part) ||
          part.getCallSignatures().length || part.getConstructSignatures().length || this.checker.getIndexInfosOfType(part).length ||
          part.getSymbol()?.declarations?.some(node => ts.isClassDeclaration(node) ||
            (part.getSymbol()?.name !== '__type' && /\/lib\.[^/]+\.d\.ts$/.test(node.getSourceFile().fileName)))) {
        return this.fail(type, path, 'only plain structural object intersections are supported for aggregate models');
      }
      assertSupportedGenerics(this.checker, part, path);
      if (this.resolveSchema?.(part)) return this.fail(type, path, 'authored intersection members require an explicit whole-model schema');
      this.validateHeritage(part, path);
    }
    return this.convertProperties(type, path, declaration);
  }

  private convertObject(type: ts.Type, path: string, declaration?: ts.Node): string {
    if (this.checker.isTupleType(type)) return this.fail(type, path, 'tuples are unsupported');
    if (this.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
        this.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length) {
      return this.fail(type, path, 'functions and constructors are unsupported');
    }
    if (this.checker.isArrayType(type)) {
      return this.convertArray(type, path, declaration);
    }
    const symbol = type.getSymbol();
    this.validateHeritage(type, path);
    if (symbol?.getName() === 'ReadonlyArray' && this.isLibraryType(symbol)) {
      return this.convertArray(type, path, declaration);
    }
    if (symbol?.getName() === 'Date' && this.isLibraryType(symbol)) return 'z.string()';
    if (symbol?.declarations?.some(ts.isClassDeclaration) || symbol?.declarations?.some(ts.isClassExpression)) {
      return this.fail(type, path, 'class instances are unsupported (except Date as string)');
    }
    return this.convertProperties(type, path, declaration);
  }

  private validateHeritage(type: ts.Type, path: string, seen = new Set<ts.Type>()): void {
    if (seen.has(type) || seen.size > this.maxDepth) this.fail(type, path, 'cyclic or excessively deep inheritance is unsupported');
    seen.add(type);
    const declarations = type.getSymbol()?.declarations ?? [];
    const interfaces = declarations.filter(ts.isInterfaceDeclaration);
    const bases = interfaces.flatMap((declaration) => declaration.heritageClauses?.flatMap((clause) => clause.types) ?? []);
    for (const base of bases) {
      const resolved = this.checker.getTypeAtLocation(base);
      if (resolved.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
        this.fail(type, path, `unresolved inherited contract ${base.getText()}`);
      }
      this.validateHeritage(resolved, path, new Set(seen));
    }
  }

  private isLibraryType(symbol: ts.Symbol): boolean {
    return symbol.declarations?.some((node) => /\/lib\.[^/]+\.d\.ts$/.test(node.getSourceFile().fileName)) ?? false;
  }

  private convertArray(type: ts.Type, path: string, declaration?: ts.Node): string {
    const [element] = this.checker.getTypeArguments(type as ts.TypeReference);
    if (!element) return this.fail(type, path, 'unresolved array element type');
    return `z.array(${this.convert(element, `${path}[]`, arrayAnnotation(this.checker, declaration ?? type.aliasSymbol?.declarations?.[0]))})`;
  }

  private convertProperties(type: ts.Type, path: string, declaration?: ts.Node): string {
    const properties = [...this.checker.getPropertiesOfType(type)];
    if (this.sortProperties) properties.sort((a, b) => a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0);
    const indexes = this.checker.getIndexInfosOfType(type);
    const index = indexes[0];
    if (indexes.length) {
      if (indexes.length !== 1 || !index || index.keyType.flags !== ts.TypeFlags.String || properties.length) {
        return this.fail(type, path, 'only pure string-index records are supported; mixed/indexed properties are lossy');
      }
      const annotations = recordAnnotations(this.checker, declaration ?? type.aliasSymbol?.declarations?.[0]);
      const key = annotations?.[0] ? this.convert(index.keyType, `${path}[key]`, annotations[0]) : 'z.string()';
      return `z.record(${key}, ${this.convert(index.type, `${path}[string]`, annotations?.[1] ?? index.declaration)})`;
    }
    if (!properties.length) return this.fail(type, path, 'empty object contracts are ambiguous in TypeScript');
    const fields = properties.map((property) => this.convertProperty(property, type, path));
    return `z.object({${fields.join(', ')}})`;
  }

  private convertProperty(property: ts.Symbol, parent: ts.Type, path: string): string {
    const name = property.getName();
    if (name === '__proto__') return this.fail(parent, path, 'Zod omits __proto__ for prototype safety; rename this business key');
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? parent.getSymbol()?.declarations?.[0];
    const instantiated = !declaration && this.aggregateModel ? instantiatedProperty(this.checker, parent, property) : undefined;
    if ((!declaration && !instantiated) || this.isSymbolProperty(property)) return this.fail(parent, `${path}[${JSON.stringify(name)}]`, 'unresolved or symbol property');
    const optional = !!(property.flags & ts.SymbolFlags.Optional);
    const type = instantiated ?? this.checker.getTypeOfSymbolAtLocation(property, declaration!);
    const propertyPath = `${path}[${JSON.stringify(name)}]`;
    const schema = optional ? this.convertOptional(type, propertyPath, declaration) : this.convert(type, propertyPath, declaration);
    return `[${JSON.stringify(name)}]: ${schema}${optional ? '.optional()' : ''}`;
  }

  private isSymbolProperty(property: ts.Symbol): boolean {
    // String keys round-trip through compiler escaping; synthetic symbol identities do not (including mapped keys).
    if (property.escapedName !== ts.escapeLeadingUnderscores(property.getName())) return true;
    return property.declarations?.some((declaration) => {
      if (!(ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration))) return false;
      return ts.isComputedPropertyName(declaration.name) &&
        !!(this.checker.getTypeAtLocation(declaration.name.expression).flags & ts.TypeFlags.ESSymbolLike);
    }) ?? false;
  }

  private convertOptional(type: ts.Type, path: string, declaration?: ts.Node): string {
    if (!type.isUnion()) return this.convert(type, path, declaration);
    const parts = type.types.filter((part) => !(part.flags & ts.TypeFlags.Undefined));
    if (parts.length === 1 && parts[0]) return this.convert(parts[0], path, declaration);
    return `z.union([${parts.map((part) => this.convert(part, path, declaration)).join(', ')}])`;
  }
}
