import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(process.env.TESTING_PACKED_ROOT || new URL('../', import.meta.url).pathname);
const privateNames = ['@redemeine/projection-runtime-core', '@redemeine/projection-runtime-store-inmemory'];

function importsOf(source) {
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) imports.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), 'No uninspectable dynamic module loader');
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

test('testing ships private implementation, not private dependency edges or declarations', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  for (const name of privateNames) {
    assert.ok(manifest.devDependencies[name]);
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) assert.ok(!manifest[field]?.[name]);
  }
  const imports = [];
  for (const file of await readdir(resolve(root, 'dist'))) {
    if (!/\.(js|[cm]?ts)$/.test(file)) continue;
    const text = await readFile(resolve(root, 'dist', file), 'utf8');
    imports.push(...importsOf(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)));
    assert.doesNotMatch(text, /(?:class|function)\s+(?:Contract|ContractError|MirageCore)\b/);
    assert.doesNotMatch(text, /Symbol\(['"]MirageCore['"]\)/);
  }
  for (const specifier of imports) {
    assert.ok(!specifier.includes('projection-runtime-'), specifier);
    assert.ok(!specifier.includes('/src/'), specifier);
  }
  for (const name of ['@redemeine/mirage', '@redemeine/saga', '@redemeine/projection', 'immer']) {
    assert.ok(imports.includes(name), `Public boundary must remain external: ${name}`);
  }
});
