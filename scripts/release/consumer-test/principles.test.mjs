import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

test('consumer production modules stay <=350 lines, functions <50 lines and control nesting <=3', async () => {
  const root = new URL('../', import.meta.url);
  const files = (await readdir(root)).filter((name) => /^consumer.*\.mjs$/.test(name));
  files.push('quarantine.mjs', ...(await readdir(new URL('../consumer-runtime/', import.meta.url))).map((name) => `consumer-runtime/${name}`));
  for (const path of files) {
    const text = await readFile(new URL(path, root), 'utf8');
    assert(text.split('\n').length - 1 <= 350, `${path}: file exceeds 350 lines`);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node, depth = 0) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        depth = 0;
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
        assert(end - start + 1 < 50, `${path}:${start + 1}: function has ${end - start + 1} lines`);
      }
      if (
        ts.isIfStatement(node) ||
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isTryStatement(node) ||
        ts.isSwitchStatement(node)
      )
        depth++;
      assert(depth <= 3, `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: control nesting ${depth}`);
      ts.forEachChild(node, (child) => visit(child, depth));
    };
    visit(source);
  }
});
