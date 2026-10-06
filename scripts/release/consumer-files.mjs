import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { safePath } from './artifacts.mjs';
import { demand } from './consumer-schema.mjs';
import { hash } from './workspace.mjs';

export async function noLinks(path) {
  demand(isAbsolute(path), 'Absolute input path required');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    demand(!(await lstat(current)).isSymbolicLink(), 'Symlink in input path');
  }
  return realpath(path);
}

export async function boundedRead(path, limit) {
  await noLinks(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    demand(before.isFile() && before.size <= limit, 'Input must be a bounded regular file');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    demand(
      offset === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
      'Input changed during snapshot'
    );
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function containedRead(root, path, limit) {
  demand(safePath(path), 'Unsafe relative evidence path');
  const target = await noLinks(resolve(root, path));
  const rel = relative(root, target);
  demand(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'Evidence path escapes input');
  return boundedRead(target, limit);
}

export async function snapshotFile(state, path, expected, limit) {
  demand(!state.paths.has(path), 'Duplicate evidence path');
  state.paths.add(path);
  const bytes = await containedRead(state.root, path, limit);
  state.total += bytes.length;
  demand(state.total <= 256 * 1024 * 1024, 'Snapshot exceeds total byte limit');
  demand(hash(bytes) === expected, 'Input evidence digest mismatch');
  const target = resolve(state.output, `${state.paths.size}.bin`);
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  demand(hash(await boundedRead(target, limit)) === expected, 'Copied evidence digest mismatch');
  return { path, copy: target, sha256: expected, size: bytes.length, bytes };
}

export async function newSnapshot(root, output) {
  await mkdir(output, { mode: 0o700 });
  return { root: await noLinks(root), output, paths: new Set(), total: 0 };
}
