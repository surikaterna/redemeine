import * as ts from 'typescript';
import { resolve } from 'node:path';
import { typeAnnotation } from './schemaReference';
import { containsSchema, referenceTarget } from './schemaProvenance';
import { aggregateStateModel } from './aggregateStateModel';

export interface SchemaDeclarations {
    commands: Map<string, ts.Node>;
    events: Map<string, ts.Node>;
    state?: ts.Node;
    creatorState?: ts.Node;
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
        const declaration = (commands ? factoryCallback(checker, symbol) : undefined) ?? parameter(handler, 1);
        if (declaration) result.set(symbol.name, commands ? declaration : eventPayloadAnnotation(checker, declaration) ?? declaration);
    }
    return result;
}

function factoryCall(checker: ts.TypeChecker, node?: ts.Node, seen = new Set<ts.Node>()): ts.CallExpression | undefined {
    if (!node) return undefined;
    if (seen.has(node)) throw new Error('Command factory provenance cycle; supply an explicit schema-linked handler');
    if (seen.size >= 256) throw new Error('Command factory provenance exceeds 256 nodes; supply an explicit schema-linked handler');
    seen.add(node);
    if (ts.isCallExpression(node)) return node;
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) return factoryCall(checker, node.initializer, seen);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return factoryCall(checker, node.expression, seen);
    const symbol = ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node)
        : ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node) : undefined;
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    return factoryCall(checker, target?.valueDeclaration, seen);
}

function factoryCallback(checker: ts.TypeChecker, property: ts.Symbol): ts.Node | undefined {
    const call = factoryCall(checker, property.valueDeclaration);
    if (!call) return undefined;
    const factory = checker.getResolvedSignature(call)?.getDeclaration();
    if (factory && ts.isFunctionDeclaration(factory) && factory.body) {
        const returns = factory.body.statements.filter(ts.isReturnStatement);
        const expression = returns.length === 1 ? returns[0]?.expression : undefined;
        const field = expression && ts.isObjectLiteralExpression(expression)
            ? expression.properties.find(item => item.name?.getText() === 'handler') : undefined;
        const value = field && (ts.isShorthandPropertyAssignment(field) ? field.name : ts.isPropertyAssignment(field) ? field.initializer : undefined);
        const symbol = field && ts.isShorthandPropertyAssignment(field) ? checker.getShorthandAssignmentValueSymbol(field)
            : value && checker.getSymbolAtLocation(value);
        const index = factory.parameters.findIndex(item => checker.getSymbolAtLocation(item.name) === symbol);
        const argument = index >= 0 ? call.arguments[index] : undefined;
        if (argument) return parameter(checker.getTypeAtLocation(argument), 1);
    }
    const hasSchema = call.arguments.some(argument => containsSchema(checker, parameter(checker.getTypeAtLocation(argument), 1)));
    if (hasSchema) throw new Error(`${property.name}: schema-derived generic command factory requires an explicit schema-linked handler; cannot prove callback provenance`);
    return undefined;
}

/** Project a directly declared generic payload parameter by position, not equal compiler types. */
function eventPayloadAnnotation(checker: ts.TypeChecker, declaration: ts.Node): ts.TypeNode | undefined {
    const node = typeAnnotation(declaration);
    if (!node || !ts.isTypeReferenceNode(node)) return undefined;
    const target = referenceTarget(checker, node);
    const contract = target?.declarations?.find(ts.isInterfaceDeclaration);
    const payload = contract?.members.find(member => ts.isPropertySignature(member) && member.name.getText() === 'payload');
    if (!payload || !ts.isPropertySignature(payload) || !payload.type || !ts.isTypeReferenceNode(payload.type)) return undefined;
    const parameter = checker.getSymbolAtLocation(payload.type.typeName);
    const index = contract?.typeParameters?.findIndex(item => checker.getSymbolAtLocation(item.name) === parameter) ?? -1;
    return index >= 0 ? node.typeArguments?.[index] : undefined;
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
    return definitionOrigin(checker, target?.valueDeclaration ?? target?.declarations?.[0], `${entry}:${name}`);
}

function definitionOrigin(checker: ts.TypeChecker, node: ts.Declaration | undefined, path: string, seen = new Set<ts.Node>()): ts.Declaration | undefined {
    if (!node) return undefined;
    if (seen.has(node) || seen.size >= 256) throw new Error(`${path}: cyclic or excessive definition alias provenance; select the original definition`);
    seen.add(node);
    let expression = ts.isVariableDeclaration(node) ? node.initializer : undefined;
    while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression))) expression = expression.expression;
    if (!expression || (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression))) return node;
    const symbol = checker.getSymbolAtLocation(expression);
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    const declarations = target?.declarations;
    if (declarations && declarations.length > 1) throw new Error(`${path}: ambiguous definition alias provenance; select the original definition`);
    return definitionOrigin(checker, target?.valueDeclaration ?? declarations?.[0], path, seen);
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
    const annotation = stateAnnotation(program, entry, name);
    const model = aggregateStateModel(checker, aggregate, property(checker, aggregate, 'initialState') ?? null);
    if (annotation && model && checker.getTypeAtLocation(annotation) !== model && containsSchema(checker, annotation)) {
        throw new Error(`${name}.state: authored creator state does not cover the complete model; supply an explicit whole-model schema`);
    }
    const state = annotation && model === checker.getTypeAtLocation(annotation) ? annotation : undefined;
    const commands = handlers(checker, property(checker, pure, 'commandProcessors'), true);
    const creators = property(checker, aggregate, 'commandCreators');
    for (const key of creators?.getProperties() ?? []) {
        const declaration = parameter(property(checker, creators, key.name), 0);
        if (declaration && !commands.has(key.name)) commands.set(key.name, declaration);
    }
    for (const [key, declaration] of commandAnnotations(program, entry, name)) commands.set(key, declaration);
    return { commands,
        events: handlers(checker, property(checker, pure, 'eventProjectors'), false),
        ...(annotation ? { creatorState: annotation } : {}), ...(state ? { state } : {}) };
}

export function projectionSchemaDeclaration(program: ts.Program, definition: ts.Type, entry: string, name: string): ts.Node | undefined {
    return stateAnnotation(program, entry, name, 'createProjection')
        ?? property(program.getTypeChecker(), definition, 'initialState')?.getCallSignatures()[0]?.getDeclaration()?.type;
}
