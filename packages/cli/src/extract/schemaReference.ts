import * as ts from 'typescript';
import { defaultMaxProvenanceDepth, searchProvenance } from './provenanceTraversal';

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
export function schemaReference(checker: ts.TypeChecker, type: ts.Type, declaration?: ts.Node,
    maxProvenanceDepth = defaultMaxProvenanceDepth): ts.EntityName | undefined {
    const annotation = typeAnnotation(declaration);
    const roots = (annotation ? [annotation] : (type.aliasSymbol?.declarations ?? []).map(typeAnnotation)).filter((node): node is ts.TypeNode => !!node);
    return searchProvenance<ts.EntityName>(roots, node => {
        if (ts.isTypeReferenceNode(node)) {
            const symbol = checker.getSymbolAtLocation(node.typeName);
            const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
            const argument = node.typeArguments?.[0];
            if (target && ['infer', 'output', 'input'].includes(target.name) && argument && ts.isTypeQueryNode(argument)
                && target.declarations?.some(item => /[/\\]zod[/\\]/.test(item.getSourceFile().fileName))
                && checker.getTypeAtLocation(node) === type) return { value: argument.exprName };
            return { children: target?.declarations?.filter(ts.isTypeAliasDeclaration).map(alias => alias.type) ?? [] };
        }
        if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node) || ts.isOptionalTypeNode(node)
            || ts.isRestTypeNode(node) || ts.isNamedTupleMember(node)) return { children: [node.type] };
        if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
            // A constituent schema is not the schema of the complete composition,
            // even when TypeScript normalizes both to the same primitive identity.
            if (checker.getTypeAtLocation(node) === type) return {};
            return { children: node.types };
        }
        return {};
    }, maxProvenanceDepth, 'Schema reference');
}
