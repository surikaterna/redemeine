#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const projectionPackageJsonPath = path.join(repoRoot, 'packages', 'projection', 'package.json');
const projectionSrcDir = path.join(repoRoot, 'packages', 'projection', 'src');

const packageDirs = {
  core: path.join(repoRoot, 'packages', 'projection-runtime-core'),
  inmemory: path.join(repoRoot, 'packages', 'projection-runtime-store-inmemory'),
  mongodb: path.join(repoRoot, 'packages', 'projection-runtime-store-mongodb')
};

const runtimePackageNames = new Set([
  '@redemeine/projection-runtime-core',
  '@redemeine/projection-runtime-store-inmemory'
]);

const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getAllTsFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function checkProjectionPackageDependencies() {
  const pkg = readJson(projectionPackageJsonPath);
  const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

  for (const field of dependencyFields) {
    const deps = pkg[field] ?? {};
    for (const dependencyName of Object.keys(deps)) {
      if (runtimePackageNames.has(dependencyName)) {
        fail(`Dependency boundary violation: packages/projection/package.json must not depend on runtime package "${dependencyName}" (field: ${field}).`);
      }
    }
  }
}

function findRuntimeImports(fileContent) {
  const directPattern = /from\s+['"](@redemeine\/projection-runtime-(?:core|store-inmemory))['"]/g;
  const dynamicPattern = /import\s*\(\s*['"](@redemeine\/projection-runtime-(?:core|store-inmemory))['"]\s*\)/g;
  const hits = [];

  for (const pattern of [directPattern, dynamicPattern]) {
    let match;
    while ((match = pattern.exec(fileContent)) !== null) {
      hits.push(match[1]);
    }
  }

  return hits;
}

function checkProjectionSourceImports() {
  for (const filePath of getAllTsFiles(projectionSrcDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const imports = findRuntimeImports(content);
    if (imports.length > 0) {
      const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
      const uniqueImports = [...new Set(imports)].join(', ');
      fail(`Import boundary violation: ${relativePath} must not import runtime package(s): ${uniqueImports}`);
    }
  }
}

function assertDependencyDirection() {
  const corePackage = readJson(path.join(packageDirs.core, 'package.json'));
  const inmemoryPackage = readJson(path.join(packageDirs.inmemory, 'package.json'));
  const mongodbPackage = readJson(path.join(packageDirs.mongodb, 'package.json'));

  const coreDeps = {
    ...(corePackage.dependencies || {}),
    ...(corePackage.devDependencies || {}),
    ...(corePackage.peerDependencies || {})
  };

  const forbiddenCoreDeps = [
    '@redemeine/projection-runtime-store-inmemory',
    '@redemeine/projection-runtime-store-mongodb'
  ];

  for (const forbidden of forbiddenCoreDeps) {
    if (forbidden in coreDeps) {
      errors.push(
        `Dependency boundary violation: ${corePackage.name} must not depend on ${forbidden}.`
      );
    }
  }

  const requiredStoreDep = '@redemeine/projection-runtime-core';
  for (const storePackage of [inmemoryPackage, mongodbPackage]) {
    const deps = {
      ...(storePackage.dependencies || {}),
      ...(storePackage.devDependencies || {}),
      ...(storePackage.peerDependencies || {})
    };

    if (!(requiredStoreDep in deps)) {
      errors.push(
        `Dependency boundary violation: ${storePackage.name} must depend on ${requiredStoreDep}.`
      );
    }
  }
}

function assertCoreImportBoundaries() {
  const coreSrc = path.join(packageDirs.core, 'src');
  const tsFiles = getAllTsFiles(coreSrc);
  const forbiddenImportPattern = /from\s+['"]@redemeine\/projection-runtime-store-(inmemory|mongodb)(?:\/[^'"]*)?['"]/;

  for (const filePath of tsFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    if (forbiddenImportPattern.test(source)) {
      const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
      errors.push(
        `Import boundary violation: ${relativePath} imports a concrete projection store package.`
      );
    }
  }
}

function run() {
  assertDependencyDirection();
  assertCoreImportBoundaries();
  checkProjectionPackageDependencies();
  checkProjectionSourceImports();

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`❌ ${error}`);
    }
    process.exit(1);
  }

  console.log('✅ Projection runtime package boundaries validated successfully.');
}

run();
