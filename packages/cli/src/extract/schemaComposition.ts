import * as ts from 'typescript';
import { schemaReference, typeAnnotation } from './schemaReference';

export type SchemaComposition = ts.UnionTypeNode | ts.IntersectionTypeNode;

function resolveAnnotation(checker: ts.TypeChecker, node: ts.TypeNode | undefined, seen = new Set<ts.Node>()): ts.TypeNode | undefined {
    if (!node || seen.has(node)) return undefined;
    if (seen.size >= 256) throw new Error('Schema annotation resolution exceeds 256 aliases');
    seen.add(node);
    if (ts.isParenthesizedTypeNode(node)) return resolveAnnotation(checker, node.type, seen);
    if (!ts.isTypeReferenceNode(node)) return node;
    const symbol = checker.getSymbolAtLocation(node.typeName);
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    const declaration = target?.declarations?.find(ts.isTypeAliasDeclaration);
    return declaration ? resolveAnnotation(checker, declaration.type, seen) : node;
}

function hasSchema(checker: ts.TypeChecker, node: ts.TypeNode, seen = new Set<ts.Node>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (schemaReference(checker, checker.getTypeAtLocation(node), node)) return true;
    const resolved = resolveAnnotation(checker, node);
    return !!resolved && (ts.isUnionTypeNode(resolved) || ts.isIntersectionTypeNode(resolved))
        && resolved.types.some(part => hasSchema(checker, part, seen));
}

export function schemaComposition(checker: ts.TypeChecker, type: ts.Type, declaration?: ts.Node): SchemaComposition | undefined {
    const annotation = typeAnnotation(declaration ?? type.aliasSymbol?.declarations?.[0]);
    const node = resolveAnnotation(checker, annotation);
    if (!node || !(ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node))) return undefined;
    if (!node.types.some(part => hasSchema(checker, part))) return undefined;
    if (checker.getTypeAtLocation(node) !== type) throw new Error('Schema-derived generic composition requires an explicit derived Zod schema');
    return node;
}
