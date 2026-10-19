import * as ts from 'typescript';
import type { SchemaPolicy } from './schemaConfig';
import { schemaReference } from './schemaReference';
import { schemaComposition } from './schemaComposition';
import { containsSchema } from './schemaProvenance';

export function requireStructuralJson(policy: SchemaPolicy): void {
    if (policy.mode === 'zod-first') throw new Error('zod-first requires linked Zod output; compiler-only JSON cannot execute authored schemas. Generate Zod/registry maps and use z.toJSONSchema on those values.');
}

/** Refuse lossy JSON extraction when the declaration graph contains an authored Zod schema. */
export function assertStructuralJson(checker: ts.TypeChecker, type: ts.Type, path: string, declaration?: ts.Node,
    maxDepth = 60, seen = new Set<ts.Type>(), depth = 0): void {
    if (containsSchema(checker, declaration ?? type.aliasSymbol?.declarations?.[0]) || schemaReference(checker, type, declaration) || schemaComposition(checker, type, declaration)) {
        throw new Error(`${path}: existing Zod schema requires linked Zod/registry output; compiler-only JSON would discard its constraints`);
    }
    if (seen.has(type)) return;
    if (depth > maxDepth) throw new Error(`${path}: type depth exceeds maxDepth (${maxDepth})`);
    seen.add(type);
    if (type.isUnionOrIntersection()) {
        for (const part of type.types) assertStructuralJson(checker, part, path, declaration, maxDepth, seen, depth + 1);
        return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
        for (const part of checker.getTypeArguments(type as ts.TypeReference)) assertStructuralJson(checker, part, `${path}[]`, declaration, maxDepth, seen, depth + 1);
        return;
    }
    if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length) return;
    for (const prop of type.getProperties()) {
        const node = prop.valueDeclaration ?? prop.declarations?.[0];
        if (node) assertStructuralJson(checker, checker.getTypeOfSymbolAtLocation(prop, node), `${path}.${prop.name}`, node, maxDepth, seen, depth + 1);
    }
    for (const index of checker.getIndexInfosOfType(type)) {
        assertStructuralJson(checker, index.type, `${path}[index]`, index.declaration, maxDepth, seen, depth + 1);
        assertStructuralJson(checker, index.type, `${path}[index]`, declaration ?? type.aliasSymbol?.declarations?.[0], maxDepth, seen, depth + 1);
    }
}
