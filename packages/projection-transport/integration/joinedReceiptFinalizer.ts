import { chmod, readFile, stat, unlink, writeFile } from 'node:fs/promises';

export interface JoinedReceiptFileOps {
  read(path: string): Promise<string>;
  writeExclusive(path: string, contents: string): Promise<void>;
  makeReadOnly(path: string): Promise<void>;
  mode(path: string): Promise<number>;
  remove(path: string): Promise<void>;
}

export const joinedReceiptFileOps: JoinedReceiptFileOps = {
  read: (path) => readFile(path, 'utf8'),
  writeExclusive: (path, contents) => writeFile(path, contents, { flag: 'wx', mode: 0o444 }),
  makeReadOnly: (path) => chmod(path, 0o444),
  mode: async (path) => (await stat(path)).mode & 0o777,
  remove: (path) => unlink(path)
};

export async function finalizeJoinedReceipt(evidencePath: string, receiptPath: string, sha: string,
  operations: JoinedReceiptFileOps = joinedReceiptFileOps): Promise<void> {
  const evidence = JSON.parse(await operations.read(evidencePath)) as Record<string, unknown>;
  if (evidence.gitSha !== sha || evidence.mongoUsersAndDatabaseCleaned !== true
    || evidence.queuesAndExchangesDeleted !== true || !Array.isArray(evidence.cases) || evidence.cases.length < 20) {
    throw new Error('Incomplete focused evidence.');
  }
  let created = false;
  try {
    await operations.writeExclusive(receiptPath, JSON.stringify({ ...evidence, containersRemoved: true }));
    created = true;
    await operations.makeReadOnly(receiptPath);
    if (await operations.mode(receiptPath) !== 0o444) throw new Error('Focused receipt mode is not 0444.');
  } catch (error) {
    if (created) {
      try { await operations.remove(receiptPath); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to finalize and remove incomplete focused receipt.');
      }
    }
    throw error;
  }
}
