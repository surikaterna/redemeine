import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal, parseArgs } from 'node:util';
import { boundedRead, containedRead } from './consumer-files.mjs';
import { parseJson } from './consumer-json.mjs';
import { registryClient } from './registry.mjs';
import { appliedBlockers, canonicalBytes, intentSchema, requirePlan, selectionFor, validateIntent, validatePlan } from './release-plan-schema.mjs';
import { discover, hash, prerequisites, run, sourceIdentity } from './workspace.mjs';

export function planArguments(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      intent: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (!values.help)
    requirePlan(values.intent && isAbsolute(values.intent) && values.output && isAbsolute(values.output), 'Absolute --intent and fresh --output required');
  return values;
}

async function optionalPre(root) {
  try {
    return parseJson(await boundedRead(resolve(root, '.changeset/pre.json'), 1024 * 1024));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function inputFiles(root, report, pre) {
  const files = ['package.json', '.changeset/config.json', 'scripts/release/consumer-tools.json'];
  if (pre) files.push('.changeset/pre.json');
  for (const file of files) report.inputs[file] = hash(await boundedRead(resolve(root, file), 16 * 1024 * 1024));
}

async function changesetInventory(root, output, report, intent, pre) {
  requirePlan(report.tools.helpers['@changesets/cli'] === '2.31.0', 'Only pinned Changesets 2.31.0 is supported');
  const target = resolve(output, 'changesets-status.json');
  run(report, root, 'pnpm', ['exec', 'changeset', 'status', '--output', target]);
  const bytes = await boundedRead(target, 16 * 1024 * 1024);
  parseJson(bytes);
  const require = createRequire(import.meta.url);
  const cliRequire = createRequire(require.resolve('@changesets/cli/package.json'));
  const changesets = await cliRequire('@changesets/read').default(root);
  requirePlan(equal(Object.keys(intent.changesets).sort(), changesets.map((item) => item.id).sort()), 'Every changeset needs a reviewed disposition');
  const inventory = [];
  for (const item of changesets.sort((a, b) => a.id.localeCompare(b.id))) {
    const sha256 = hash(await boundedRead(resolve(root, '.changeset', `${item.id}.md`), 1024 * 1024));
    report.inputs[`.changeset/${item.id}.md`] = sha256;
    inventory.push({
      id: item.id,
      sha256,
      consumed: pre?.changesets?.includes(item.id) || false,
      disposition: intent.changesets[item.id],
      releases: item.releases
    });
  }
  return { changesets: inventory, changesetsStatusSha256: hash(bytes) };
}

async function registryInventory(policy, fixture, output, report, workspaces) {
  const client = await registryClient(policy, fixture, output, report);
  const snapshots = [];
  for (const item of workspaces.filter((entry) => !entry.manifest.private).sort((a, b) => a.name.localeCompare(b.name))) {
    const timestamp = new Date().toISOString();
    const metadata = await client.metadata(item.name);
    const snapshot = report.registrySnapshots.find((entry) => entry.name === item.name);
    snapshots.push({ ...snapshot, timestamp, tags: metadata['dist-tags'] || {} });
  }
  return snapshots;
}

async function manifestInventory(workspaces, intent, policy) {
  const inventory = [];
  for (const item of workspaces.sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await boundedRead(resolve(item.path, 'package.json'), 1024 * 1024);
    requirePlan(equal(parseJson(bytes), item.manifest), 'Workspace changed during planning');
    inventory.push({
      name: item.name,
      version: item.version,
      sourcePath: item.sourcePath,
      selection: selectionFor(item, intent, policy),
      manifest: item.manifest,
      manifestSha256: hash(bytes)
    });
  }
  return inventory;
}

export async function createPlan(root, options, fixture = undefined) {
  root = await realpath(root);
  const rel = relative(root, options.output);
  requirePlan(rel.startsWith('../'), 'Plan output must be outside the source checkout');
  await mkdir(options.output, { mode: 0o700 });
  const report = { root, invocations: [], registrySnapshots: [] };
  const intent = intentSchema.parse(parseJson(await boundedRead(options.intent, 1024 * 1024)));
  const policy = await prerequisites(root, report);
  const repository = await sourceIdentity(root, report);
  const pre = await optionalPre(root);
  const workspaces = await discover(root, policy, report);
  validateIntent(intent, workspaces, policy, pre);
  await inputFiles(root, report, pre);
  const changesets = await changesetInventory(root, options.output, report, intent, pre);
  const registry = await registryInventory(policy, fixture, options.output, report, workspaces);
  const inventory = await manifestInventory(workspaces, intent, policy);
  const blockers = appliedBlockers(intent, workspaces, registry);
  const intentSha256 = hash(canonicalBytes(intent));
  const plan = validatePlan({
    schemaVersion: 1,
    purpose: 'nonpublishing release plan',
    livePublishing: false,
    timestamp: new Date().toISOString(),
    classification: fixture ? 'fixture-rehearsal' : 'repository',
    intent,
    intentSha256,
    repository,
    tools: report.tools,
    inputs: report.inputs,
    policy,
    pre,
    workspaces: inventory,
    ...changesets,
    registry,
    uploadTag: `rehearsal-${intentSha256.slice(0, 24)}`,
    status: blockers.length ? 'proposed-unapplied' : 'applied',
    blockers
  });
  requirePlan(equal(await sourceIdentity(root, report), repository), 'Planning changed source identity');
  const bytes = canonicalBytes(plan);
  await writeFile(resolve(options.output, 'plan.json'), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(options.output, 'plan.sha256'), `${hash(bytes)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(options.output, 'commands.json'), canonicalBytes(report.invocations), { flag: 'wx', mode: 0o600 });
  return { plan, sha256: hash(bytes), exitCode: blockers.length ? 2 : 0 };
}

export async function loadPlan(path, expected) {
  requirePlan(/^[a-f0-9]{64}$/.test(expected || ''), 'Expected plan SHA256 required');
  const bytes = await boundedRead(path, 16 * 1024 * 1024);
  requirePlan(hash(bytes) === expected, 'Plan digest mismatch');
  const plan = validatePlan(parseJson(bytes));
  requirePlan(bytes.equals(canonicalBytes(plan)), 'Plan must use canonical bytes');
  return { plan, bytes, sha256: expected };
}

export async function applySelection(root, workspaces, report, options) {
  const loaded = await loadPlan(options['release-plan'], options['release-plan-sha256']);
  const { plan } = loaded;
  requirePlan(plan.status === 'applied', 'Future release plan is unapplied; no packing permitted');
  requirePlan(equal(report.repository, plan.repository) && equal(report.policy, plan.policy), 'Plan source/policy mismatch');
  requirePlan(equal(report.tools, plan.tools), 'Plan toolchain mismatch');
  requirePlan(equal(await manifestInventory(workspaces, plan.intent, report.policy), plan.workspaces), 'Plan workspace source mismatch');
  for (const [file, expected] of Object.entries(plan.inputs)) {
    requirePlan(hash(await containedRead(root, file, 16 * 1024 * 1024)) === expected, `Plan input changed: ${file}`);
  }
  report.schemaVersion = 2;
  report.purpose = 'selected-release-audit';
  report.releasePlan = { sha256: loaded.sha256, plan };
  report.beads.push('redemeine-cwxu.3');
  report.notValidated = report.notValidated.filter(
    (item) => !['release membership/version plan', 'exact-byte publisher binding; publish.yml remains unprotected'].includes(item)
  );
  report.notValidated.push('public publication authorization; legacy workflow refuses publication');
  for (const workspace of workspaces) workspace.selection = selectionFor(workspace, plan.intent, report.policy);
  report.workspaces = workspaces.map(({ path, manifest, ...item }) => item);
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = planArguments(args);
    if (options.help) {
      console.log(
        '--intent <absolute reviewed JSON> --output <fresh absolute external directory>; read-only Changesets 2.31.0 status, never version/publish. Exit 2 includes unapplied intent.'
      );
      return 0;
    }
    const result = await createPlan(process.cwd(), options);
    console.log(`${result.plan.status}: ${result.sha256}; ${result.plan.blockers.join('; ')}`);
    return result.exitCode;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
