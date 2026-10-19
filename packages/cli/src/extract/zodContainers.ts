import * as ts from 'typescript';
import { documentationComment, propertyName } from './schemaSource';
import { schemaReference } from './schemaReference';
import { recordAnnotations, resolvedAnnotation } from './schemaProvenance';
import { instantiatedProperty } from './instantiatedProperty';

export interface ZodTraversal {
    checker: ts.TypeChecker;
    program: ts.Program;
    readonly maxProvenanceDepth?: number;
    convert(type: ts.Type, depth: number, path: string, declaration?: ts.Node): string;
    fail(type: ts.Type, path: string, reason: string): never;
}

export function tupleSchema(type: ts.TypeReference, depth: number, path: string, context: ZodTraversal, declaration?: ts.Node): string {
    const elements = context.checker.getTypeArguments(type);
    const target = type.target as ts.TupleType;
    const flags = target.elementFlags;
    if (flags.some((flag, index) => !!(flag & ts.ElementFlags.Variadic) || (!!(flag & ts.ElementFlags.Rest) && index !== flags.length - 1))) {
        return context.fail(type, path, 'only resolved tuples with a trailing rest element are supported');
    }
    const node = tupleDeclaration(context.checker, declaration, context.maxProvenanceDepth)
        ?? tupleDeclaration(context.checker, type.aliasSymbol?.declarations?.[0], context.maxProvenanceDepth);
    const members = elements.map((element, index) => context.convert(element, depth + 1, `${path}[${index}]`, node?.elements[index])
        + ((flags[index]! & ts.ElementFlags.Optional) ? '.optional()' : ''));
    const rest = flags.at(-1)! & ts.ElementFlags.Rest ? members.pop() : undefined;
    return `z.tuple([${members.join(', ')}])${rest ? `.rest(${rest})` : ''}`;
}

export function objectSchema(type: ts.Type, depth: number, path: string, context: ZodTraversal, declaration?: ts.Node): string {
    const { checker, program } = context;
    if (type.getCallSignatures().length || type.getConstructSignatures().length) return context.fail(type, path, 'functions and constructors are unsupported');
    const symbol = type.getSymbol();
    if (symbol && symbol.name !== '__type' && symbol.declarations?.some(node => program.isSourceFileDefaultLibrary(node.getSourceFile()))) {
        return context.fail(type, path, `unsupported built-in ${symbol.name}; supply an existing Zod schema`);
    }
    const properties = checker.getPropertiesOfType(type);
    const indexes = checker.getIndexInfosOfType(type);
    if (indexes.some(index => index.keyType.flags !== ts.TypeFlags.String) || indexes.length > 1) {
        return context.fail(type, path, 'only string-index records are supported');
    }
    const fields = properties.map(property => propertySchema(property, type, depth, path, context));
    const object = `z.object({\n${fields.join(',\n')}${fields.length ? ',' : ''}\n})`;
    if (!indexes.length) return object;
    const index = indexes[0]!;
    const annotations = recordAnnotations(checker, declaration ?? type.aliasSymbol?.declarations?.[0], context.maxProvenanceDepth);
    const origin = schemaReference(checker, index.type, index.declaration, context.maxProvenanceDepth) ? index.declaration
        : annotations?.[1] ?? index.declaration;
    const value = context.convert(index.type, depth + 1, `${path}[string]`, origin);
    const key = annotations?.[0] ? context.convert(index.keyType, depth + 1, `${path}[key]`, annotations[0]) : 'z.string()';
    if (properties.length && key !== 'z.string()') return context.fail(type, path, 'constrained record keys with named properties require an explicit Zod schema');
    return properties.length ? `${object}.catchall(${value})` : `z.record(${key}, ${value})`;
}

function tupleDeclaration(checker: ts.TypeChecker, declaration?: ts.Node, maxProvenanceDepth?: number): ts.TupleTypeNode | undefined {
    const node = resolvedAnnotation(checker, declaration, maxProvenanceDepth);
    return node && ts.isTupleTypeNode(node) ? node : undefined;
}

function propertySchema(property: ts.Symbol, parent: ts.Type, depth: number, path: string, context: ZodTraversal): string {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const fieldPath = `${path}[${JSON.stringify(property.name)}]`;
    const instantiated = !declaration ? instantiatedProperty(context.checker, parent, property) : undefined;
    if ((!declaration && !instantiated) || property.escapedName !== ts.escapeLeadingUnderscores(property.name)) {
        return context.fail(parent, fieldPath, 'unresolved or symbol property');
    }
    const modifiers = declaration && ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : [];
    if (declaration && (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration))
        || modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) {
        return context.fail(parent, fieldPath, 'only public data properties are supported');
    }
    if (property.name === '__proto__') return context.fail(parent, fieldPath, 'Zod omits __proto__ object fields; supply an explicit schema');
    const type = instantiated ?? context.checker.getTypeOfSymbolAtLocation(property, declaration!);
    const schema = context.convert(type, depth + 1, fieldPath, declaration);
    const optional = property.flags & ts.SymbolFlags.Optional ? '.optional()' : '';
    return `${documentationComment(property, context.checker)}${propertyName(property.name)}: ${schema}${optional}`;
}
