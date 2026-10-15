import * as ts from 'typescript';

export function typeAnnotation(node?: ts.Node): ts.TypeNode | undefined {
    if (!node) return undefined;
    if (ts.isTypeNode(node)) return node;
    if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && node.initializer
        && (ts.isAsExpression(node.initializer) || ts.isTypeAssertionExpression(node.initializer))) {
        return ts.isVariableDeclaration(node) && node.type ? node.type : node.initializer.type;
    }
    if (ts.isTypeAliasDeclaration(node) || ts.isParameter(node) || ts.isPropertySignature(node)
        || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node) || ts.isIndexSignatureDeclaration(node)) return node.type;
    return undefined;
}

/** Follow the actual annotation's aliases, not globally equal primitive types or guessed schema names. */
export function schemaReference(checker: ts.TypeChecker, type: ts.Type, declaration?: ts.Node): ts.EntityName | undefined {
    const annotation = typeAnnotation(declaration);
    const roots = (annotation ? [annotation] : (type.aliasSymbol?.declarations ?? []).map(typeAnnotation)).filter((node): node is ts.TypeNode => !!node);
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node): ts.EntityName | undefined => {
        if (seen.has(node)) return undefined;
        if (seen.size >= 256) throw new Error('Schema reference resolution exceeds 256 nodes; supply a direct schema-derived type');
        seen.add(node);
        if (ts.isTypeReferenceNode(node)) {
            const symbol = checker.getSymbolAtLocation(node.typeName);
            const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
            const argument = node.typeArguments?.[0];
            if (target && ['infer', 'output', 'input'].includes(target.name) && argument && ts.isTypeQueryNode(argument)
                && target.declarations?.some(item => /[/\\]zod[/\\]/.test(item.getSourceFile().fileName))
                && checker.getTypeAtLocation(node) === type) return argument.exprName;
            for (const alias of target?.declarations ?? []) {
                if (!ts.isTypeAliasDeclaration(alias)) continue;
                const found = visit(alias.type);
                if (found) return found;
            }
        }
        if (ts.isTypeReferenceNode(node)) {
            for (const argument of node.typeArguments ?? []) {
                const found = visit(argument);
                if (found) return found;
            }
        }
        if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node) || ts.isOptionalTypeNode(node)
            || ts.isRestTypeNode(node) || ts.isNamedTupleMember(node)) return visit(node.type);
        if (ts.isArrayTypeNode(node)) return visit(node.elementType);
        if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
            // A constituent schema is not the schema of the complete composition,
            // even when TypeScript normalizes both to the same primitive identity.
            if (checker.getTypeAtLocation(node) === type) return undefined;
            for (const part of node.types) {
                const found = visit(part);
                if (found) return found;
            }
        }
        return undefined;
    };
    for (const root of roots) {
        const found = visit(root);
        if (found) return found;
    }
    return undefined;
}
