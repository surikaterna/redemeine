import * as ts from 'typescript';
import { existingSchemaImport } from './schemaImport';

/**
 * Converts TypeScript types to Zod schema source code strings.
 *
 * Handles deduplication of named types, z.infer detection for existing
 * schemas, and recursive structural conversion of object/union/array types.
 */
export class TypeToZodConverter {
    readonly knownSchemas = new Map<ts.Type, string>();
    readonly generatedShared = new Map<string, string>();
    readonly imports = new Set<string>();
    private readonly overrideSchemas = new Map<string, string>();
    private readonly bindings = new Set(['z', 'commandSchemas', 'eventSchemas', 'stateSchema']);

    constructor(
        private checker: ts.TypeChecker,
        private program: ts.Program,
        private dateHandling: 'string' | 'date' = 'string',
        private typeOverrides: Record<string, string> = {},
        private outFile?: string
    ) {}

    convert(type: ts.Type, depth = 0): string {
        if (depth > 10) return 'z.any()';

        const named = this.convertNamedType(type, depth);
        if (named !== null) return named;

        return this.convertStructural(type, depth);
    }

    /** Attempt dedup/z.infer resolution for alias-named types. */
    private convertNamedType(type: ts.Type, depth: number): string | null {
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

        const existing = this.resolveExistingSchema(type);
        if (existing) return existing;

        const zodCode = this.convertStructural(type, depth);
        // Only completed conversions are memoized; recursive visits retain the depth guard.
        const varName = this.allocateBinding(this.preferredName(typeName));
        this.generatedShared.set(varName, zodCode);
        this.knownSchemas.set(type, varName);
        return varName;
    }

    private preferredName(typeName: string): string {
        return typeName.charAt(0).toLowerCase() + typeName.slice(1) + 'Schema';
    }

    private allocateBinding(preferred: string): string {
        const sanitized = preferred.replace(/[^A-Za-z0-9_$]/g, '_');
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
    resolveExistingSchema(type: ts.Type): string | null {
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
    convertStructural(type: ts.Type, depth: number): string {
        if (depth > 10) return 'z.any()';

        const primitive = this.convertPrimitive(type);
        if (primitive) return primitive;

        const literal = this.convertLiteral(type);
        if (literal) return literal;

        if (type.isUnion()) return this.convertUnion(type, depth);

        if (this.isDateType(type)) {
            return this.dateHandling === 'date' ? 'z.date()' : 'z.string()';
        }

        if (this.isArrayType(type)) {
            const el = this.getArrayElementType(type);
            return el ? `z.array(${this.convert(el, depth + 1)})` : 'z.array(z.any())';
        }

        if (type.flags & ts.TypeFlags.Object) return this.convertObject(type, depth);

        return 'z.any()';
    }

    private convertPrimitive(type: ts.Type): string | null {
        const f = type.flags;
        if (f & ts.TypeFlags.String) return 'z.string()';
        if (f & ts.TypeFlags.Number) return 'z.number()';
        if (f & ts.TypeFlags.Boolean) return 'z.boolean()';
        if (f & ts.TypeFlags.Void) return 'z.void()';
        if (f & ts.TypeFlags.Undefined) return 'z.undefined()';
        if (f & ts.TypeFlags.Null) return 'z.null()';
        if (f & ts.TypeFlags.Any || f & ts.TypeFlags.Unknown) return 'z.any()';
        if (f & ts.TypeFlags.Never) return 'z.never()';
        return null;
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

    private convertUnion(type: ts.UnionType, depth: number): string {
        const filtered = type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
        const hasNull = filtered.some(t => t.flags & ts.TypeFlags.Null);
        const nonNull = filtered.filter(t => !(t.flags & ts.TypeFlags.Null));

        if (this.isBooleanUnion(nonNull)) {
            return hasNull ? 'z.boolean().nullable()' : 'z.boolean()';
        }

        if (nonNull.every(t => t.isStringLiteral())) {
            const vals = nonNull.map(t => JSON.stringify((t as ts.StringLiteralType).value));
            const base = `z.enum([${vals.join(', ')}])`;
            return hasNull ? `${base}.nullable()` : base;
        }

        if (nonNull.length === 1 && nonNull[0]) {
            const base = this.convert(nonNull[0], depth + 1);
            return hasNull ? `${base}.nullable()` : base;
        }

        const members = nonNull.map(t => this.convert(t, depth + 1));
        const base = `z.union([${members.join(', ')}])`;
        return hasNull ? `${base}.nullable()` : base;
    }

    private isBooleanUnion(types: ts.Type[]): boolean {
        return types.length === 2
            && types.every(t => !!(t.flags & ts.TypeFlags.BooleanLiteral));
    }

    private convertObject(type: ts.Type, depth: number): string {
        const indexType = this.checker.getIndexTypeOfType(type, ts.IndexKind.String);
        if (indexType) {
            return `z.record(z.string(), ${this.convert(indexType, depth + 1)})`;
        }

        const properties = this.checker.getPropertiesOfType(type);
        if (properties.length === 0) return 'z.object({})';

        const entries: string[] = [];
        for (const prop of properties) {
            if (prop.name.startsWith('_')) continue;
            const entry = this.convertProperty(prop, depth);
            if (entry) entries.push(entry);
        }
        return `z.object({\n${entries.join(',\n')},\n})`;
    }

    private convertProperty(prop: ts.Symbol, depth: number): string | null {
        const decl = prop.valueDeclaration || prop.declarations?.[0];
        if (!decl) return null;

        const propType = this.checker.getTypeOfSymbolAtLocation(prop, decl);
        const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;

        let effectiveType = propType;
        if (isOptional && propType.isUnion()) {
            const nonUndef = propType.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
            if (nonUndef.length === 1 && nonUndef[0]) {
                effectiveType = nonUndef[0];
            } else if (nonUndef.length > 1) {
                // Remain as the original union but filter undefined at conversion
                effectiveType = propType;
            }
        }

        let zodCode = this.convert(effectiveType, depth + 1);
        if (isOptional) zodCode += '.optional()';
        return `  [${JSON.stringify(prop.name)}]: ${zodCode}`;
    }

    private isDateType(type: ts.Type): boolean {
        const symbol = type.getSymbol();
        return symbol?.getName() === 'Date';
    }

    isArrayType(type: ts.Type): boolean {
        if (!(type.flags & ts.TypeFlags.Object)) return false;
        const objType = type as ts.ObjectType;
        if (!(objType.objectFlags & ts.ObjectFlags.Reference)) return false;
        const symbol = type.getSymbol();
        return symbol?.getName() === 'Array';
    }

    getArrayElementType(type: ts.Type): ts.Type | null {
        const typeRef = type as ts.TypeReference;
        return typeRef.typeArguments?.[0] ?? null;
    }
}
