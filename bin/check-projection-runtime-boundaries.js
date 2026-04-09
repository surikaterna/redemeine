const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const projectionPackageJsonPath = path.join(root, 'packages', 'projection', 'package.json');
const projectionSrcDir = path.join(root, 'packages', 'projection', 'src');

const runtimePackageNames = new Set([
  '@redemeine/projection-runtime-core',
  '@redemeine/projection-runtime-store-inmemory'
]);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function checkProjectionPackageDependencies() {
  const pkg = readJson(projectionPackageJsonPath);
  const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

  for (const field of dependencyFields) {
    const deps = pkg[field] ?? {};
    for (const dependencyName of Object.keys(deps)) {
      if (runtimePackageNames.has(dependencyName)) {
        fail(`packages/projection/package.json must not depend on runtime package "${dependencyName}" (field: ${field}).`);
      }
    }
  }
}

function listTypeScriptFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
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
  for (const filePath of listTypeScriptFiles(projectionSrcDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const imports = findRuntimeImports(content);
    if (imports.length > 0) {
      const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
      const uniqueImports = [...new Set(imports)].join(', ');
      fail(`${relativePath} must not import runtime package(s): ${uniqueImports}`);
    }
  }
}

checkProjectionPackageDependencies();
checkProjectionSourceImports();

if (!process.exitCode) {
  console.log('✅ Projection runtime boundaries are clean.');
}
