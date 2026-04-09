import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCodePrinciplesChecks } from '../../../bin/code-principles-checks';

function createTempRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-principles-checks-'));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

function createExportLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `export const v${index} = ${index};`).join('\n');
}

function cleanupDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

describe('code principles checks', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        cleanupDir(root);
      }
    }
  });

  test('passes valid production source and required docs', () => {
    const repoRoot = createTempRepoRoot();
    tempRoots.push(repoRoot);

    writeFile(repoRoot, 'docs/code-principles.md', '# Code Principles\n');
    writeFile(
      repoRoot,
      'packages/projection-runtime-core/src/ok.ts',
      'export const value = 1;\nexport function add(a: number, b: number): number { return a + b; }\n'
    );

    const result = runCodePrinciplesChecks({
      repoRoot,
      sourceRoots: ['packages/projection-runtime-core/src']
    });

    expect(result.violations).toEqual([]);
    expect(result.scannedFiles).toEqual(['packages/projection-runtime-core/src/ok.ts']);
  });

  test('reports default export and explicit any violations', () => {
    const repoRoot = createTempRepoRoot();
    tempRoots.push(repoRoot);

    writeFile(repoRoot, 'docs/code-principles.md', '# Code Principles\n');
    writeFile(
      repoRoot,
      'packages/projection-runtime-core/src/bad.ts',
      'const value: any = 42;\nexport default value;\n'
    );

    const result = runCodePrinciplesChecks({
      repoRoot,
      sourceRoots: ['packages/projection-runtime-core/src']
    });

    expect(result.violations).toContain('packages/projection-runtime-core/src/bad.ts: default export is not allowed.');
    expect(result.violations).toContain("packages/projection-runtime-core/src/bad.ts: explicit 'any' is not allowed.");
  });

  test('reports file length violations over configured maximum', () => {
    const repoRoot = createTempRepoRoot();
    tempRoots.push(repoRoot);

    writeFile(repoRoot, 'docs/code-principles.md', '# Code Principles\n');
    const lines = createExportLines(351);
    writeFile(repoRoot, 'packages/projection-runtime-core/src/too-long.ts', `${lines}\n`);

    const result = runCodePrinciplesChecks({
      repoRoot,
      sourceRoots: ['packages/projection-runtime-core/src']
    });

    expect(result.violations).toContain(
      'packages/projection-runtime-core/src/too-long.ts: 352 lines exceeds maximum 350 lines for production TypeScript files.'
    );
  });

  test('reports missing docs/code-principles.md', () => {
    const repoRoot = createTempRepoRoot();
    tempRoots.push(repoRoot);

    writeFile(repoRoot, 'packages/projection-runtime-core/src/ok.ts', 'export const ok = true;\n');

    const result = runCodePrinciplesChecks({
      repoRoot,
      sourceRoots: ['packages/projection-runtime-core/src']
    });

    expect(result.violations).toContain('docs/code-principles.md: required code principles documentation is missing.');
  });
});
