import { execFileSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const evidence = JSON.parse(await readFile(required('REDEMEINE_EVIDENCE_PATH'), 'utf8')) as Record<string, unknown>;
const container = required('REDEMEINE_MONGO_CONTAINER');
const listed = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' });
if (listed.split('\n').includes(container)) throw new Error('Benchmark Mongo container cleanup was not completed.');
const receiptPath = required('REDEMEINE_RECEIPT_PATH');
const receipt = {
  ...evidence,
  image: { mongo: required('REDEMEINE_MONGO_DIGEST') },
  command:
    'pnpm run bench:projection-source-progress -- --events-per-commit 1,10,100 --inline-source-counts 1000,1001 --own-record-source-cardinalities 10000,100000 --samples 30 --seed-batch-size 1000',
  containerCleanupVerified: true,
  receiptFinalizedAfterCleanup: true
};
await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o444 });
await chmod(receiptPath, 0o444);
process.stdout.write(`${JSON.stringify({ status: 'PASS', receiptPath, ...receipt })}\n`);
