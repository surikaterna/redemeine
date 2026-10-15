import * as ts from 'typescript';
import { resolve } from 'node:path';
import { typeAnnotation } from './schemaReference';

export interface SchemaDeclarations {
    commands: Map<string, ts.Node>;
    events: Map<string, ts.Node>;
    state?: ts.Node;
}

function property(checker: ts.TypeChecker, type: ts.Type | undefined, name: string): ts.Type | undefined {
    const symbol = type && checker.getPropertyOfType(type, name);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return symbol && declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : undefined;
}

function parameter(type: ts.Type | undefined, index: number): ts.Node | undefined {
    const value = type?.getCallSignatures()[0]?.getParameters()[index];
    return value?.valueDeclaration ?? value?.declarations?.[0];
}

function handlers(checker: ts.TypeChecker, container: ts.Type | undefined, commands: boolean): Map<string, ts.Node> {
    const result = new Map<string, ts.Node>();
    for (const symbol of container?.getProperties() ?? []) {
        const type = property(checker, container, symbol.name);
        const handler = commands ? property(checker, type, 'handler') ?? type : type;
        const declaration = parameter(handler, 1);
        if (declaration) result.set(symbol.name, declaration);
    }
    return result;
}

function commandAnnotations(program: ts.Program, entry: string, name: string): Map<string, ts.Node> {
    const node = definitionNode(program, entry, name);
    const checker = program.getTypeChecker();
    const result = new Map<string, ts.Node>();
    const visit = (current: ts.Expression): void => {
        if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return;
        visit(current.expression.expression);
        if (current.expression.name.text !== 'commands' || !current.arguments[0]) return;
        const factory = checker.getTypeAtLocation(current.arguments[0]).getCallSignatures()[0];
        if (!factory) return;
        for (const [key, declaration] of handlers(checker, checker.getReturnTypeOfSignature(factory), true)) result.set(key, declaration);
    };
    if (node && ts.isVariableDeclaration(node) && node.initializer) visit(node.initializer);
    return result;
}

function definitionNode(program: ts.Program, entry: string, name: string): ts.Declaration | undefined {
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(resolve(entry));
    const symbol = source && checker.getSymbolAtLocation(source);
    const exported = symbol && checker.getExportsOfModule(symbol).find(item => item.name === name);
    const target = exported && (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported);
    return target?.valueDeclaration ?? target?.declarations?.[0];
}

function expressionAnnotation(checker: ts.TypeChecker, expression?: ts.Expression): ts.TypeNode | undefined {
    if (!expression) return undefined;
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return expression.type;
    if (ts.isParenthesizedExpression(expression)) return expressionAnnotation(checker, expression.expression);
    if (ts.isArrowFunction(expression) && !ts.isBlock(expression.body)) {
        return expression.type ?? expressionAnnotation(checker, expression.body);
    }
    const symbol = checker.getSymbolAtLocation(expression);
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    return typeAnnotation(target?.valueDeclaration ?? target?.declarations?.[0]);
}

function stateAnnotation(program: ts.Program, entry: string, name: string, factoryName = 'createAggregate'): ts.Node | undefined {
    const node = definitionNode(program, entry, name);
    const checker = program.getTypeChecker();
    const visit = (current: ts.Node): ts.Node | undefined => {
        if (ts.isCallExpression(current)) {
            const declaration = checker.getResolvedSignature(current)?.getDeclaration();
            if (declaration && ts.isFunctionDeclaration(declaration) && declaration.name?.text === factoryName) {
                const state = current.arguments[1];
                if (factoryName === 'createProjection' && state) return checker.getTypeAtLocation(state).getCallSignatures()[0]?.getDeclaration()?.type ?? expressionAnnotation(checker, state);
                return current.typeArguments?.[0] ?? expressionAnnotation(checker, state);
            }
        }
        return ts.forEachChild(current, visit);
    };
    return node && visit(node);
}

export function aggregateSchemaDeclarations(program: ts.Program, aggregate: ts.Type, entry: string, name: string): SchemaDeclarations {
    const checker = program.getTypeChecker();
    const pure = property(checker, aggregate, 'pure');
    const stateProperty = checker.getPropertyOfType(aggregate, 'initialState');
    const state = stateAnnotation(program, entry, name) ?? stateProperty?.valueDeclaration ?? stateProperty?.declarations?.[0];
    const commands = handlers(checker, property(checker, pure, 'commandProcessors'), true);
    const creators = property(checker, aggregate, 'commandCreators');
    for (const key of creators?.getProperties() ?? []) {
        const declaration = parameter(property(checker, creators, key.name), 0);
        if (declaration && !commands.has(key.name)) commands.set(key.name, declaration);
    }
    for (const [key, declaration] of commandAnnotations(program, entry, name)) commands.set(key, declaration);
    return { commands,
        events: handlers(checker, property(checker, pure, 'eventProjectors'), false), ...(state ? { state } : {}) };
}

export function projectionSchemaDeclaration(program: ts.Program, definition: ts.Type, entry: string, name: string): ts.Node | undefined {
    return stateAnnotation(program, entry, name, 'createProjection')
        ?? property(program.getTypeChecker(), definition, 'initialState')?.getCallSignatures()[0]?.getDeclaration()?.type;
}
