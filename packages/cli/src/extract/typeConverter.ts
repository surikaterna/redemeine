import * as ts from 'typescript';
import { existingSchemaImport } from './schemaImport';
import { documentationComment } from './schemaSource';
import { intersectionSchema } from './intersectionSchema';
import { objectSchema, tupleSchema } from './zodContainers';
import { schemaReference } from './schemaReference';
import type { SchemaPolicy } from './schemaConfig';
import { JsonSchemaConverter } from './jsonSchemaConverter';
import { validateHeritage } from './jsonSchemaObjects';
import { schemaComposition, type SchemaComposition } from './schemaComposition';
import { arrayAnnotation, assertSupportedGenerics, branchAnnotation } from './schemaProvenance';

/**
 * Converts TypeScript types to Zod schema source code strings.
 *
 * Handles deduplication of named types, z.infer detection for existing
 * schemas, and recursive structural conversion of object/union/array types.
 */
export class TypeToZodConverter {
    readonly knownSchemas = new Map<ts.Type, string>();
    readonly generatedShared = new Map<string, string>();
    readonly sharedComments = new Map<string, string>();
    readonly imports = new Set<string>();
    private readonly overrideSchemas = new Map<string, string>();
    private readonly importedSchemaTypes = new Set<ts.Type>();
    private readonly schemaReferences = new Map<ts.EntityName, string>();
    private readonly bindings = new Set(['z', 'commandSchemas', 'eventSchemas', 'stateSchema']);
    private readonly active = new Set<ts.Type>();
    private readonly activeCompositions = new Set<ts.Node>();
    private diagnostics?: JsonSchemaConverter;

    constructor(
        readonly checker: ts.TypeChecker,
        readonly program: ts.Program,
        private dateHandling: 'string' | 'date' = 'string',
        private typeOverrides: Record<string, string> = {},
        private outFile?: string,
        readonly policy: SchemaPolicy = { mode: 'types-first', maxDepth: 60 },
        private readonly bindingPrefix = ''
    ) {}

    convert(type: ts.Type, depth = 0, path = 'schema', declaration?: ts.Node): string {
        if (this.policy.mode === 'types-first' && type.aliasSymbol && this.typeOverrides[type.aliasSymbol.name]) {
            return this.convertNamedType(type, depth, path)!;
        }
        const existing = this.resolveExistingSchema(type, declaration);
        if (existing && this.importedSchemaTypes.has(type)) return existing;
        if (this.policy.mode === 'zod-first') return this.fail(type, path, 'no importable Zod schema; export a schema-derived type or opt in to types-first');
        assertSupportedGenerics(this.checker, type, path, declaration);
        if ('intrinsicName' in type && type.intrinsicName === 'error') return this.fail(type, path, 'unresolved compiler-error type');
        if (depth > this.policy.maxDepth) return this.fail(type, path, `structural depth exceeds maxDepth (${this.policy.maxDepth})`);
        if (this.active.has(type)) return this.fail(type, path, 'recursive type requires an existing Zod schema');
        this.validate(type, path, declaration);
        const composition = schemaComposition(this.checker, type, declaration);
        if (composition) return this.convertComposition(type, composition, depth, path);
        this.active.add(type);
        try {
            return this.convertNamedType(type, depth, path, declaration) ?? this.convertStructural(type, depth, path, declaration);
        } finally {
            this.active.delete(type);
        }
    }

    /** Attempt dedup/z.infer resolution for alias-named types. */
    private convertNamedType(type: ts.Type, depth: number, path: string, declaration?: ts.Node): string | null {
        const aliasSymbol = type.aliasSymbol;
        if (!aliasSymbol) return null;

        const typeName = aliasSymbol.getName();

        // Consumer-provided override takes priority
        if (this.typeOverrides[typeName]) {
            if (!this.overrideSchemas.has(typeName)) {
                const varName = this.allocateBinding(this.preferredName(typeName));
                this.generatedShared.set(varName, this.typeOverrides[typeName]);
                this.overrideSchemas.set(typeName, varName);
            }
            return this.overrideSchemas.get(typeName)!;
        }

        const existing = this.resolveExistingSchema(type, declaration);
        if (existing) return existing;

        const zodCode = this.convertStructural(type, depth, path, declaration);
        const varName = this.allocateBinding(this.preferredName(typeName));
        this.generatedShared.set(varName, zodCode);
        this.sharedComments.set(varName, documentationComment(aliasSymbol, this.checker));
        this.knownSchemas.set(type, varName);
        return varName;
    }

    fail(type: ts.Type, path: string, reason: string): never {
        throw new Error(`${path}: ${reason}; resolved type ${this.checker.typeToString(type)}`);
    }

