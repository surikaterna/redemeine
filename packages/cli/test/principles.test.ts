import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test.each(sourceFiles(join(__dirname, '../src')))('CLI principles: %s', path => {
  const text = readFileSync(path, 'utf8');
  expect(text.split(/\r?\n/).length).toBeLessThanOrEqual(350);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node, depth = 0): void {
    expect(node.kind).not.toBe(ts.SyntaxKind.AnyKeyword);
    if (ts.canHaveModifiers(node)) {
      expect(ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)).not.toBe(true);
    }
    expect(ts.isExportAssignment(node) && !node.isExportEquals).toBe(false);
    if (ts.isFunctionLike(node)) {
      depth = 0;
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const end = source.getLineAndCharacterOfPosition(node.end).line;
      expect(end - start + 1).toBeLessThan(50);
    }
    if (ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isSwitchStatement(node) || ts.isTryStatement(node)) {
      depth += 1;
      expect(depth).toBeLessThanOrEqual(3);
    }
    ts.forEachChild(node, child => visit(child, depth));
  }
  visit(source);
});
