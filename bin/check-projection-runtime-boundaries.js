#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const packageDirs = {
  core: path.join(repoRoot, 'packages', 'projection-runtime-core'),
  inmemory: path.join(repoRoot, 'packages', 'projection-runtime-store-inmemory'),
  mongodb: path.join(repoRoot, 'packages', 'projection-runtime-store-mongodb')
};

const errors = [];

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

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }

  console.log('Projection runtime package boundaries validated successfully.');
}

run();
