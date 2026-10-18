import * as ts from 'typescript';
import { schemaReference, typeAnnotation } from './schemaReference';

export function referenceTarget(checker: ts.TypeChecker, node: ts.TypeReferenceNode): ts.Symbol | undefined {
    const symbol = checker.getSymbolAtLocation(node.typeName);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
}

export function resolvedAnnotation(checker: ts.TypeChecker, declaration?: ts.Node, seen = new Set<ts.Node>()): ts.TypeNode | undefined {
    const node = typeAnnotation(declaration);
    if (!node || seen.has(node)) return undefined;
    if (seen.size >= 256) throw new Error('Schema provenance exceeds 256 aliases; supply an explicit Zod schema');
    seen.add(node);
    if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) return resolvedAnnotation(checker, node.type, seen);
    if (!ts.isTypeReferenceNode(node)) return node;
    const target = referenceTarget(checker, node);
    if (target?.declarations?.some(item => /[/\\]lib\.[^/\\]+\.d\.ts$/.test(item.getSourceFile().fileName))) return node;
    const alias = target?.declarations?.find(ts.isTypeAliasDeclaration);
    return alias ? resolvedAnnotation(checker, alias.type, seen) : node;
}

export function branchAnnotation(checker: ts.TypeChecker, type: ts.Type, declaration?: ts.Node): ts.Node | undefined {
    const node = resolvedAnnotation(checker, declaration);
    if (node && ts.isUnionTypeNode(node)) return node.types.find(part => checker.getTypeAtLocation(part) === type);
    return declaration;
}

export function arrayAnnotation(checker: ts.TypeChecker, declaration?: ts.Node): ts.Node | undefined {
    const node = resolvedAnnotation(checker, declaration);
    if (node && ts.isArrayTypeNode(node)) return node.elementType;
    return node && ts.isTypeReferenceNode(node) ? node.typeArguments?.[0] : undefined;
}

export function recordAnnotations(checker: ts.TypeChecker, declaration?: ts.Node): readonly ts.TypeNode[] | undefined {
    const node = resolvedAnnotation(checker, declaration);
    if (!node || !ts.isTypeReferenceNode(node)) return undefined;
    const target = referenceTarget(checker, node);
    if (target?.name !== 'Record' || !target.declarations?.some(item => /[/\\]lib\.[^/\\]+\.d\.ts$/.test(item.getSourceFile().fileName))) return undefined;
    return node.typeArguments;
}

/** Inspect authored syntax, never primitive identity or compiler-internal generic mappers. */
export function containsSchema(checker: ts.TypeChecker, declaration?: ts.Node, seen = new Set<ts.Node>()): boolean {
    const node = declaration && ts.isExpressionWithTypeArguments(declaration) ? declaration : typeAnnotation(declaration);
    if (!node || seen.has(node)) return false;
    if (seen.size >= 256) throw new Error('Schema provenance exceeds 256 nodes; supply an explicit Zod schema');
    seen.add(node);
    if (schemaReference(checker, checker.getTypeAtLocation(node), node)) return true;
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
        const symbol = checker.getSymbolAtLocation(ts.isTypeReferenceNode(node) ? node.typeName : node.expression);
        const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
        const declarations = target?.declarations ?? [];
        if (declarations.some(item => ts.isTypeAliasDeclaration(item) && containsSchema(checker, item, seen))) return true;
        if (declarations.some(item => ts.isInterfaceDeclaration(item) && item.members.some(member => containsSchema(checker, member, seen)))) return true;
        const contracts = declarations.filter((item): item is ts.TypeAliasDeclaration | ts.InterfaceDeclaration => ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item));
        if (contracts.some(item => item.typeParameters?.slice(node.typeArguments?.length ?? 0).some(parameter => containsSchema(checker, parameter.default, seen)))) return true;
        if (contracts.some(item => ts.isInterfaceDeclaration(item) && item.heritageClauses?.some(clause =>
            clause.types.some(base => containsSchema(checker, base, seen))))) return true;
    }
    return ts.forEachChild(node, child => containsSchema(checker, child, seen) ? true : undefined) ?? false;
}

export function assertSupportedGenerics(checker: ts.TypeChecker, type: ts.Type, path: string, declaration?: ts.Node): void {
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
        if (seen.has(node)) return;
        if (seen.size >= 256) throw new Error(`${path}: schema provenance exceeds 256 nodes; supply an explicit Zod schema`);
        seen.add(node);
        if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
            const symbol = checker.getSymbolAtLocation(ts.isTypeReferenceNode(node) ? node.typeName : node.expression);
            const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
            const declarations = target?.declarations?.filter(item => !/[/\\]zod[/\\]/.test(item.getSourceFile().fileName)) ?? [];
            const library = (item: ts.Declaration) => /[/\\]lib\.[^/\\]+\.d\.ts$/.test(item.getSourceFile().fileName);
            const container = ['Record', 'Array', 'ReadonlyArray'].includes(target?.name ?? '') && declarations.every(library);
            const defaults = declarations.flatMap(item => ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item)
                ? item.typeParameters?.slice(node.typeArguments?.length ?? 0).map(parameter => parameter.default).filter((value): value is ts.TypeNode => !!value) ?? [] : []);
            if (declarations.length && !container && [...node.typeArguments ?? [], ...defaults].some(argument => containsSchema(checker, argument))) {
                throw new Error(`${path}: schema-derived generic ${node.getText()} requires an explicit derived Zod schema`);
            }
            const authored = declarations.filter(item => !library(item));
            for (const alias of authored.filter(ts.isTypeAliasDeclaration)) visit(alias.type);
            for (const contract of authored.filter(ts.isInterfaceDeclaration)) ts.forEachChild(contract, visit);
        }
        ts.forEachChild(node, visit);
    };
    const root = typeAnnotation(declaration ?? type.aliasSymbol?.declarations?.[0]);
    if (root) visit(root);
}
