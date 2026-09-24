import { readFile, writeFile } from 'node:fs/promises';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function load(path: string, sha: string): Promise<Record<string, unknown>> {
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (record.gitSha !== sha || record.logicalCleanupVerified !== true) {
    throw new Error('Real-stack suite has mismatched SHA or unverified logical cleanup.');
  }
  return record;
}

const sha = required('REDEMEINE_GIT_SHA');
const old = await load(required('REDEMEINE_OLD_EVIDENCE_PATH'), sha);
const accepted = await load(required('REDEMEINE_ACCEPTED_EVIDENCE_PATH'), sha);
const oldScenarios = ['normal-seq0', 'before-save', 'after-p', 'after-all', 'after-coverage',
  'gap-catchup', 'reconnect-redelivery', 'terminal-poison', 'durable-retry', 'reduced-registry',
  'unknown-source-retry'];
const acceptedScenarios = ['empty-B=-1', 'unnotified-seq0', 'B0-H0', 'unnotified-seq1', 'none-redelivery',
  'B1-bootstrap', 'restart-unnotified', 'missing-queue', 'incompatible-topology', 'invalid-birth',
  'retained-gap', 'missing-B'];
const poison = old.poison as Record<string, unknown> | undefined;
const unknown = poison?.unknownSource as Record<string, unknown> | undefined;
if (!Array.isArray(old.crashes) || old.crashes.length !== 4 || !poison || unknown?.rejected !== true || old.gap === undefined
  || old.reducedRegistryRejected !== true || accepted.gapStatus !== 'incomplete'
  || accepted.missingRejected !== true || accepted.incompatibleRejected !== true
  || accepted.birthRejected !== true || accepted.missingBoundaryRejected !== true) {
  throw new Error('One of the original or accepted-baseline scenarios is missing.');
}
await writeFile(required('REDEMEINE_EVIDENCE_PATH'), JSON.stringify({ gitSha: sha,
  oldScenarios, acceptedScenarios, scenarioCount: oldScenarios.length + acceptedScenarios.length,
  old, accepted, logicalCleanupVerified: true }), { flag: 'wx' });
