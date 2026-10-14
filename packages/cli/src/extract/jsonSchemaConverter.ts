import * as ts from 'typescript';
import { convertJsonObject, validateHeritage } from './jsonSchemaObjects';

export type JsonSchema = boolean | {
  $schema?: string;
  type?: string;
  const?: string | number | boolean;
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema;
};

/** Compiler types only: no schema values, generated source evaluation or runtime imports. */
export class JsonSchemaConverter {
  private readonly active = new Set<ts.Type>();
  private readonly diagnostics = new Map<ts.SourceFile, readonly ts.Diagnostic[]>();
  private declarationProgram?: ts.Program;
  readonly checker: ts.TypeChecker;

  constructor(readonly program: ts.Program) {
    this.checker = program.getTypeChecker();
    const options = program.getCompilerOptions();
    if (!(options.strictNullChecks ?? options.strict)) throw new Error('JSON Schema extraction requires strictNullChecks (or strict)');
  }

  fail(type: ts.Type, path: string, reason: string): never {
    throw new Error(`${path}: ${reason}; resolved type ${this.checker.typeToString(type)}`);
  }

  convert(type: ts.Type, path: string, declaration?: ts.Node): JsonSchema {
    if (this.active.has(type)) return this.fail(type, path, 'recursive types are unsupported');
    if (this.active.size >= 60) return this.fail(type, path, 'type exceeds supported depth (60)');
    this.active.add(type);
    try {
      this.validateDeclaration(declaration, path);
      return this.convertValue(type, path, declaration);
    } finally {
      this.active.delete(type);
    }
  }

