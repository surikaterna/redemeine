#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const DEFAULT_SOURCE_ROOTS = [
  'packages/projection/src',
  'packages/projection-runtime-core/src',
  'packages/projection-runtime-store-inmemory/src',
  'packages/projection-runtime-store-mongodb/src'
];

const DEFAULT_RULES = {
  requiredDocsPath: 'docs/code-principles.md',
  maxTsLines: 350,
  lineCountExemptions: new Set(['packages/projection-runtime-core/src/ProjectionDaemon.ts', 'packages/projection-runtime-core/src/createProjection.ts'])
};

function normalize(filePath) {
  return filePath.replace(/\\/g, '/');
}

function toAbsolute(repoRoot, relativePath) {
  return path.join(repoRoot, relativePath);
}

function isProductionTsFile(filePath) {
  const normalizedPath = normalize(filePath);
  if (!normalizedPath.endsWith('.ts') || normalizedPath.endsWith('.d.ts') || normalizedPath.endsWith('.generated.ts')) {
    return false;
  }

  const pathSegments = normalizedPath.split('/');
  const isGenerated = pathSegments.includes('generated') || pathSegments.includes('__generated__');
  return !isGenerated && !normalizedPath.endsWith('.test.ts') && !normalizedPath.endsWith('.spec.ts');
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

function parseTypeScript(relativePath, sourceText, violations) {
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const diagnostic of sourceFile.parseDiagnostics) {
    const position = diagnostic.start === undefined ? null : sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    const location = position ? `:${position.line + 1}:${position.character + 1}` : '';
    violations.push(`${relativePath}${location}: TypeScript parse error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  return sourceFile;
}

function checkExplicitAny(relativePath, sourceFile, violations) {
  const locations = [];
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      locations.push(`${position.line + 1}:${position.character + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (locations.length > 0) violations.push(`${relativePath}: explicit 'any' is not allowed (${locations.length} at ${locations.join(', ')}).`);
}

function checkFileLength(relativePath, sourceText, rules, violations) {
  const lineCount = countLines(sourceText);
  if (lineCount <= rules.maxTsLines || rules.lineCountExemptions.has(relativePath)) {
    return;
  }

  violations.push(`${relativePath}: ${lineCount} lines exceeds maximum ${rules.maxTsLines} lines for production TypeScript files.`);
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
      options.rules?.lineCountExemptions ? Array.from(options.rules.lineCountExemptions) : Array.from(DEFAULT_RULES.lineCountExemptions)
    )
  };

  const violations = [];
  checkRequiredDocs(repoRoot, rules, violations);

  const files = collectProductionTsFiles(repoRoot, sourceRoots);
  for (const relativePath of files) {
    const absolutePath = toAbsolute(repoRoot, relativePath);
    const sourceText = fs.readFileSync(absolutePath, 'utf8');
    const sourceFile = parseTypeScript(relativePath, sourceText, violations);
    checkDefaultExport(relativePath, sourceText, violations);
    checkExplicitAny(relativePath, sourceFile, violations);
    checkFileLength(relativePath, sourceText, rules, violations);
  }

  return { repoRoot, scannedFiles: files, violations };
}

module.exports = {
  DEFAULT_RULES,
  DEFAULT_SOURCE_ROOTS,
  runCodePrinciplesChecks
};
