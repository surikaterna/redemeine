import * as ts from 'typescript';

/** Strict, structural conversion isolated from the legacy aggregate policy. */
export class ProjectionTypeConverter {
  private readonly active = new Set<ts.Type>();

  constructor(private readonly checker: ts.TypeChecker) {}

  convert(type: ts.Type, path: string): string {
    if (this.active.has(type)) return this.fail(type, path, 'recursive state is unsupported');
    if (this.active.size >= 60) return this.fail(type, path, 'state exceeds the supported depth (60)');
    this.active.add(type);
    try {
      return this.convertValue(type, path);
    } finally {
      this.active.delete(type);
    }
  }

  private fail(type: ts.Type, path: string, reason: string): never {
    throw new Error(`${path}: ${reason}; resolved type ${this.checker.typeToString(type)}. Use an explicit JSON-compatible initialState return type.`);
  }

  private convertValue(type: ts.Type, path: string): string {
    const flags = type.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return this.fail(type, path, 'any/unknown or unresolved type');
    if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return this.fail(type, path, 'undefined is only supported at a syntactically optional property boundary');
    if (type.isIntersection()) return this.fail(type, path, 'intersections are unsupported');
    if (type.isUnion()) return `z.union([${type.types.map((part) => this.convert(part, path)).join(', ')}])`;
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
    return this.convertObject(type, path);
  }

  private convertObject(type: ts.Type, path: string): string {
    if (this.checker.isTupleType(type)) return this.fail(type, path, 'tuples are unsupported');
    if (this.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
        this.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length) {
      return this.fail(type, path, 'functions and constructors are unsupported');
    }
    if (this.checker.isArrayType(type)) {
      return this.convertArray(type, path);
    }
    const symbol = type.getSymbol();
    this.validateHeritage(type, path);
    if (symbol?.getName() === 'ReadonlyArray' && this.isLibraryType(symbol)) {
      return this.convertArray(type, path);
    }
    if (symbol?.getName() === 'Date' && this.isLibraryType(symbol)) return 'z.string()';
    if (symbol?.declarations?.some(ts.isClassDeclaration) || symbol?.declarations?.some(ts.isClassExpression)) {
      return this.fail(type, path, 'class instances are unsupported (except Date as string)');
    }
    return this.convertProperties(type, path);
  }

  private validateHeritage(type: ts.Type, path: string, seen = new Set<ts.Type>()): void {
    if (seen.has(type)) this.fail(type, path, 'cyclic inheritance is unsupported');
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

  private convertArray(type: ts.Type, path: string): string {
    const [element] = this.checker.getTypeArguments(type as ts.TypeReference);
    if (!element) return this.fail(type, path, 'unresolved array element type');
    return `z.array(${this.convert(element, `${path}[]`)})`;
  }

  private convertProperties(type: ts.Type, path: string): string {
    const properties = this.checker.getPropertiesOfType(type);
    const indexes = this.checker.getIndexInfosOfType(type);
    const index = indexes[0];
    if (indexes.length) {
      if (indexes.length !== 1 || !index || index.keyType.flags !== ts.TypeFlags.String || properties.length) {
        return this.fail(type, path, 'only pure string-index records are supported; mixed/indexed properties are lossy');
      }
      return `z.record(z.string(), ${this.convert(index.type, `${path}[string]`)})`;
    }
    if (!properties.length) return this.fail(type, path, 'empty object contracts are ambiguous in TypeScript');
    const fields = properties.map((property) => this.convertProperty(property, type, path));
    return `z.object({${fields.join(', ')}})`;
  }

  private convertProperty(property: ts.Symbol, parent: ts.Type, path: string): string {
    const name = property.getName();
    if (name === '__proto__') return this.fail(parent, path, 'Zod omits __proto__ for prototype safety; rename this business key');
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? parent.getSymbol()?.declarations?.[0];
    if (!declaration || this.isSymbolProperty(property)) return this.fail(parent, path, 'unresolved or symbol property');
    const optional = !!(property.flags & ts.SymbolFlags.Optional);
    const type = this.checker.getTypeOfSymbolAtLocation(property, declaration);
    const propertyPath = `${path}[${JSON.stringify(name)}]`;
    const schema = optional ? this.convertOptional(type, propertyPath) : this.convert(type, propertyPath);
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

  private convertOptional(type: ts.Type, path: string): string {
    if (!type.isUnion()) return this.convert(type, path);
    const parts = type.types.filter((part) => !(part.flags & ts.TypeFlags.Undefined));
    if (parts.length === 1 && parts[0]) return this.convert(parts[0], path);
    return `z.union([${parts.map((part) => this.convert(part, path)).join(', ')}])`;
  }
}
