import * as ts from 'typescript';

export function propertyName(name: string): string {
    if (name === '__proto__') return `[${JSON.stringify(name)}]`;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export function commentText(text: string): string {
    return text.replace(/\*\//g, '* /').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

export function documentationComment(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string {
    if (!symbol) return '';
    const text = commentText(ts.displayPartsToString(symbol.getDocumentationComment(checker)));
    if (!text) return '';
    const summary = text.length > 400 ? `${text.slice(0, 397)}...` : text;
    return `/** ${summary} */\n`;
}

export function formatSchemaSource(source: string): string {
    const file = ts.createSourceFile('schemas.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    return file.statements.map((node, index) => {
        const next = file.statements[index + 1];
        const separator = ts.isImportDeclaration(node) && next && ts.isImportDeclaration(next) ? '\n' : '\n\n';
        return printer.printNode(ts.EmitHint.Unspecified, node, file) + separator;
    }).join('').trimEnd() + '\n';
}
