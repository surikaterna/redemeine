import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

/**
 * HELPER: Loads static markdown fragments from the filesystem to 
 * supplement the auto-generated reflection data.
 */
function getStaticContext(fileName: string): string {
    const filePath = path.resolve(__dirname, '../docs/ai', fileName);
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8').trim();
    }
    return ``;
}

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
        functions: [],
        builders: {},
        namingConventions: []
    };

    if (!sourceFile) {
        throw new Error(`Could not find source file: ${entryFile}`);
    }

    const visitedFiles = new Set<string>();

    function visitSourceFile(sf: ts.SourceFile) {
        if (visitedFiles.has(sf.fileName)) return;
        visitedFiles.add(sf.fileName);

        ts.forEachChild(sf, node => {
            if (ts.isExportDeclaration(node)) {
                if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                    const resolved = ts.resolveModuleName(
                        node.moduleSpecifier.text,
                        sf.fileName,
                        program.getCompilerOptions(),
                        ts.sys
                    );
                    if (resolved.resolvedModule && !resolved.resolvedModule.isExternalLibraryImport) {
                        const nextFile = program.getSourceFile(resolved.resolvedModule.resolvedFileName);
                        if (nextFile) visitSourceFile(nextFile);
                    }
                }
            } else if (isNodeExported(node)) {
                visitExportedNode(node);
            }
        });
    }

    function visitExportedNode(node: ts.Node) {
        if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
            const identifier = node.name;
            if (!identifier) return;
            const symbol = checker.getSymbolAtLocation(identifier);
            if (!symbol) return;

            const name = symbol.getName();
            const summary = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
            const hasDoc = summary.length > 0;

            if (name.includes('Builder') || name === 'NamingStrategy') {
                const methods: any[] = [];
                if (symbol.members) {
                    symbol.members.forEach((memberInfo, memberName) => {
                        const memberDecl = memberInfo.valueDeclaration || memberInfo.declarations?.[0];
                        if (!memberDecl) return;

                        const mSummary = ts.displayPartsToString(memberInfo.getDocumentationComment(checker)).trim();
                        const mHasDoc = mSummary.length > 0;
                        let isChained = false;

                        if (ts.isMethodSignature(memberDecl) || ts.isMethodDeclaration(memberDecl) ||
                            (ts.isPropertySignature(memberDecl) && memberDecl.type && ts.isFunctionTypeNode(memberDecl.type))) {

                            const type = checker.getTypeOfSymbolAtLocation(memberInfo, memberDecl);
                            const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
                            if (signatures.length > 0) {
                                const retType = checker.getReturnTypeOfSignature(signatures[0]);
                                const retStr = checker.typeToString(retType);
                                if (retStr.includes('Builder') || retStr.includes('this')) {
                                    isChained = true;
                                }
                            }
                            methods.push({ name: memberName.toString(), hasDoc: mHasDoc, summary: mSummary, isChained });
                        }
                    });
                }
                apiSurface.builders[name] = { name, hasDoc, summary, methods };

                if (name === 'NamingStrategy') {
                    apiSurface.namingConventions = methods.map(m => m.name);
                }
            } else {
                apiSurface.interfaces.push({ name, hasDoc, summary });
            }
        } else if (ts.isTypeAliasDeclaration(node)) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol) {
                const summary = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
                const hasDoc = summary.length > 0;
                apiSurface.types.push({ name: symbol.getName(), hasDoc, summary });
            }
        } else if (ts.isVariableStatement(node)) {
            node.declarationList.declarations.forEach(decl => {
                if (decl.name && ts.isIdentifier(decl.name)) {
                    const symbol = checker.getSymbolAtLocation(decl.name);
                    if (symbol) {
                        const summary = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
                        const hasDoc = summary.length > 0;
                        apiSurface.functions.push({ name: symbol.getName(), hasDoc, summary });
                    }
                }
            });
        }
    }

    function isNodeExported(node: ts.Node): boolean {
        return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
    }

    visitSourceFile(sourceFile);
    return apiSurface;
}

// CLI Execution
const args = process.argv.slice(2);
const isJson = args.includes('--json');
const isLlmsCtx = args.includes('--generate-llms-ctx');
const isVerify = args.includes('--verify-tsdoc');

const entryFile = path.resolve(__dirname, '../src/redemeine.ts');
const apiData = analyzeReflector(entryFile);

if (isVerify) {
    // ... existing verify logic ...
} else if (isJson) {
    console.log(JSON.stringify(apiData));
} else if (isLlmsCtx) {
    // --- START IMPROVED LLMS-CTX GENERATION ---
    let md = `# Redemeine LLM Context\n\n`;

    // Inject "Mental Model" and "Rules" from /docs/ai
    md += `## 💡 Mental Model\n${getStaticContext('mental-model.md')}\n\n`;
    md += `## ⚠️ Critical Implementation Rules\n${getStaticContext('rules.md')}\n\n`;
    md += `## 🚀 Example Composition\n${getStaticContext('examples.md')}\n\n`;

    md += `## 🛠️ API Reference (Builders)\n\n`;

    Object.values(apiData.builders).forEach((builder: any) => {
        md += `### \`${builder.name}\`\n`;
        md += `_${builder.summary || 'Core library class.'}_\n\n`;
        md += `**Methods:**\n`;
        builder.methods.forEach((m: any) => {
            const chain = m.isChained ? ' (Returns `this`)' : '';
            let summary = m.summary ? ` - ${m.summary}` : '';

            // Contextual badges for AI agents
            if (m.name === 'events') summary += ' **[IMMER MUTATION ALLOWED]**';
            if (m.name === 'commands') summary += ' **[READONLY LOGIC LAYER]**';

            md += `- \`.${m.name}()\`${chain}${summary}\n`;
        });
        md += `\n`;
    });

    md += `## 🎯 Targeted Naming Patterns\n`;
    md += `Methods map to paths using these conventions:\n`;
    apiData.namingConventions.forEach((c: any) => {
        md += `- \`${c}\` (Auto-formatted path component)\n`;
    });
    md += `\n`;

    md += `--- \n`;
    md += `**Metadata:** ${apiData.interfaces.length} Interfaces, ${apiData.types.length} Types, ${apiData.functions.length} Public Functions.\n`;

    console.log(md.trim());
} else {
    console.log('Run with --json, --generate-llms-ctx, or --verify-tsdoc');
}