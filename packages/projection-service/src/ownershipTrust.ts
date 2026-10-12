import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

interface DirectoryIdentity { path: string; identity: Stats }

export function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function checkDirectory(info: Stats, uid: number, final: boolean): void {
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0
    || (info.uid !== 0 && info.uid !== uid) || (final && (info.uid !== uid || (info.mode & 0o7777) !== 0o700))) {
    throw new Error('ownership_path_untrusted');
  }
}

export async function inspectAncestors(root: string, uid: number, boundary = '/'): Promise<DirectoryIdentity[]> {
  if (resolve(root) !== root || root === boundary || !root.startsWith(boundary === '/' ? '/' : `${boundary}/`)) {
    throw new Error('ownership_path_untrusted');
  }
  const paths: string[] = [];
  for (let path = root; path !== boundary; path = dirname(path)) paths.unshift(path);
  if (boundary === '/') paths.unshift('/');
  const identities: DirectoryIdentity[] = [];
  for (const path of paths) {
    const identity = await lstat(path);
    checkDirectory(identity, uid, path === root);
    identities.push({ path, identity });
  }
  return identities;
}

export async function openTrustedDirectory(root: string, identities: readonly DirectoryIdentity[]): Promise<FileHandle> {
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const original = identities.at(-1);
    if (!original || !sameInode(original.identity, await handle.stat())) throw new Error('ownership_directory_changed');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function verifyOwnershipPaths(root: string, uid: number, directory: FileHandle, lock: FileHandle,
  identities: readonly DirectoryIdentity[]): Promise<void> {
  for (const original of identities) {
    const current = await lstat(original.path);
    checkDirectory(current, uid, original.path === root);
    if (!sameInode(current, original.identity)) throw new Error('ownership_directory_changed');
  }
  const pathDirectory = await lstat(root);
  if (!sameInode(pathDirectory, await directory.stat())) throw new Error('ownership_directory_changed');
  const pathLock = await lstat(join(root, 'owner.lock'));
  const fdLock = await lock.stat();
  if (!pathLock.isFile() || pathLock.isSymbolicLink() || !sameInode(pathLock, fdLock)
    || !fdLock.isFile() || fdLock.uid !== uid || (fdLock.mode & 0o7777) !== 0o600 || fdLock.nlink !== 1) {
    throw new Error('ownership_lock_untrusted');
  }
}
