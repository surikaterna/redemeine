import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

const sourceRoot = join(__dirname, '../src');
const workspaceAllowed = ['@redemeine/projection-runtime-core', '@redemeine/projection-runtime-store-mongodb',
  '@redemeine/projection-worker-core', '@redemeine/projection-transport'];
const allowed = new Set([...workspaceAllowed, 'mongodb', 'amqplib']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

test('owned source imports public .2 boundaries only, no test/legacy/custom-loader dependencies', () => {
  for (const path of sourceFiles(sourceRoot)) {
    const content = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const specifier = node.moduleSpecifier.text;
      expect(specifier).not.toMatch(/\/test\b|projection-runtime\/|tapeworm_dispatcher|file:|git:/);
      expect(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../') || allowed.has(specifier)).toBe(true);
      if (specifier.startsWith('../')) expect(relative(sourceRoot, join(path, '..', specifier))).not.toMatch(/^\.\./);
    }
    if (!path.endsWith('/main.ts') && !path.endsWith('/workerMain.ts')) expect(content).not.toMatch(/process\.(env|argv|exit|on|stdout|stderr)/);
    if (path.endsWith('/definitionBundle.ts')) expect(content.match(/\bimport\s*\(/g)).toHaveLength(1);
    else expect(content).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  }
});

test('all owned production source obeys file/function/type/export principles', () => {
  for (const path of sourceFiles(sourceRoot)) {
    const content = readFileSync(path, 'utf8');
    expect(content.split('\n').length).toBeLessThanOrEqual(350);
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      expect(node.kind).not.toBe(ts.SyntaxKind.AnyKeyword);
      expect(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)).toBe(false);
      expect(ts.isExportAssignment(node)).toBe(false);
      if (ts.isFunctionLike(node)) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
        expect(end - start + 1).toBeLessThan(50);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
});

test('manifest is private, uses existing workspace dependencies and has no SDK or custom application loading', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  expect(manifest.private).toBe(true);
  expect(Object.keys(manifest.dependencies).sort()).toEqual([...allowed].sort());
  for (const name of workspaceAllowed) expect(manifest.dependencies[name]).toBe('workspace:*');
  expect(manifest.dependencies.mongodb).toBe('6.18.0');
  expect(manifest.dependencies.amqplib).toBe('2.0.1');
  expect(manifest.exports).toBeUndefined();
  expect(manifest.bin).toEqual({ 'projection-reference': './dist/main.js', 'projection-worker': './dist-worker/main.js' });
});
