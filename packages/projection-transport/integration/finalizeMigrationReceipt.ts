import { execFileSync } from 'node:child_process';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';

const evidence = JSON.parse(await readFile(process.env.REDEMEINE_EVIDENCE_PATH!, 'utf8')) as Record<string, unknown>;
const container = process.env.REDEMEINE_MONGO_CONTAINER!;
const names = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\n');
if (names.includes(container)) throw new Error('Migration Mongo container cleanup failed.');
let artifactRemoved = false;
try {
  await access(process.env.REDEMEINE_RUNTIME_ARTIFACT!);
} catch {
  artifactRemoved = true;
}
if (!artifactRemoved) throw new Error('Runtime artifact cleanup failed.');
const receipt = {
  ...evidence,
  mongoImage: process.env.REDEMEINE_MONGO_DIGEST,
  mongoContainerRemoved: true,
  runtimeArtifactRemoved: true,
  receiptFinalizedAfterCleanup: true
};
const path = process.env.REDEMEINE_RECEIPT_PATH!;
await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o444 });
await chmod(path, 0o444);
process.stdout.write(`${JSON.stringify({ status: 'PASS', receiptPath: path, ...receipt })}\n`);