    private validate(type: ts.Type, path: string, declaration?: ts.Node): void {
        const options = this.program.getCompilerOptions();
        if (!(options.strictNullChecks ?? options.strict)) this.fail(type, path, 'enable strictNullChecks (or strict) for faithful Zod schemas');
        const diagnostics = this.diagnostics ??= new JsonSchemaConverter(this.program, this.policy.maxDepth);
        const origin = declaration ?? type.aliasSymbol?.declarations?.[0];
        diagnostics.validateDeclaration(origin, path);
        if (type.flags & ts.TypeFlags.Any) diagnostics.assertArbitraryDeclaration(type, path, origin);
        if (type.flags & ts.TypeFlags.Object) validateHeritage(diagnostics, type, path);
    }

    private convertComposition(type: ts.Type, node: SchemaComposition, depth: number, path: string): string {
        if (this.activeCompositions.has(node)) return this.fail(type, path, 'recursive schema composition requires an authored Zod schema');
        this.activeCompositions.add(node);
        try {
            const members = node.types.map(part => ({ type: this.checker.getTypeAtLocation(part),
                schema: this.convert(this.checker.getTypeAtLocation(part), depth + 1, path, part) }));
            if (ts.isUnionTypeNode(node)) return `z.union([${members.map(member => member.schema).join(', ')}])`;
            return members.map(member => member.schema).reduce((left, right) => `z.intersection(${left}, ${right})`);
        } finally {
            this.activeCompositions.delete(node);
        }
    }

    private preferredName(typeName: string): string {
        return typeName.charAt(0).toLowerCase() + typeName.slice(1) + 'Schema';
    }

    private allocateBinding(preferred: string): string {
        const sanitized = (this.bindingPrefix + preferred).replace(/[^A-Za-z0-9_$]/g, '_');
        const base = /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
        let name = base;
        let suffix = 2;
        while (this.bindings.has(name)) name = `${base}${suffix++}`;
        this.bindings.add(name);
        return name;
    }

    /**
     * Check if a type alias resolves to `z.infer<typeof X>`.
     * If so, register X as a known schema and return its variable name.
     */
    resolveExistingSchema(type: ts.Type, declaration?: ts.Node): string | null {
        const query = schemaReference(this.checker, type, declaration);
        if (query) {
            const cached = this.schemaReferences.get(query);
            if (cached) return cached;
            const name = this.allocateBinding(`_existingSchema${this.imports.size}`);
            const schema = existingSchemaImport(this.checker, this.program, query, this.outFile, name);
            this.imports.add(schema.statement);
            this.schemaReferences.set(query, schema.name);
            // Primitive type identities are shared: do not bind every string to one inferred schema.
            if (type.aliasSymbol) this.knownSchemas.set(type, schema.name);
            this.importedSchemaTypes.add(type);
            return schema.name;
        }
        const aliasSymbol = type.aliasSymbol;
        if (!aliasSymbol) return null;

        if (this.knownSchemas.has(type)) {
            return this.knownSchemas.get(type)!;
        }

        const declarations = aliasSymbol.getDeclarations();
        if (!declarations) return null;

        for (const decl of declarations) {
            const query = this.detectZodInfer(decl);
            if (query) {
                const name = this.allocateBinding(`_existingSchema${this.imports.size}`);
                const schema = existingSchemaImport(this.checker, this.program, query, this.outFile, name);
                this.knownSchemas.set(type, schema.name);
                this.importedSchemaTypes.add(type);
                this.imports.add(schema.statement);
                return schema.name;
            }
        }

        return null;
    }

    /** Detect `z.infer<typeof X>` pattern in a type alias declaration. */
    private detectZodInfer(decl: ts.Declaration): ts.EntityName | null {
        if (!ts.isTypeAliasDeclaration(decl) || !decl.type) return null;
        if (!ts.isTypeReferenceNode(decl.type)) return null;

        const typeRef = decl.type;
        const reference = this.checker.getSymbolAtLocation(typeRef.typeName);
        const resolved = reference && (reference.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(reference) : reference);
        if (!resolved?.declarations?.some(node => /[/\\]zod[/\\]/.test(node.getSourceFile().fileName))) return null;
        if (!typeRef.typeArguments || typeRef.typeArguments.length !== 1) return null;

        const typeArg = typeRef.typeArguments[0];
        if (!typeArg || !ts.isTypeQueryNode(typeArg)) return null;

        return typeArg.exprName;
    }

