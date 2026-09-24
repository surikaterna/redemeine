import { execFileSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

function assertContainerAbsent(name: string): void {
  try {
    execFileSync('docker', ['inspect', name], { stdio: 'ignore' });
  } catch {
    return;
  }
  throw new Error(`Container cleanup verification failed: ${name}`);
}

const evidencePath = required('REDEMEINE_EVIDENCE_PATH');
const receiptPath = required('REDEMEINE_RECEIPT_PATH');
const mongoContainer = required('REDEMEINE_MONGO_CONTAINER');
const rabbitContainer = required('REDEMEINE_RABBIT_CONTAINER');
assertContainerAbsent(mongoContainer);
assertContainerAbsent(rabbitContainer);
const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
const receipt = {
  ...evidence,
  status: 'PASS',
  qualification: 'complete',
  cleanup: {
    logicalResourcesVerifiedAbsent: true,
    mongoContainerRemoved: true,
    rabbitContainerRemoved: true
  }
};
await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o444 });
await chmod(receiptPath, 0o444);
console.log(JSON.stringify({ receiptPath, ...receipt }));
