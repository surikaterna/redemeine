import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import semver from 'semver';
import { t } from 'tar';
import ts from 'typescript';
import { inspect } from './artifacts.mjs';
import { hash, object, sri } from './workspace.mjs';

export const key = (artifact) => `${artifact.manifest.name}@${artifact.manifest.version}`;
export const runtimeFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
export const eligible = (workspaces, policy) => workspaces.filter((w) => !w.manifest.private && !Object.hasOwn(policy.holds, w.name));

export function selectCandidates(workspaces, policy, approved, tag, preMode) {
  const requested = approved.trim().split(/\s+/);
  assert.ok(approved.trim() && new Set(requested).size === requested.length, 'Explicit unique approval required');
  const candidates = requested.map((entry) => eligible(workspaces, policy).find((w) => key(w) === entry));
  assert.ok(candidates.every(Boolean), 'Approval must name exact public, non-held source versions');
  assert.ok(tag === 'pre' || tag === 'latest', 'Choose pre or latest explicitly');
  if (tag === 'latest') assert.ok(preMode !== 'pre' && candidates.every((w) => !semver.prerelease(w.version)), 'Exit Changesets prerelease mode first');
  return candidates;
}

export function dependency(name, spec) {
  assert.equal(typeof spec, 'string', `Non-registry dependency: ${name}`);
  const alias = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/.exec(spec);
  const target = alias ? alias[1] : name;
  const range = alias ? alias[2] : spec;
  assert.ok(range.trim() && semver.validRange(range), `Non-registry semver dependency: ${name}=${spec}`);
  return [target, range];
}

export function checkManifest(manifest, workspaces) {
  assert.ok(!manifest.private, 'Private artifact');
  assert.ok(!manifest.bundledDependencies && !manifest.bundleDependencies, 'Use explicit build bundling, not bundled node_modules');
  assert.ok(!manifest.publishConfig || Object.keys(manifest.publishConfig).every((k) => k === 'access'), 'Unsupported publishConfig');
  for (const field of [...runtimeFields, 'devDependencies']) {
    assert.ok(manifest[field] === undefined || object(manifest[field]), `Invalid dependency field: ${field}`);
    for (const [name, spec] of Object.entries(manifest[field] || {})) {
      const [target] = dependency(name, spec);
      if (field !== 'devDependencies')
        assert.ok(!workspaces.some((w) => [name, target].includes(w.name) && w.manifest.private), `Private runtime edge: ${name}`);
    }
  }
}

function bindingChecker(source) {
  // Bind only this payload: lexical shadowing matters, dependency resolution does not.
  return ts
    .createProgram(
      [source.fileName],
      { allowJs: true, noLib: true, noResolve: true },
      {
        ...ts.createCompilerHost({}),
        getSourceFile: (file) => (file === source.fileName ? source : undefined)
      }
    )
    .getTypeChecker();
}

function isGlobalRequire(node, checker) {
  return ts.isIdentifier(node) && node.text === 'require' && !checker.getSymbolAtLocation(node)?.declarations?.length;
}

function nodeModuleBinding(node, checker) {
  if (!ts.isIdentifier(node)) return;
  const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
  if (!declaration) return;
  let parent = declaration;
  while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
  if (!parent || !['node:module', 'module'].includes(parent.moduleSpecifier.text)) return;
  if (ts.isImportSpecifier(declaration)) return (declaration.propertyName || declaration.name).text;
  if (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) return '*';
}

function isRequireFactory(node, checker) {
  if (nodeModuleBinding(node, checker) === 'createRequire') return true;
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'createRequire' && nodeModuleBinding(node.expression, checker) === '*';
  // Computed namespace access cannot establish which Node loader API is selected.
  return ts.isElementAccessExpression(node) && nodeModuleBinding(node.expression, checker) === '*';
}

function staticTarget(node, file) {
  assert.ok(node && ts.isStringLiteral(node), `Uninspectable loader: ${file}`);
  return node.text;
}

