import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, extname, normalize } from 'node:path';

export async function definitionFile(path: string) {
  if (!isAbsolute(path) || normalize(path) !== path || extname(path) !== '.mjs' || path.length > 4096 || await realpath(path) !== path) throw new Error('invalid_definition_file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat(); if (!before.isFile() || before.size < 1 || before.size > 4194304) throw new Error('definition_file_capacity');
    const buffer = Buffer.alloc(4194305); let bytes = 0;
    for (;;) { const read = await file.read(buffer, bytes, buffer.length - bytes, bytes); bytes += read.bytesRead; if (read.bytesRead === 0 || bytes === buffer.length) break; }
    const after = await file.stat(); const current = await lstat(path);
    if (bytes !== before.size || bytes > 4194304 || after.size !== before.size || current.size !== after.size
      || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
      || current.isSymbolicLink()) throw new Error('definition_file_changed');
    return Object.freeze({ hash: createHash('sha256').update(buffer.subarray(0, bytes)).digest('hex'),
      dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs });
  } finally { await file.close(); }
}
