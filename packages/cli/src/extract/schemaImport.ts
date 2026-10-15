import { dirname, relative, resolve } from 'node:path';
import * as ts from 'typescript';

export function existingSchemaImport(
    checker: ts.TypeChecker, program: ts.Program, query: ts.EntityName, outFile?: string, localName?: string
): { name: string; statement: string } {
    const symbol = checker.getSymbolAtLocation(query);
    if (!symbol) throw new Error('Cannot resolve inferred schema value');
    const target = unalias(checker, symbol);
    assertSchemaValue(checker, target);
    const name = localName ?? (ts.isIdentifier(query) ? query.text : query.right.text);
    const external = packageExport(checker, program, target);
    if (external) return { name, statement: importStatement(external.name, name, external.module) };
    const source = target.valueDeclaration?.getSourceFile();
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    const exported = moduleSymbol && valueExport(checker, moduleSymbol, target);
    if (!source || source.isDeclarationFile || /[/\\]node_modules[/\\]/.test(source.fileName) || !exported || !outFile) {
        throw new Error(`Cannot emit a portable import for inferred schema ${name}; export its value from a source module or package, or supply a types-first typeOverrides schema.`);
    }
    let path = relative(dirname(resolve(outFile)), resolve(source.fileName)).replace(/\\/g, '/').replace(/\.[cm]?tsx?$/, '');
    if (!path.startsWith('.')) path = './' + path;
    return { name, statement: importStatement(exported, name, path) };
}

function packageExport(checker: ts.TypeChecker, program: ts.Program, target: ts.Symbol) {
    const sourceFile = target.valueDeclaration?.getSourceFile();
    if (!sourceFile || !/[/\\]node_modules[/\\]/.test(sourceFile.fileName)) return null;
    for (const source of program.getSourceFiles()) {
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
            const module = statement.moduleSpecifier.text;
            if (module.startsWith('.') || module.startsWith('/') || /^[A-Za-z]:/.test(module)) continue;
            const symbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
            const name = symbol && valueExport(checker, symbol, target);
            if (name && publicModuleResolves(module, source.fileName)) return { module, name };
        }
    }
    return null;
}

function publicModuleResolves(module: string, containingFile: string): boolean {
    // Even Node10/path-mapped input projects must not authorize private package exports in generated imports.
    return !!ts.resolveModuleName(module, containingFile, {
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        resolvePackageJsonExports: true
    }, ts.sys).resolvedModule;
}

function assertSchemaValue(checker: ts.TypeChecker, target: ts.Symbol): void {
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    if (!declaration) throw new Error('Inferred schema has no value declaration');
    const type = checker.getTypeOfSymbolAtLocation(target, declaration);
    const parse = checker.getPropertyOfType(type, 'safeParse');
    const parseDeclaration = parse?.valueDeclaration ?? parse?.declarations?.[0];
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || !checker.getPropertyOfType(type, '_output')
        || !parse || !parseDeclaration || !checker.getTypeOfSymbolAtLocation(parse, parseDeclaration).getCallSignatures().length) {
        throw new Error(`Inferred schema ${target.name} is not a resolved Zod schema value`);
    }
}

function valueExport(checker: ts.TypeChecker, module: ts.Symbol, target: ts.Symbol): string | undefined {
    return checker.getExportsOfModule(module).find(symbol =>
        unalias(checker, symbol) === target && !symbol.declarations?.some(isTypeOnlyExport)
    )?.getName();
}

function isTypeOnlyExport(node: ts.Declaration): boolean {
    return ts.isExportSpecifier(node) && (node.isTypeOnly || (ts.isExportDeclaration(node.parent.parent) && node.parent.parent.isTypeOnly));
}

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function importStatement(exported: string, local: string, module: string): string {
    return `import { ${JSON.stringify(exported)} as ${local} } from ${JSON.stringify(module)};`;
}
