import { isCanonicalProjectionUuid } from './sourceCommit';

export type ProjectionSha256Digest = `sha256:${string}`;

export interface ProjectionRegistryDefinitionManifest {
  readonly projectionName: string;
  readonly generation: string;
  readonly definitionHash: ProjectionSha256Digest;
  readonly sourceSelectors: readonly string[];
}

export interface ProjectionRegistryManifestIdentity {
  readonly version: 1;
  /** Digest of the normalized ordered definitions and selectors; removing a definition changes identity. */
  readonly normalizedDefinitionRegistryDigest: ProjectionSha256Digest;
  readonly normalizedRuntimeConfigurationDigest: ProjectionSha256Digest;
  readonly executableCodeArtifactDigest: ProjectionSha256Digest;
}

export interface ProjectionQueueRegistryManifest {
  readonly version: 1;
  readonly manifestId: ProjectionSha256Digest;
  readonly queueId: string;
  readonly registryGeneration: string;
  readonly identity: ProjectionRegistryManifestIdentity;
  readonly definitions: readonly ProjectionRegistryDefinitionManifest[];
  readonly sourceStartAnchors: Readonly<Record<string, number>>;
}

export interface ProjectionQueueRegistryBinding {
  readonly queueId: string;
  readonly manifestId: ProjectionSha256Digest;
  readonly registryGeneration: string;
  readonly identity: ProjectionRegistryManifestIdentity;
  readonly boundAt: string;
}

export type ProjectionQueueRegistryBindResult =
  | { status: 'bound' | 'matches'; binding: ProjectionQueueRegistryBinding }
  | { status: 'conflict'; existing: ProjectionQueueRegistryBinding; reason: string };

export interface ProjectionQueueRegistryBindingPort {
  bindImmutableManifest(manifest: ProjectionQueueRegistryManifest): Promise<ProjectionQueueRegistryBindResult>;
  readQueueBinding(queueId: string): Promise<ProjectionQueueRegistryBinding | null>;
}

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === Object.keys(value).length;
}

function isNonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isProjectionSha256Digest(value: unknown): value is ProjectionSha256Digest {
  return typeof value === 'string' && SHA256_DIGEST_PATTERN.test(value);
}

function validateSourceSelectors(value: unknown, definitionIndex: number): string[] {
  const path = `definitions[${definitionIndex}].sourceSelectors`;
  if (!Array.isArray(value)) return [path];
  if (value.length === 0) return [`${path}.empty`];
  const issues: string[] = [];
  const normalizedSelectors = new Set<string>();
  for (const [selectorIndex, selector] of value.entries()) {
    const selectorPath = `${path}[${selectorIndex}]`;
    if (!isNonempty(selector)) {
      issues.push(selectorPath);
      continue;
    }
    const normalized = selector.trim();
    if (selector !== normalized) issues.push(`${selectorPath}.normalized`);
    if (normalizedSelectors.has(normalized)) issues.push(`${selectorPath}.duplicate`);
    normalizedSelectors.add(normalized);
  }
  return issues;
}

function validateSourceStartAnchors(value: unknown): string[] {
  if (!isPlainRecord(value)) return ['sourceStartAnchors'];
  const issues: string[] = [];
  const normalizedSourceIds = new Set<string>();
  for (const [sourceId, sequence] of Object.entries(value)) {
    const normalizedSourceId = sourceId.toLowerCase();
    if (!isCanonicalProjectionUuid(sourceId)) issues.push(`sourceStartAnchors.${sourceId}.sourceId`);
    if (normalizedSourceIds.has(normalizedSourceId)) issues.push(`sourceStartAnchors.${sourceId}.duplicate`);
    normalizedSourceIds.add(normalizedSourceId);
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
      issues.push(`sourceStartAnchors.${sourceId}.sequence`);
    }
  }
  return issues;
}

export function validateProjectionQueueRegistryManifest(candidate: unknown): readonly string[] {
  if (!isRecord(candidate)) return ['manifest'];
  const issues: string[] = [];
  if (candidate.version !== 1) issues.push('version');
  if (!isProjectionSha256Digest(candidate.manifestId)) issues.push('manifestId');
  if (!isNonempty(candidate.queueId)) issues.push('queueId');
  if (!isNonempty(candidate.registryGeneration)) issues.push('registryGeneration');
  const identity = isRecord(candidate.identity) ? candidate.identity : {};
  if (!isRecord(candidate.identity)) issues.push('identity');
  if (identity.version !== 1) issues.push('identity.version');
  if (!isProjectionSha256Digest(identity.normalizedDefinitionRegistryDigest)) {
    issues.push('identity.normalizedDefinitionRegistryDigest');
  }
  if (!isProjectionSha256Digest(identity.normalizedRuntimeConfigurationDigest)) {
    issues.push('identity.normalizedRuntimeConfigurationDigest');
  }
  if (!isProjectionSha256Digest(identity.executableCodeArtifactDigest)) {
    issues.push('identity.executableCodeArtifactDigest');
  }
  const definitions = Array.isArray(candidate.definitions) ? candidate.definitions : [];
  if (!Array.isArray(candidate.definitions)) issues.push('definitions');
  const definitionScopes = new Set<string>();
  for (const [index, value] of definitions.entries()) {
    const definition = isRecord(value) ? value : {};
    if (!isRecord(value)) issues.push(`definitions[${index}]`);
    if (!isNonempty(definition.projectionName)) issues.push(`definitions[${index}].projectionName`);
    if (!isNonempty(definition.generation)) issues.push(`definitions[${index}].generation`);
    if (!isProjectionSha256Digest(definition.definitionHash)) issues.push(`definitions[${index}].definitionHash`);
    issues.push(...validateSourceSelectors(definition.sourceSelectors, index));
    const scope = `${String(definition.projectionName)}\u0000${String(definition.generation)}`;
    if (definitionScopes.has(scope)) issues.push(`definitions[${index}].duplicate`);
    definitionScopes.add(scope);
  }
  issues.push(...validateSourceStartAnchors(candidate.sourceStartAnchors));
  return issues;
}

export function hasMatchingProjectionRegistryIdentity(
  manifest: ProjectionQueueRegistryManifest,
  binding: ProjectionQueueRegistryBinding
): boolean {
  return manifest.queueId === binding.queueId
    && manifest.manifestId === binding.manifestId
    && manifest.registryGeneration === binding.registryGeneration
    && manifest.identity.version === binding.identity.version
    && manifest.identity.normalizedDefinitionRegistryDigest === binding.identity.normalizedDefinitionRegistryDigest
    && manifest.identity.normalizedRuntimeConfigurationDigest === binding.identity.normalizedRuntimeConfigurationDigest
    && manifest.identity.executableCodeArtifactDigest === binding.identity.executableCodeArtifactDigest;
}