    /** Structural (non-named) type conversion. */
    convertStructural(type: ts.Type, depth: number, path = 'schema', declaration?: ts.Node): string {
        if (depth > this.policy.maxDepth) return this.fail(type, path, `structural depth exceeds maxDepth (${this.policy.maxDepth})`);

        const primitive = this.convertPrimitive(type);
        if (primitive) return primitive;

        const literal = this.convertLiteral(type);
        if (literal) return literal;

        if (type.isUnion()) return this.convertUnion(type, depth, path, declaration);
        if (type.isIntersection()) return this.convertIntersection(type, depth, path);

        if (this.isDateType(type)) {
            return this.dateHandling === 'date' ? 'z.date()' : 'z.string()';
        }

        if (this.checker.isTupleType(type)) return tupleSchema(type as ts.TypeReference, depth, path, this, declaration);
        if (this.isArrayType(type)) {
            const el = this.getArrayElementType(type);
            return el ? `z.array(${this.convert(el, depth + 1, `${path}[]`, arrayAnnotation(this.checker, declaration ?? type.aliasSymbol?.declarations?.[0]))})` : this.fail(type, path, 'unresolved array element');
        }

        if (type.flags & ts.TypeFlags.Object) return objectSchema(type, depth, path, this, declaration);

        return this.fail(type, path, 'unsupported type; supply an existing Zod schema');
    }

    private convertPrimitive(type: ts.Type): string | null {
        const f = type.flags;
        if (f & ts.TypeFlags.String) return 'z.string()';
        if (f & ts.TypeFlags.Number) return 'z.number()';
        if (f & ts.TypeFlags.Boolean) return 'z.boolean()';
        if (f & ts.TypeFlags.Void) return 'z.void()';
        if (f & ts.TypeFlags.Undefined) return 'z.undefined()';
        if (f & ts.TypeFlags.Null) return 'z.null()';
        if (f & ts.TypeFlags.Any) return 'z.any()';
        if (f & ts.TypeFlags.Unknown) return 'z.unknown()';
        if (f & ts.TypeFlags.Never) return 'z.never()';
        return null;
    }

    private convertIntersection(type: ts.IntersectionType, depth: number, path: string): string {
        const members = type.types.map(member => {
            if (this.typeOverrides[member.aliasSymbol?.getName() ?? '']) {
                return { type: member, schema: this.convert(member, depth + 1, path) };
            }
            const existing = this.resolveExistingSchema(member);
            const schema = this.importedSchemaTypes.has(member) ? existing : null;
            return { type: member, schema };
        });
        return intersectionSchema(type, members, this.checker, depth, {
            convert: (member, level) => this.convert(member, level, path),
            object: (member, level) => objectSchema(member, level, path, this)
        });
    }

    private convertLiteral(type: ts.Type): string | null {
        if (type.isStringLiteral()) return `z.literal(${JSON.stringify(type.value)})`;
        if (type.isNumberLiteral()) return `z.literal(${type.value})`;
        if (type.flags & ts.TypeFlags.BooleanLiteral) {
            const name = this.checker.typeToString(type);
            return name === 'true' ? 'z.literal(true)' : 'z.literal(false)';
        }
        return null;
    }

    private convertUnion(type: ts.UnionType, depth: number, path: string, declaration?: ts.Node): string {
        const hasNull = type.types.some(t => t.flags & ts.TypeFlags.Null);
        const nonNull = type.types.filter(t => !(t.flags & ts.TypeFlags.Null));

        if (this.isBooleanUnion(nonNull)) {
            return hasNull ? 'z.boolean().nullable()' : 'z.boolean()';
        }

        if (nonNull.every(t => t.isStringLiteral())) {
            const vals = nonNull.map(t => JSON.stringify((t as ts.StringLiteralType).value));
            const base = `z.enum([${vals.join(', ')}])`;
            return hasNull ? `${base}.nullable()` : base;
        }

        if (nonNull.length === 1 && nonNull[0]) {
            const base = this.convert(nonNull[0], depth + 1, path, branchAnnotation(this.checker, nonNull[0], declaration));
            return hasNull ? `${base}.nullable()` : base;
        }

        const members = nonNull.map(t => this.convert(t, depth + 1, path, branchAnnotation(this.checker, t, declaration)));
        const base = `z.union([${members.join(', ')}])`;
        return hasNull ? `${base}.nullable()` : base;
    }

    private isBooleanUnion(types: ts.Type[]): boolean {
        return types.length === 2
            && types.every(t => !!(t.flags & ts.TypeFlags.BooleanLiteral));
    }

    private isDateType(type: ts.Type): boolean {
        const symbol = type.getSymbol();
        return symbol?.getName() === 'Date' && !!symbol.declarations?.some(node => this.program.isSourceFileDefaultLibrary(node.getSourceFile()));
    }

    isArrayType(type: ts.Type): boolean {
        return this.checker.isArrayType(type);
    }

    getArrayElementType(type: ts.Type): ts.Type | null {
        return this.checker.getTypeArguments(type as ts.TypeReference)[0] ?? null;
    }
}
