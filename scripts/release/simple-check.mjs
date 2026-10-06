import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import semver from 'semver';
import { t } from 'tar';
import ts from 'typescript';
import { inspect } from './artifacts.mjs';
import { hash } from './workspace.mjs';

export const key = (artifact) => `${artifact.manifest.name}@${artifact.manifest.version}`;
export const runtimeFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
export const eligible = (workspaces, policy) => workspaces.filter((w) => !w.manifest.private && !Object.hasOwn(policy.holds, w.name));

export async function selectCandidates(workspaces, policy, client) {
  const candidates = [];
  const skipped = [];
  for (const workspace of eligible(workspaces, policy)) {
    const metadata = await client.metadata(workspace.name);
    if (metadata.versions[workspace.version]) skipped.push(`${workspace.name}@${workspace.version}`);
    else candidates.push(workspace);
  }
  return { candidates, skipped };
}

export function checkManifest(manifest, workspaces, policy) {
  assert.ok(!manifest.private, 'Private artifact');
  assert.ok(!policy.knownBad[manifest.name]?.includes(manifest.version), `Known broken artifact: ${manifest.name}@${manifest.version}`);
  assert.ok(!manifest.bundledDependencies && !manifest.bundleDependencies, 'Use explicit build bundling, not bundled node_modules');
  assert.ok(!manifest.publishConfig || Object.keys(manifest.publishConfig).every((k) => k === 'access'), 'Unsupported publishConfig');
  for (const field of [...runtimeFields, 'devDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] || {})) {
      assert.ok(typeof spec === 'string' && semver.validRange(spec), `Non-registry semver dependency: ${name}=${spec}`);
      if (field !== 'devDependencies') assert.ok(!workspaces.find((w) => w.name === name)?.manifest.private, `Private runtime edge: ${name}`);
    }
  }
}

export function checkImports(text, file, privateNames) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let spec;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) spec = node.moduleSpecifier.text;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) spec = node.argument.literal.text;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), `Uninspectable loader: ${file}`);
      spec = node.arguments[0].text;
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
    if (/\.[cm]?[jt]s$/.test(path)) checkImports(bytes.toString('utf8'), path, privateNames);
  }
}

export async function checkArtifact(file, expected, workspaces, policy, license) {
  const report = { diagnostics: [] };
  const artifact = await inspect(await readFile(file), expected, report, { package: expected.name });
  assert.deepEqual(report.diagnostics, [], 'Invalid packed content');
  assert.ok(artifact);
  checkManifest(artifact.manifest, workspaces, policy);
  await checkPayload(
    file,
    workspaces.filter((w) => w.manifest.private).map((w) => w.name),
    license
  );
  return artifact;
}

export function chooseVersion(name, range, artifacts, metadata, policy) {
  const candidate = artifacts.find((a) => a.manifest.name === name && semver.satisfies(a.manifest.version, range));
  if (candidate) return candidate.manifest.version;
  const version = semver.maxSatisfying(Object.keys(metadata.versions), range);
  assert.ok(version, `No candidate or registry version satisfies ${name}@${range}`);
  assert.ok(!policy.knownBad[name]?.includes(version), `Dependency resolves known broken ${name}@${version}`);
  return version;
}

export function ownedEdges(artifact, workspaces, policy) {
  return runtimeFields
    .flatMap((field) => Object.entries(artifact.manifest[field] || {}))
    .filter(([name]) => workspaces.some((w) => w.name === name) || policy.internalScopes.some((scope) => name.startsWith(`${scope}/`)));
}

export function dependencyOrder(artifacts, workspaces, policy) {
  const pending = [...artifacts];
  const ordered = [];
  while (pending.length) {
    const index = pending.findIndex((a) =>
      ownedEdges(a, workspaces, policy).every(([name, range]) =>
        ordered.some((dep) => dep.manifest.name === name && semver.satisfies(dep.manifest.version, range))
      )
    );
    assert.ok(index >= 0, `Cyclic or missing owned dependency: ${pending.map(key).join(', ')}`);
    ordered.push(...pending.splice(index, 1));
  }
  return ordered;
}

export async function verifyFiles(output, plan) {
  for (const artifact of plan.artifacts) {
    assert.match(artifact.file, /^[a-zA-Z0-9%_.-]+\.tgz$/);
    assert.equal(hash(await readFile(resolve(output, artifact.file))), artifact.sha256, `Changed artifact: ${key(artifact)}`);
  }
}
