import { validateProjectionQueueRegistryManifest, type ProjectionQueueRegistryManifest } from './registry';
import { isProjectionJsonValue, type ProjectionJsonValue } from './sourceCommit';

/** Compare the manifest contents, not just the caller-supplied ID or individual policies. */
export interface ProjectionDispatchBindingProof {
  readonly version: 1;
  readonly manifest: ProjectionQueueRegistryManifest;
}

export class ProjectionDispatchBindingMismatchError extends Error {
  constructor() {
    super('Immutable projection registry binding mismatch or missing dispatch proof.');
  }
}

function canonicalJson(value: ProjectionJsonValue): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}

export function matchesProjectionDispatchBinding(expected: ProjectionDispatchBindingProof | undefined,
  bound: ProjectionDispatchBindingProof | undefined): boolean {
  if (expected?.version !== 1 || bound?.version !== 1) return false;
  const { manifest: worker } = expected;
  const { manifest: authoritative } = bound;
  return validateProjectionQueueRegistryManifest(worker).length === 0 && validateProjectionQueueRegistryManifest(authoritative).length === 0
    && isProjectionJsonValue(worker) && isProjectionJsonValue(authoritative) && canonicalJson(worker) === canonicalJson(authoritative);
}

export function createProjectionDispatchBindingProof(manifest: ProjectionQueueRegistryManifest): ProjectionDispatchBindingProof {
  if (!isProjectionJsonValue(manifest)) throw new Error('Dispatch manifest must contain plain JSON.');
  // The worker offers the same immutable proof on every admission, even if the caller mutates its original options.
  const proof = { version: 1 as const, manifest: JSON.parse(canonicalJson(manifest)) as ProjectionQueueRegistryManifest };
  const pending: object[] = [proof];
  while (pending.length) {
    const next = pending.pop()!;
    Object.freeze(next);
    for (const value of Object.values(next)) if (value && typeof value === 'object') pending.push(value);
  }
  return proof;
}
