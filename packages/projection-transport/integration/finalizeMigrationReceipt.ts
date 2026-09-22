import { chmod, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const evidence = JSON.parse(await readFile(process.env.REDEMEINE_EVIDENCE_PATH!, 'utf8')) as Record<string, unknown>;
const container = process.env.REDEMEINE_MONGO_CONTAINER!;
const names = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\n');
if (names.includes(container)) throw new Error('Migration Mongo container cleanup failed.');
const receipt = { ...evidence, mongoImage: process.env.REDEMEINE_MONGO_DIGEST, mongoContainerRemoved: true, receiptFinalizedAfterCleanup: true };
const path = process.env.REDEMEINE_RECEIPT_PATH!;
await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o444 }); await chmod(path, 0o444);
process.stdout.write(`${JSON.stringify({ status: 'PASS', receiptPath: path, ...receipt })}\n`);
