import { afterEach, expect, test } from '@jest/globals';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeJoinedReceipt, joinedReceiptFileOps } from '../integration/joinedReceiptFinalizer';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function paths(evidence: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'zz6h-finalizer-'));
  directories.push(directory);
  const input = join(directory, 'evidence.json');
  const output = join(directory, 'receipt.json');
  await writeFile(input, JSON.stringify(evidence));
  return { input, output };
}

const validEvidence = { gitSha: 'test-sha', mongoUsersAndDatabaseCleaned: true,
  queuesAndExchangesDeleted: true, cases: Array.from({ length: 20 }, (_, index) => `scenario-${index}`) };

test('creates an exclusive immutable 0444 receipt only after complete evidence', async () => {
  const { input, output } = await paths(validEvidence);
  await finalizeJoinedReceipt(input, output, 'test-sha');
  expect((await stat(output)).mode & 0o777).toBe(0o444);
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ ...validEvidence, containersRemoved: true });
  await expect(finalizeJoinedReceipt(input, output, 'test-sha')).rejects.toMatchObject({ code: 'EEXIST' });
  expect((await stat(output)).mode & 0o777).toBe(0o444);
});

test('invalid SHA or cleanup evidence never creates a successful receipt', async () => {
  const { input, output } = await paths({ ...validEvidence, mongoUsersAndDatabaseCleaned: false });
  await expect(finalizeJoinedReceipt(input, output, 'test-sha')).rejects.toThrow('Incomplete focused evidence');
  await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(input, JSON.stringify(validEvidence));
  await expect(finalizeJoinedReceipt(input, output, 'wrong-sha')).rejects.toThrow('Incomplete focused evidence');
  await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('permission or mode verification failure removes the incomplete receipt', async () => {
  const { input, output } = await paths(validEvidence);
  await expect(finalizeJoinedReceipt(input, output, 'test-sha', {
    ...joinedReceiptFileOps, makeReadOnly: async () => { throw new Error('chmod failed'); }
  })).rejects.toThrow('chmod failed');
  await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(finalizeJoinedReceipt(input, output, 'test-sha', {
    ...joinedReceiptFileOps, mode: async () => 0o644
  })).rejects.toThrow('Focused receipt mode is not 0444');
  await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
});
