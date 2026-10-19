import * as ts from 'typescript';
import { schemaReference, typeAnnotation } from './schemaReference';
import { defaultMaxProvenanceDepth, searchProvenance, syntaxChildren } from './provenanceTraversal';

export function referenceTarget(checker: ts.TypeChecker, node: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments): ts.Symbol | undefined {
    const symbol = checker.getSymbolAtLocation(ts.isTypeReferenceNode(node) ? node.typeName : node.expression);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
}

function library(item: ts.Declaration): boolean {
    return /[/\\]lib\.[^/\\]+\.d\.ts$/.test(item.getSourceFile().fileName);
}

export function resolvedAnnotation(checker: ts.TypeChecker, declaration?: ts.Node,
    maxProvenanceDepth = defaultMaxProvenanceDepth): ts.TypeNode | undefined {
    const root = typeAnnotation(declaration);
    return searchProvenance<ts.TypeNode>(root ? [root] : [], node => {
        if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) return { children: [node.type] };
        if (!ts.isTypeNode(node)) return {};
        if (!ts.isTypeReferenceNode(node)) return { value: node };
        const target = referenceTarget(checker, node);
        if (target?.declarations?.some(library)) return { value: node };
        const alias = target?.declarations?.find(ts.isTypeAliasDeclaration);
        return alias ? { children: [alias.type] } : { value: node };
    }, maxProvenanceDepth);
}

export function branchAnnotation(checker: ts.TypeChecker, type: ts.Type, declaration?: ts.Node, maxProvenanceDepth = defaultMaxProvenanceDepth): ts.Node | undefined {
    const node = resolvedAnnotation(checker, declaration, maxProvenanceDepth);
    if (node && ts.isUnionTypeNode(node)) return node.types.find(part => checker.getTypeAtLocation(part) === type);
    return declaration;
}

export function arrayAnnotation(checker: ts.TypeChecker, declaration?: ts.Node, maxProvenanceDepth = defaultMaxProvenanceDepth): ts.Node | undefined {
    const node = resolvedAnnotation(checker, declaration, maxProvenanceDepth);
    if (node && ts.isArrayTypeNode(node)) return node.elementType;
    return node && ts.isTypeReferenceNode(node) ? node.typeArguments?.[0] : undefined;
}

export function recordAnnotations(checker: ts.TypeChecker, declaration?: ts.Node, maxProvenanceDepth = defaultMaxProvenanceDepth): readonly ts.TypeNode[] | undefined {
    const node = resolvedAnnotation(checker, declaration, maxProvenanceDepth);
    if (!node || !ts.isTypeReferenceNode(node)) return undefined;
    const target = referenceTarget(checker, node);
    if (target?.name !== 'Record' || !target.declarations?.some(library)) return undefined;
    return node.typeArguments;
}

function referenceDeclarations(checker: ts.TypeChecker, node: ts.Node): readonly ts.Declaration[] {
    if (!ts.isTypeReferenceNode(node) && !ts.isExpressionWithTypeArguments(node)) return [];
    return referenceTarget(checker, node)?.declarations ?? [];
}

function defaults(node: ts.Node, declarations: readonly ts.Declaration[]): ts.TypeNode[] {
    const count = ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node) ? node.typeArguments?.length ?? 0 : 0;
    return declarations.flatMap(item => ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item)
        ? item.typeParameters?.slice(count).flatMap(parameter => parameter.default ? [parameter.default] : []) ?? [] : []);
}

function schemaNode(node?: ts.Node): ts.Node | undefined {
    return node && ts.isExpressionWithTypeArguments(node) ? node : typeAnnotation(node);
}

function schemaChildren(checker: ts.TypeChecker, node: ts.Node): ts.Node[] {
    const declarations = referenceDeclarations(checker, node);
    const children: ts.Node[] = [];
    for (const item of declarations) {
        if (ts.isTypeAliasDeclaration(item)) children.push(item.type);
        if (ts.isInterfaceDeclaration(item)) {
            children.push(...item.members);
            for (const clause of item.heritageClauses ?? []) children.push(...clause.types);
        }
    }
    children.push(...defaults(node, declarations), ...syntaxChildren(node));
    return children.map(schemaNode).filter((child): child is ts.Node => !!child);
}

/** Inspect authored syntax, never primitive identity or compiler-internal generic mappers. */
export function containsSchema(checker: ts.TypeChecker, declaration?: ts.Node,
    maxProvenanceDepth = defaultMaxProvenanceDepth): boolean {
    const root = schemaNode(declaration);
    return searchProvenance(root ? [root] : [], node => {
        if (schemaReference(checker, checker.getTypeAtLocation(node), node, maxProvenanceDepth)) return { value: true };
        return { children: schemaChildren(checker, node) };
    }, maxProvenanceDepth) ?? false;
}

export function assertSupportedGenerics(checker: ts.TypeChecker, type: ts.Type, path: string, declaration?: ts.Node,
    maxProvenanceDepth = defaultMaxProvenanceDepth): void {
    const root = typeAnnotation(declaration ?? type.aliasSymbol?.declarations?.[0]);
    searchProvenance(root ? [root] : [], node => {
        const children: ts.Node[] = [];
        if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
            const declarations = referenceDeclarations(checker, node).filter(item => !/[/\\]zod[/\\]/.test(item.getSourceFile().fileName));
            const target = referenceTarget(checker, node);
            const container = ['Record', 'Array', 'ReadonlyArray'].includes(target?.name ?? '') && declarations.every(library);
            const argumentsToCheck = [...node.typeArguments ?? [], ...defaults(node, declarations)];
            if (declarations.length && !container && argumentsToCheck.some(argument => containsSchema(checker, argument, maxProvenanceDepth))) {
                throw new Error(`${path}: schema-derived generic ${node.getText()} requires an explicit derived Zod schema`);
            }
            for (const item of declarations.filter(item => !library(item))) {
                if (ts.isTypeAliasDeclaration(item)) children.push(item.type);
                if (ts.isInterfaceDeclaration(item)) children.push(...syntaxChildren(item));
            }
        }
        return { children: [...children, ...syntaxChildren(node)] };
    }, maxProvenanceDepth, path);
}
