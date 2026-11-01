import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { getuid, platform } from 'node:process';
import { flockHandshake, type FlockSpawner } from './flockHandshake';
import { inspectAncestors, openTrustedDirectory, verifyOwnershipPaths } from './ownershipTrust';

export const productionStateRoot = '/var/lib/redemeine-projection';
export interface Ownership { close(): Promise<void> }
export class OwnershipError extends Error {
  constructor(readonly exitCode: 1 | 73) { super(exitCode === 73 ? 'ownership_contended' : 'ownership_denied'); }
}

class FileOwnership implements Ownership {
  private closing: Promise<void> | undefined;
  constructor(private readonly lock: FileHandle, private readonly directory: FileHandle) {}
  close(): Promise<void> {
    this.closing ??= this.directory.close().then(() => this.lock.close());
    return this.closing;
  }
}

interface OwnershipTestHooks {
  readonly ancestorBoundary?: string;
  readonly spawn?: FlockSpawner;
}

/** Internal injection seam for isolated tests; the production selector never supplies a root or hooks. */
export async function acquireAtRoot(root: string, signal: AbortSignal, hooks: OwnershipTestHooks = {}): Promise<Ownership> {
  if (platform !== 'linux' || !getuid || signal.aborted) throw new OwnershipError(1);
  let directory: FileHandle | undefined;
  let lock: FileHandle | undefined;
  try {
    const uid = getuid();
    const identities = await inspectAncestors(root, uid, hooks.ancestorBoundary);
    directory = await openTrustedDirectory(root, identities);
    lock = await open(`/proc/self/fd/${directory.fd}/owner.lock`, constants.O_NOFOLLOW | constants.O_CREAT | constants.O_RDWR, 0o600);
    await verifyOwnershipPaths(root, uid, directory, lock, identities);
    const code = await flockHandshake(lock.fd, signal, hooks.spawn);
    if (code !== 0) throw new OwnershipError(code === 73 ? 73 : 1);
    await verifyOwnershipPaths(root, uid, directory, lock, identities);
    if (signal.aborted) throw new OwnershipError(1);
    return new FileOwnership(lock, directory);
  } catch (error) {
    await lock?.close().catch(() => undefined);
    await directory?.close().catch(() => undefined);
    throw error instanceof OwnershipError ? error : new OwnershipError(1);
  }
}

export function acquireOwnership(signal: AbortSignal): Promise<Ownership> {
  return acquireAtRoot(productionStateRoot, signal);
}
