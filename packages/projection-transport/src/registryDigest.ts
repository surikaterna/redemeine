import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import type { ProjectionSha256Digest } from '@redemeine/projection-runtime-core';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function frame(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  return length;
}

export function projectionRegistryDigest(value: unknown, domain: string): ProjectionSha256Digest {
  const hash = createHash('sha256');
  const domainBytes = new TextEncoder().encode(domain);
  const payload = new TextEncoder().encode(stableJson(BSON.EJSON.serialize(value, { relaxed: false })));
  hash.update(frame(domainBytes)).update(domainBytes).update(frame(payload)).update(payload);
  return `sha256:${hash.digest('hex')}`;
}