  private convertValue(type: ts.Type, path: string, declaration?: ts.Node): JsonSchema {
    const flags = type.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return this.convertArbitrary(type, path, declaration);
    if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) return false;
    if (type.isUnion()) return this.convertUnion(type, path, declaration);
    if (type.isStringLiteral()) return { type: 'string', const: type.value };
    if (type.isNumberLiteral()) {
      if (!Number.isFinite(type.value)) return this.fail(type, path, 'non-finite literal');
      return { type: 'number', const: type.value };
    }
    if (flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: this.checker.typeToString(type) === 'true' };
    if (flags & ts.TypeFlags.String) return { type: 'string' };
    if (flags & ts.TypeFlags.Number) return { type: 'number' };
    if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (flags & ts.TypeFlags.Null) return { type: 'null' };
    if (type.isIntersection()) this.validateIntersection(type, path);
    else if (!(flags & ts.TypeFlags.Object)) return this.fail(type, path, 'unsupported non-JSON type');
    return convertJsonObject(this, type, path, declaration);
  }

  private convertUnion(type: ts.UnionType, path: string, declaration?: ts.Node): JsonSchema {
    const members = type.types.map(part => this.convert(part, path, declaration)).filter(schema => schema !== false);
    if (members.includes(true)) return true;
    if (!members.length) return false;
    if (members.length === 1) return members[0]!;
    return { anyOf: members };
  }

  private validateIntersection(type: ts.IntersectionType, path: string): void {
    if (!type.types.every(part => !!(part.flags & ts.TypeFlags.Object))) {
      this.fail(type, path, 'only resolved structural object intersections are supported');
    }
    // Validate each constituent as well as merged properties: merging must not hide
    // a class, unresolved heritage or a conflicting unsupported contract.
    for (const part of type.types) this.convert(part, path);
  }

  private convertArbitrary(type: ts.Type, path: string, declaration?: ts.Node): JsonSchema {
    if ('intrinsicName' in type && type.intrinsicName === 'error') return this.fail(type, path, 'unresolved compiler-error type');
    const annotation = this.annotation(declaration);
    if (!annotation || !this.provesArbitrary(annotation, type, path)) {
      return this.fail(type, path, 'any/unknown requires an explicit resolvable type declaration');
    }
    console.warn(`${path}: explicit ${this.checker.typeToString(type)} represented as true (JSON values only; no runtime refinements)`);
    return true;
  }

  private provesArbitrary(node: ts.TypeNode, type: ts.Type, path: string, seen = new Set<ts.Node>()): boolean {
    if (seen.has(node) || seen.size >= 60) return false;
    seen.add(node);
    this.validateDeclaration(node, path);
    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
      return this.checker.getTypeAtLocation(node) === type;
    }
    if (ts.isTypeReferenceNode(node)) {
      const symbol = this.checker.getSymbolAtLocation(node.typeName);
      const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol);
      if (resolved?.declarations?.some(decl => ts.isTypeAliasDeclaration(decl) && this.provesArbitrary(decl.type, type, path, seen))) return true;
    }
    return ts.forEachChild(node, child => ts.isTypeNode(child) && this.provesArbitrary(child, type, path, seen) ? true : undefined) ?? false;
  }

  private annotation(node?: ts.Node): ts.TypeNode | undefined {
    if (!node) return undefined;
    if (ts.isTypeNode(node)) return node;
    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)
      || ts.isTypeAliasDeclaration(node) || ts.isIndexSignatureDeclaration(node)) return node.type;
    return undefined;
  }

  validateDeclaration(node: ts.Node | undefined, path: string, seen = new Set<ts.Node>(), depth = 0): void {
    const annotation = this.annotation(node);
    if (!annotation || seen.has(annotation)) return;
    if (depth >= 60) throw new Error(`${path}: type declaration exceeds supported depth (60)`);
    seen.add(annotation);
    this.validateDiagnosticScope(annotation, path);
    this.validateReferences(annotation, path, seen, depth);
  }

  validateDataDeclaration(node: ts.Node, path: string): void {
    if (ts.isInterfaceDeclaration(node) || ts.isIndexSignatureDeclaration(node)) {
      this.validateDiagnosticScope(node, path);
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (node.name) this.validateDiagnosticScope(node.name, path);
      for (const clause of node.heritageClauses ?? []) this.validateDiagnosticScope(clause, path);
    }
    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) {
      this.validateDiagnosticScope(node.name, path);
      this.validateDeclaration(node, path);
    }
  }

  private validateDiagnosticScope(node: ts.Node, path: string): void {
    const source = node.getSourceFile();
    const error = this.sourceDiagnostics(source).find(item => item.category === ts.DiagnosticCategory.Error
      && item.file?.fileName === source.fileName && item.start !== undefined && item.start >= node.getStart() && item.start < node.end);
    if (error) throw new Error(`${this.diagnosticPath(node, error.start!, path)}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  }

  private sourceDiagnostics(source: ts.SourceFile): readonly ts.Diagnostic[] {
    const cached = this.diagnostics.get(source);
    if (cached) return cached;
    const options = this.program.getCompilerOptions();
    const program = source.isDeclarationFile && (options.skipLibCheck || options.skipDefaultLibCheck)
      ? (this.declarationProgram ??= this.createDeclarationProgram()) : this.program;
    const checked = program.getSourceFile(source.fileName);
    if (!checked) throw new Error(`${source.fileName}: missing compiler diagnostic source`);
    const diagnostics = program.getSemanticDiagnostics(checked);
    this.diagnostics.set(source, diagnostics);
    return diagnostics;
  }

  private createDeclarationProgram(): ts.Program {
    // skipLibCheck must not authorize a recovered, contradictory data shape. This
    // diagnostic-only pass reuses the original source/module graph; only requested
    // declaration spans are checked, not unrelated application or constructor bodies.
    const options = { ...this.program.getCompilerOptions(), skipLibCheck: false, skipDefaultLibCheck: false };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (name, ...args) => this.program.getSourceFile(name) ?? getSourceFile(name, ...args);
    host.resolveModuleNameLiterals = (literals, containingFile) => literals.map(literal => {
      const source = this.checker.getSymbolAtLocation(literal)?.declarations?.find(ts.isSourceFile);
      if (!source) return ts.resolveModuleName(literal.text, containingFile, options, host);
      const extension = Object.values(ts.Extension).sort((a, b) => b.length - a.length).find(value => source.fileName.endsWith(value)) ?? ts.Extension.Ts;
      return { resolvedModule: { resolvedFileName: source.fileName, extension, isExternalLibraryImport: this.program.isSourceFileFromExternalLibrary(source) } };
    });
    return ts.createProgram({ rootNames: this.program.getSourceFiles().map(source => source.fileName), options, host });
  }

  private validateReferences(annotation: ts.TypeNode, path: string, seen: Set<ts.Node>, depth: number): void {
    const visit = (node: ts.Node): void => {
      if (ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node)) {
        const referencePath = this.diagnosticPath(annotation, node.getStart(), path);
        const type = this.checker.getTypeAtLocation(node);
        if ('intrinsicName' in type && type.intrinsicName === 'error') this.fail(type, referencePath, 'unresolved compiler-error reference');
        if (type.flags & ts.TypeFlags.Object) validateHeritage(this, type, referencePath);
        const symbol = this.checker.getSymbolAtLocation(ts.isTypeReferenceNode(node) ? node.typeName : node.exprName);
        const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol);
        for (const declaration of resolved?.declarations ?? []) {
          if (ts.isTypeAliasDeclaration(declaration)) this.validateDeclaration(declaration, referencePath, seen, depth + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(annotation);
  }

  private diagnosticPath(node: ts.Node, position: number, path: string): string {
    if (ts.isPropertySignature(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      path += `[${JSON.stringify(node.name.text)}]`;
    }
    if (ts.isArrayTypeNode(node)) path += '[]';
    const child = ts.forEachChild(node, child => child.getStart() <= position && position < child.end ? child : undefined);
    return child ? this.diagnosticPath(child, position, path) : path;
  }
}
