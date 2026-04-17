import * as ts from 'typescript';
import { resolve, dirname } from 'node:path';

/**
 * Creates a TypeScript program from a tsconfig path.
 * Parses the config and resolves compiler options, file names, etc.
 */
export function createProgramFromConfig(tsconfigPath: string): ts.Program {
    const absolutePath = resolve(tsconfigPath);
    const configFile = ts.readConfigFile(absolutePath, ts.sys.readFile);
    if (configFile.error) {
        throw new Error(`Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
    }

    const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        dirname(absolutePath)
    );

    if (parsed.errors.length > 0) {
        const msgs = parsed.errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        throw new Error(`tsconfig parse errors:\n${msgs.join('\n')}`);
    }

    return ts.createProgram(parsed.fileNames, parsed.options);
}

/**
 * Finds the exported aggregate variable and returns its resolved Type.
 */
export function resolveAggregateType(
    program: ts.Program,
    checker: ts.TypeChecker,
    entry: string,
    exportName: string
): ts.Type {
    const sourceFile = program.getSourceFile(resolve(entry));
    if (!sourceFile) {
        throw new Error(`Source file not found: ${entry}`);
    }

    const fileSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!fileSymbol) {
        throw new Error(`Could not get symbol for source file: ${entry}`);
    }

    const exports = checker.getExportsOfModule(fileSymbol);
    const exportSymbol = exports.find(s => s.getName() === exportName);
    if (!exportSymbol) {
        const available = exports.map(s => s.getName()).join(', ');
        throw new Error(
            `Export "${exportName}" not found in ${entry}. Available: ${available}`
        );
    }

    const resolvedSymbol = exportSymbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exportSymbol)
        : exportSymbol;

    const decl = resolvedSymbol.valueDeclaration || resolvedSymbol.declarations?.[0];
    if (!decl) {
        throw new Error(`No declaration found for export "${exportName}"`);
    }

    return checker.getTypeOfSymbolAtLocation(resolvedSymbol, decl);
}

/** Get a named property type from a parent type. */
function getPropertyType(
    checker: ts.TypeChecker,
    parentType: ts.Type,
    propName: string,
    node: ts.Node
): ts.Type | null {
    const prop = checker.getPropertyOfType(parentType, propName);
    if (!prop) return null;
    const decl = prop.valueDeclaration || prop.declarations?.[0];
    return decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : null;
}

/**
 * Extracts command payload types from the aggregate's `commandCreators` property.
 *
 * Path: aggType → commandCreators → each property → call signature →
 *       return type → payload property type.
 */
export function extractCommandPayloads(
    checker: ts.TypeChecker,
    aggType: ts.Type,
    node: ts.Node
): Map<string, ts.Type> {
    const result = new Map<string, ts.Type>();
    const creatorsType = getPropertyType(checker, aggType, 'commandCreators', node);
    if (!creatorsType) return result;

    for (const prop of checker.getPropertiesOfType(creatorsType)) {
        const decl = prop.valueDeclaration || prop.declarations?.[0];
        if (!decl) continue;

        const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
        const signatures = checker.getSignaturesOfType(propType, ts.SignatureKind.Call);
        if (signatures.length === 0) continue;

        const returnType = checker.getReturnTypeOfSignature(signatures[0]);
        const payloadType = getPropertyType(checker, returnType, 'payload', node);
        if (payloadType) {
            result.set(prop.getName(), payloadType);
        }
    }

    return result;
}

/**
 * Extracts event payload types from the aggregate's `pure.eventProjectors`.
 *
 * Path: aggType → pure → eventProjectors → each property → call signature →
 *       2nd parameter (Event<P>) → payload property type.
 */
export function extractEventPayloads(
    checker: ts.TypeChecker,
    aggType: ts.Type,
    node: ts.Node
): Map<string, ts.Type> {
    const result = new Map<string, ts.Type>();
    const pureType = getPropertyType(checker, aggType, 'pure', node);
    if (!pureType) return result;

    const projectorsType = getPropertyType(checker, pureType, 'eventProjectors', node);
    if (!projectorsType) return result;

    for (const prop of checker.getPropertiesOfType(projectorsType)) {
        const decl = prop.valueDeclaration || prop.declarations?.[0];
        if (!decl) continue;

        const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
        const signatures = checker.getSignaturesOfType(propType, ts.SignatureKind.Call);
        if (signatures.length === 0) continue;

        const params = signatures[0].getParameters();
        if (params.length < 2) continue;

        const eventParamDecl = params[1].valueDeclaration || params[1].declarations?.[0];
        if (!eventParamDecl) continue;

        const eventParamType = checker.getTypeOfSymbolAtLocation(params[1], eventParamDecl);
        const payloadType = getPropertyType(checker, eventParamType, 'payload', node);
        if (payloadType) {
            result.set(prop.getName(), payloadType);
        }
    }

    return result;
}

/**
 * Extracts the state type from the aggregate's `initialState` property.
 */
export function extractStateType(
    checker: ts.TypeChecker,
    aggType: ts.Type,
    node: ts.Node
): ts.Type | null {
    return getPropertyType(checker, aggType, 'initialState', node);
}
