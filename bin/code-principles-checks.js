#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SOURCE_ROOTS = [
  'packages/projection-runtime-core/src',
  'packages/projection-runtime-store-inmemory/src',
  'packages/projection-runtime-store-mongodb/src'
];

const DEFAULT_RULES = {
  requiredDocsPath: 'docs/code-principles.md',
  maxTsLines: 350,
  lineCountExemptions: new Set([
    'packages/projection-runtime-core/src/ProjectionDaemon.ts',
    'packages/projection-runtime-core/src/createProjection.ts'
  ])
};

function normalize(filePath) {
  return filePath.replace(/\\/g, '/');
}

function toAbsolute(repoRoot, relativePath) {
  return path.join(repoRoot, relativePath);
}

function isProductionTsFile(filePath) {
  if (!filePath.endsWith('.ts') || filePath.endsWith('.d.ts')) {
    return false;
  }

  return !filePath.endsWith('.test.ts') && !filePath.endsWith('.spec.ts');
}

function walkDirectory(dirPath) {
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDirectory(fullPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectProductionTsFiles(repoRoot, sourceRoots) {
  const files = [];
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = toAbsolute(repoRoot, sourceRoot);
    if (!fs.existsSync(absoluteRoot)) {
      continue;
    }

    const discovered = walkDirectory(absoluteRoot)
      .map((absoluteFilePath) => normalize(path.relative(repoRoot, absoluteFilePath)))
      .filter(isProductionTsFile);
    files.push(...discovered);
  }

  return Array.from(new Set(files)).sort();
}

function countLines(sourceText) {
  return sourceText.split(/\r?\n/).length;
}

function checkDefaultExport(relativePath, sourceText, violations) {
  if (/^\s*export\s+default\b/m.test(sourceText)) {
    violations.push(`${relativePath}: default export is not allowed.`);
  }
}

function checkExplicitAny(relativePath, sourceText, violations) {
  const explicitAnyPattern = /(:\s*any\b)|(\bas\s+any\b)|(\bArray\s*<\s*any\s*>\b)|(<\s*any\s*>)/m;
  if (explicitAnyPattern.test(sourceText)) {
    violations.push(`${relativePath}: explicit 'any' is not allowed.`);
  }
}

function checkFileLength(relativePath, sourceText, rules, violations) {
  const lineCount = countLines(sourceText);
  if (lineCount <= rules.maxTsLines || rules.lineCountExemptions.has(relativePath)) {
    return;
  }

  violations.push(
    `${relativePath}: ${lineCount} lines exceeds maximum ${rules.maxTsLines} lines for production TypeScript files.`
  );
}

function checkRequiredDocs(repoRoot, rules, violations) {
  const docsAbsolutePath = toAbsolute(repoRoot, rules.requiredDocsPath);
  if (!fs.existsSync(docsAbsolutePath)) {
    violations.push(`${rules.requiredDocsPath}: required code principles documentation is missing.`);
  }
}

function runCodePrinciplesChecks(options = {}) {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, '..');
  const sourceRoots = options.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const rules = {
    ...DEFAULT_RULES,
    ...(options.rules ?? {}),
    lineCountExemptions: new Set(
      options.rules?.lineCountExemptions
        ? Array.from(options.rules.lineCountExemptions)
        : Array.from(DEFAULT_RULES.lineCountExemptions)
    )
  };

  const violations = [];
  checkRequiredDocs(repoRoot, rules, violations);

  const files = collectProductionTsFiles(repoRoot, sourceRoots);
  for (const relativePath of files) {
    const absolutePath = toAbsolute(repoRoot, relativePath);
    const sourceText = fs.readFileSync(absolutePath, 'utf8');
    checkDefaultExport(relativePath, sourceText, violations);
    checkExplicitAny(relativePath, sourceText, violations);
    checkFileLength(relativePath, sourceText, rules, violations);
  }

  return { repoRoot, scannedFiles: files, violations };
}

module.exports = {
  DEFAULT_RULES,
  DEFAULT_SOURCE_ROOTS,
  runCodePrinciplesChecks
};
