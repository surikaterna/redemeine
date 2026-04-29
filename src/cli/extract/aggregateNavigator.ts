import * as ts from 'typescript';
import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Creates a TypeScript program from a tsconfig path.
 * Parses the config and resolves compiler options, file names, etc.
 * Uses a custom host that falls back to source resolution for
 * unbuilt workspace packages.
 */
export function createProgramFromConfig(tsconfigPath: string): ts.Program {
    const absolutePath = resolve(tsconfigPath);
    const configFile = ts.readConfigFile(absolutePath, ts.sys.readFile);
    if (configFile.error) {
        throw new Error(`Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
    }

    const basePath = dirname(absolutePath);
    const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        basePath
    );

    if (parsed.errors.length > 0) {
        const msgs = parsed.errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        throw new Error(`tsconfig parse errors:\n${msgs.join('\n')}`);
    }

    const host = ts.createCompilerHost(parsed.options);

    host.resolveModuleNames = (
        moduleNames: string[],
        containingFile: string,
        _reusedNames: string[] | undefined,
        redirectedReference: ts.ResolvedProjectReference | undefined,
        compilerOptions: ts.CompilerOptions
    ): (ts.ResolvedModule | undefined)[] => {
        return moduleNames.map(moduleName => {
            const result = ts.resolveModuleName(moduleName, containingFile, compilerOptions, host);
            if (result.resolvedModule) return result.resolvedModule;

            return resolveFromPackageSource(moduleName, basePath);
        });
    };

    return ts.createProgram(parsed.fileNames, parsed.options, host);
}

/**
 * Fallback resolution: when standard resolution fails, look for source
 * entry points in the package directory. Common in monorepos where
 * workspace packages have no built output.
 */
export function resolveFromPackageSource(
    moduleName: string,
    basePath: string
): ts.ResolvedModule | undefined {
    if (moduleName.startsWith('.') || moduleName.startsWith('/')) return undefined;

    let searchDir = basePath;
    while (true) {
        const candidate = join(searchDir, 'node_modules', ...moduleName.split('/'));
        if (existsSync(candidate)) {
            const resolved = trySourceEntries(candidate);
            if (resolved) return resolved;
        }

        const parent = dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
    }

    return undefined;
}

/** Build candidate source paths and return the first that exists. */
function trySourceEntries(packageDir: string): ts.ResolvedModule | undefined {
    const entries: string[] = [];

    const pkgJsonPath = join(packageDir, 'package.json');
    if (existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
            if (pkg.types) {
                entries.push(join(packageDir, pkg.types.replace(/\.d\.ts$|\.js$/, '.ts')));
            }
            if (pkg.main) {
                entries.push(join(packageDir, pkg.main.replace(/\.js$/, '.ts')));
            }
        } catch { /* ignore parse errors */ }
    }

    entries.push(
        join(packageDir, 'src', 'index.ts'),
        join(packageDir, 'src', 'index.d.ts'),
        join(packageDir, 'index.ts'),
        join(packageDir, 'index.d.ts'),
    );

    for (const entry of entries) {
        if (existsSync(entry)) {
            return {
                resolvedFileName: entry,
                isExternalLibraryImport: true,
                extension: entry.endsWith('.d.ts') ? ts.Extension.Dts : ts.Extension.Ts,
            };
        }
    }

    return undefined;
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
