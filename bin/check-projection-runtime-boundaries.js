#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const projectionPackageJsonPath = path.join(repoRoot, 'packages', 'projection', 'package.json');
const projectionSrcDir = path.join(repoRoot, 'packages', 'projection', 'src');

const packageDirs = {
  projection: path.join(repoRoot, 'packages', 'projection'),
  routerCore: path.join(repoRoot, 'packages', 'projection-router-core'),
  workerCore: path.join(repoRoot, 'packages', 'projection-worker-core'),
  workerLite: path.join(repoRoot, 'packages', 'projection-worker-lite'),
  core: path.join(repoRoot, 'packages', 'projection-runtime-core'),
  inmemory: path.join(repoRoot, 'packages', 'projection-runtime-store-inmemory'),
  mongodb: path.join(repoRoot, 'packages', 'projection-runtime-store-mongodb')
};

const runtimePackageNames = new Set([
  '@redemeine/projection-runtime-core',
  '@redemeine/projection-runtime-store-inmemory',
  '@redemeine/projection-runtime-store-mongodb',
  '@redemeine/projection-router-core',
  '@redemeine/projection-worker-core',
  '@redemeine/projection-worker-lite'
]);

const concreteStoreImportPattern = /from\s+['"]@redemeine\/projection-runtime-store-(inmemory|mongodb)(?:\/[^'"]*)?['"]/;

const concreteStoreDynamicImportPattern = /import\s*\(\s*['"]@redemeine\/projection-runtime-store-(inmemory|mongodb)(?:\/[^'"]*)?['"]\s*\)/;

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

function readPackageDeps(packageJsonPath) {
  const pkg = readJson(packageJsonPath);
  return {
    packageName: pkg.name,
    deps: {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
      ...(pkg.optionalDependencies || {})
    }
  };
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
  const routerPackage = readJson(path.join(packageDirs.routerCore, 'package.json'));
  const workerCorePackage = readJson(path.join(packageDirs.workerCore, 'package.json'));
  const workerLitePackage = readJson(path.join(packageDirs.workerLite, 'package.json'));

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

  const packageDepsToCheck = [
    { pkg: routerPackage, forbidden: ['@redemeine/projection-runtime-store-inmemory', '@redemeine/projection-runtime-store-mongodb'] },
    {
      pkg: workerCorePackage,
      forbidden: [
        '@redemeine/projection-runtime-store-inmemory',
        '@redemeine/projection-runtime-store-mongodb',
        '@redemeine/projection-worker-lite'
      ]
    },
    {
      pkg: workerLitePackage,
      forbidden: [
        '@redemeine/projection-runtime-store-inmemory',
        '@redemeine/projection-runtime-store-mongodb',
        '@redemeine/projection-worker-core'
      ]
    }
  ];

  for (const { pkg, forbidden } of packageDepsToCheck) {
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
      ...(pkg.optionalDependencies || {})
    };

    for (const forbiddenDependency of forbidden) {
      if (forbiddenDependency in deps) {
        errors.push(
          `Dependency boundary violation: ${pkg.name} must not depend on ${forbiddenDependency}.`
        );
      }
    }
  }
}

function assertCoreImportBoundaries() {
  const coreSrc = path.join(packageDirs.core, 'src');
  const tsFiles = getAllTsFiles(coreSrc);

  for (const filePath of tsFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    if (concreteStoreImportPattern.test(source) || concreteStoreDynamicImportPattern.test(source)) {
      const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
      errors.push(
        `Import boundary violation: ${relativePath} imports a concrete projection store package.`
      );
    }
  }
}

function assertRouterWorkerImportBoundaries() {
  const packageSources = [
    { name: '@redemeine/projection-router-core', src: path.join(packageDirs.routerCore, 'src') },
    { name: '@redemeine/projection-worker-core', src: path.join(packageDirs.workerCore, 'src') },
    { name: '@redemeine/projection-worker-lite', src: path.join(packageDirs.workerLite, 'src') }
  ];

  for (const packageSource of packageSources) {
    const tsFiles = getAllTsFiles(packageSource.src);
    for (const filePath of tsFiles) {
      const source = fs.readFileSync(filePath, 'utf8');
      if (concreteStoreImportPattern.test(source) || concreteStoreDynamicImportPattern.test(source)) {
        const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
        errors.push(
          `Import boundary violation: ${relativePath} in ${packageSource.name} imports a concrete projection store package.`
        );
      }
    }
  }
}

function assertProjectionDefinitionOnly() {
  const projectionPackageJson = path.join(packageDirs.projection, 'package.json');
  const { packageName, deps } = readPackageDeps(projectionPackageJson);

  const forbiddenProjectionDeps = [
    '@redemeine/projection-router-core',
    '@redemeine/projection-worker-core',
    '@redemeine/projection-worker-lite',
    '@redemeine/projection-runtime-core',
    '@redemeine/projection-runtime-store-inmemory',
    '@redemeine/projection-runtime-store-mongodb'
  ];

  for (const forbiddenDependency of forbiddenProjectionDeps) {
    if (forbiddenDependency in deps) {
      errors.push(
        `Dependency boundary violation: ${packageName} must remain definition-only and must not depend on ${forbiddenDependency}.`
      );
    }
  }
}

function run() {
  assertDependencyDirection();
  assertCoreImportBoundaries();
  assertRouterWorkerImportBoundaries();
  assertProjectionDefinitionOnly();
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
