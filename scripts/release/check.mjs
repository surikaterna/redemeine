import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pack } from './artifacts.mjs';
import { auditGraph } from './graph.mjs';
import { registryClient } from './registry.mjs';
import { diagnostic, discover, prerequisites, sourceIdentity } from './workspace.mjs';

export function argumentsFor(args) {
  const { values } = parseArgs({
    args,
    options: { output: { type: 'string' }, 'registry-fixture': { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: false
  });
  if (!values.help && (!values.output || !isAbsolute(values.output))) throw new Error('--output must be an absolute, not-yet-existing directory');
  return values;
}

function newReport(root) {
  return {
    schemaVersion: 1,
    beads: ['redemeine-cwxu', 'redemeine-cwxu.1'],
    purpose: 'nonpublishing static artifact audit; not a release plan',
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    root,
    invocations: [],
    artifacts: [],
    edges: [],
    diagnostics: [],
    registrySnapshots: [],
    notValidated: [
      'consumer installation/runtime/declarations',
      'full external dependency graph',
      'optional-peer runtime behavior',
      'Node22 or Bun consumers',
      'provenance/channel/auth',
      'release membership/version plan',
      'exact-byte publisher binding; publish.yml remains unprotected'
    ]
  };
}

async function packAll(workspaces, output, report) {
  const artifacts = [];
  for (const workspace of workspaces.filter((entry) => entry.selection !== 'private')) {
    try {
      const artifact = await pack(workspace, output, report);
      if (artifact) artifacts.push(artifact);
    } catch (error) {
      diagnostic(report, 'PACK_INCOMPLETE', error.message, { package: workspace.name, sourcePath: workspace.sourcePath }, true);
    }
  }
  report.artifacts.push(...artifacts);
  return artifacts;
}

export async function audit(root, options) {
  root = await realpath(root);
  await mkdir(options.output);
  const report = newReport(root);
  try {
    const policy = await prerequisites(root, report);
    report.policy = policy;
    report.repository = await sourceIdentity(root, report);
    const workspaces = await discover(root, policy, report);
    const artifacts = await packAll(workspaces, options.output, report);
    const registry = await registryClient(policy, options['registry-fixture'], options.output, report);
    await auditGraph(workspaces, artifacts, policy, registry, report);
  } catch (error) {
    diagnostic(report, 'INPUT_INCOMPLETE', error.message, {}, true);
  }
  report.complete = !report.diagnostics.some((entry) => entry.severity === 'incomplete');
  report.exitCode = report.complete ? Number(report.diagnostics.length > 0) : 2;
  report.verdict = ['static-clean', 'violations', 'incomplete'][report.exitCode];
  const { root: omitted, ...portable } = report;
  portable.artifacts = report.artifacts.map(({ source, ...artifact }) => artifact);
  await writeFile(resolve(options.output, 'manifest.json'), `${JSON.stringify(portable, null, 2)}\n`);
  for (const entry of report.diagnostics) console.error(`${entry.severity} ${entry.code}: ${entry.package || ''} ${entry.field || ''} ${entry.message}`);
  console.log(`${report.verdict}: ${report.artifacts.length} artifacts, ${report.edges.length} edges; ${options.output}/manifest.json`);
  return report.exitCode;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = argumentsFor(args);
    if (options.help) {
      console.log(
        'Node24 / root-pinned pnpm, built workspaces required. Anonymous read-only registry audit; NEVER publishes.\n--output <absolute fresh directory> [--registry-fixture <directory with index.json and original tgz bytes>]\nExit 0: static clean; 1: artifact/graph violations; 2: input/tool/network/incomplete. No consumer or publisher proof.'
      );
      return 0;
    }
    return await audit(process.cwd(), options);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
