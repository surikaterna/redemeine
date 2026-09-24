import { execFileSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const evidencePath = required('REDEMEINE_EVIDENCE_PATH');
const receiptPath = required('REDEMEINE_RECEIPT_PATH');
const container = required('REDEMEINE_MONGO_CONTAINER');
const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
const listed = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' });
if (listed.split('\n').includes(container)) throw new Error('Mongo container cleanup was not completed.');
const receipt = {
  ...evidence,
  gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scenario: 'projection-store-real-replica-set',
  image: { mongo: required('REDEMEINE_MONGO_DIGEST') },
  command: 'pnpm run test:projection-mongo-real',
  containerCleanupVerified: true,
  receiptFinalizedAfterCleanup: true
};
await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o444 });
await chmod(receiptPath, 0o444);
process.stdout.write(`${JSON.stringify({ status: 'PASS', receiptPath, ...receipt })}\n`);
