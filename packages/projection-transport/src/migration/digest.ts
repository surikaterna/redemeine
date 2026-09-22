import { createHash } from 'node:crypto';
import type { ProjectionSha256Digest } from '@redemeine/projection-runtime-core';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function projectionMigrationDigest(value: unknown): ProjectionSha256Digest {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

export function projectionMigrationManifestPayload(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { manifestDigest: _manifestDigest, ...payload } = value;
  return payload;
}
