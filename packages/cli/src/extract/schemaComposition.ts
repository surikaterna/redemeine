import * as ts from 'typescript';
import { schemaReference, typeAnnotation } from './schemaReference';
import { defaultMaxProvenanceDepth, searchProvenance } from './provenanceTraversal';
import { resolvedAnnotation } from './schemaProvenance';

export type SchemaComposition = ts.UnionTypeNode | ts.IntersectionTypeNode;

function hasSchema(checker: ts.TypeChecker, node: ts.TypeNode, maxProvenanceDepth: number): boolean {
    return searchProvenance([node], part => {
        if (schemaReference(checker, checker.getTypeAtLocation(part), part, maxProvenanceDepth)) return { value: true };
        const resolved = resolvedAnnotation(checker, part, maxProvenanceDepth);
        return { children: resolved && (ts.isUnionTypeNode(resolved) || ts.isIntersectionTypeNode(resolved)) ? resolved.types : [] };
    }, maxProvenanceDepth) ?? false;
}

export function schemaComposition(checker: ts.TypeChecker, type: ts.Type, declaration?: ts.Node,
    maxProvenanceDepth = defaultMaxProvenanceDepth): SchemaComposition | undefined {
    const annotation = typeAnnotation(declaration ?? type.aliasSymbol?.declarations?.[0]);
    const node = resolvedAnnotation(checker, annotation, maxProvenanceDepth);
    if (!node || !(ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node))) return undefined;
    if (!node.types.some(part => hasSchema(checker, part, maxProvenanceDepth))) return undefined;
    if (checker.getTypeAtLocation(node) !== type) throw new Error('Schema-derived generic composition requires an explicit derived Zod schema');
    return node;
}