export function checkImports(text, file, privateNames) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const checker = bindingChecker(source);
  function visit(node) {
    let spec;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) spec = node.moduleSpecifier.text;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) spec = node.argument.literal.text;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      spec = staticTarget(node.moduleReference.expression, file);
    }
    // Reject loader capture/factories rather than attempting alias dataflow.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      assert.ok(!isGlobalRequire(node.initializer, checker) && !isRequireFactory(node.initializer, checker), `Unsupported loader alias: ${file}`);
    }
    if (ts.isCallExpression(node)) {
      assert.ok(!isRequireFactory(node.expression, checker), `Unsupported createRequire loader: ${file}`);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || isGlobalRequire(node.expression, checker)) {
        assert.equal(node.arguments.length, 1, `Uninspectable loader: ${file}`);
        spec = staticTarget(node.arguments[0], file);
      }
    }
    if (spec) {
      assert.ok(!privateNames.some((name) => spec === name || spec.startsWith(`${name}/`)), `Private import: ${spec}`);
      assert.ok(!/(?:workspace:|file:|link:|\/src\/)/.test(spec), `Local import: ${spec}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

async function checkPayload(file, privateNames, license) {
  const contents = [];
  await t({
    file,
    strict: true,
    onReadEntry(entry) {
      if (entry.type !== 'File') return;
      const chunks = [];
      entry.on('data', (chunk) => chunks.push(chunk));
      entry.on('end', () => contents.push([entry.path, Buffer.concat(chunks)]));
    }
  });
  const packedLicense = contents.find(([path]) => path === 'package/LICENSE');
  assert.ok(packedLicense, 'Missing root LICENSE');
  assert.deepEqual(packedLicense[1], license, 'LICENSE differs from root');
  for (const [path, bytes] of contents) {
    if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) checkImports(bytes.toString('utf8'), path, privateNames);
  }
}

export async function checkArtifact(file, expected, workspaces, policy, license) {
  const artifact = await inspect(await readFile(file), expected);
  assert.ok(!Object.hasOwn(policy.holds, artifact.manifest.name), 'Held artifact');
  checkManifest(artifact.manifest, workspaces);
  await checkPayload(
    file,
    workspaces.filter((w) => w.manifest.private).map((w) => w.name),
    license
  );
  return artifact;
}

export function ownedEdges(artifact, workspaces) {
  return runtimeFields
    .flatMap((field) => Object.entries(artifact.manifest[field] || {}))
    .map(([name, spec]) => dependency(name, spec))
    .filter(([name]) => workspaces.some((w) => w.name === name));
}

export async function dependencyOrder(artifacts, workspaces, metadata) {
  const edges = new Map();
  for (const artifact of artifacts) {
    const selected = [];
    for (const [name, range] of ownedEdges(artifact, workspaces)) {
      const candidate = artifacts.find((a) => a.manifest.name === name);
      if (candidate) {
        assert.ok(semver.satisfies(candidate.manifest.version, range), `Selected dependency does not satisfy ${name}@${range}`);
        selected.push(name);
      } else checkExisting(name, range, await metadata(name, range), workspaces);
    }
    edges.set(artifact, selected);
  }
  const pending = [...artifacts];
  const ordered = [];
  while (pending.length) {
    const index = pending.findIndex((a) => edges.get(a).every((name) => ordered.some((dep) => dep.manifest.name === name)));
    assert.ok(index >= 0, `Cyclic selected dependency: ${pending.map(key).join(', ')}`);
    ordered.push(...pending.splice(index, 1));
  }
  return ordered;
}

function checkExisting(name, range, metadata, workspaces) {
  const versions = Array.isArray(metadata) ? metadata : [metadata];
  assert.ok(
    versions.every((m) => object(m) && m.name === name && semver.valid(m.version)),
    `Missing/invalid metadata: ${name}`
  );
  const version = semver.maxSatisfying(
    versions.map((m) => m.version),
    range
  );
  assert.ok(version, `Missing public dependency: ${name}@${range}`);
  checkManifest(
    versions.find((m) => m.version === version),
    workspaces
  );
}

export async function verifyFiles(output, plan) {
  assert.ok((await lstat(output)).isDirectory(), 'Artifact directory must not be a link');
  for (const artifact of plan.artifacts) assert.match(artifact.file, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.tgz$/);
  const files = ['plan.json', ...plan.artifacts.map((a) => a.file)];
  assert.equal(new Set(files).size, files.length, 'Duplicate artifact filename');
  assert.deepEqual((await readdir(output)).sort(), files.sort(), 'Unexpected artifact files');
  for (const file of files) assert.ok((await lstat(resolve(output, file))).isFile(), 'Artifacts must be regular files');
  for (const artifact of plan.artifacts) {
    const bytes = await readFile(resolve(output, artifact.file));
    assert.equal(hash(bytes), artifact.sha256, `Changed artifact: ${key(artifact)}`);
    assert.equal(sri(bytes), artifact.integrity, `Changed artifact integrity: ${key(artifact)}`);
  }
}
