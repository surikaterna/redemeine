import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { isProjectionSha256Digest } from '@redemeine/projection-runtime-core';
import { type ProjectionMigrationRuntimeModule, parseProjectionMigrationRuntimeModule } from './runtimeIdentity';

export interface ProjectionMigrationRuntimeArtifact {
  readonly path: string;
  readonly digest: `sha256:${string}`;
  readonly module: ProjectionMigrationRuntimeModule;
  verifyUnchanged(): Promise<void>;
}

export async function loadProjectionMigrationRuntimeArtifact(path: string): Promise<ProjectionMigrationRuntimeArtifact> {
  const before = await inspectProjectionMigrationRuntimeArtifact(path);
  const loaded: unknown = await import(before.path);
  const module = parseProjectionMigrationRuntimeModule(loaded);
  const artifact = {
    path: before.path,
    digest: before.digest,
    module,
    verifyUnchanged: async () => {
      const after = await inspectProjectionMigrationRuntimeArtifact(before.path);
      if (after.digest !== before.digest) throw new Error('Runtime artifact changed during command.');
    }
  };
  await artifact.verifyUnchanged();
  return artifact;
}

export async function inspectProjectionMigrationRuntimeArtifact(path: string): Promise<{ path: string; digest: `sha256:${string}` }> {
  const resolved = await realpath(path);
  if (!['.js', '.mjs'].includes(extname(resolved))) throw new Error('Runtime artifact must be a bundled JavaScript module.');
  const pathStat = await lstat(path, { bigint: true });
  const resolvedStat = await stat(resolved, { bigint: true });
  if (!pathStat.isFile() || !resolvedStat.isFile() || pathStat.dev !== resolvedStat.dev || pathStat.ino !== resolvedStat.ino) {
    throw new Error('Runtime artifact must be a regular non-symlink file.');
  }
  if ((Number(resolvedStat.mode) & 0o222) !== 0) throw new Error('Runtime artifact must be immutable to filesystem writers.');
  const handle = await open(resolved, 'r');
  try {
    const first = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const second = await handle.stat({ bigint: true });
    if (first.dev !== second.dev || first.ino !== second.ino || first.size !== second.size || first.mtimeNs !== second.mtimeNs) {
      throw new Error('Runtime artifact changed while hashing.');
    }
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (!isProjectionSha256Digest(digest)) throw new Error('Runtime artifact digest failed.');
    return { path: resolved, digest };
  } finally {
    await handle.close();
  }
}
