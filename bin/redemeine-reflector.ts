import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

function analyzeReflector(entryFile: string) {
    const program = ts.createProgram([entryFile], {
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeJs
    });
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(entryFile);

    const apiSurface: any = {
        interfaces: [],
        types: [],
        builders: {},
        namingConventions: []
    };

    if (!sourceFile) {
        throw new Error(`Could not find source file: ${entryFile}`);
    }

    function visit(node: ts.Node) {
        if (!isNodeExported(node)) {
            return;
        }

        if (ts.isInterfaceDeclaration(node)) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol) {
                apiSurface.interfaces.push({
                    name: symbol.getName(),
                    hasDoc: ts.displayPartsToString(symbol.getDocumentationComment(checker)).length > 0
                });
            }
        } else if (ts.isTypeAliasDeclaration(node)) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol) {
                apiSurface.types.push({
                    name: symbol.getName(),
                    hasDoc: ts.displayPartsToString(symbol.getDocumentationComment(checker)).length > 0
                });
            }
        }
    }

    ts.forEachChild(sourceFile, visit);

    function isNodeExported(node: ts.Node): boolean {
        return (
            (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
            (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
        );
    }

    return apiSurface;
}

const args = process.argv.slice(2);
const isJson = args.includes('--json');
const isLlmsCtx = args.includes('--generate-llms-ctx');

const entryFile = path.resolve(__dirname, '../src/redemeine.ts'); // Using redemeine.ts as entry point

const apiData = analyzeReflector(entryFile);

if (isJson) {
    console.log(JSON.stringify(apiData));
} else if (isLlmsCtx) {
    const llmsCtx = `
# Redemeine LLM Context

## How to use the Builder
The AggregateBuilder allows you to compose your domain model.

## How Naming works (Targeted Naming patterns)
Redemeine uses path-aware routing for commands and events.

## How Selectors are injected
Selectors are pure functions that derive state.
    `.trim();
    console.log(llmsCtx);
} else {
    console.log('Run with --json or --generate-llms-ctx');
}
