import { createHash, type Hash } from 'node:crypto';
import type { ProjectionSha256Digest } from '@redemeine/projection-runtime-core';
import { BSON } from 'mongodb';

function canonical(value: unknown): string {
  const serialized = BSON.EJSON.serialize(value, { relaxed: false });
  return stableJson(serialized);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export class ProjectionMigrationStreamingDigest {
  private readonly hash: Hash;
  private countValue = 0;
  private bytesValue = 0;

  constructor(domain: string) {
    this.hash = createHash('sha256');
    this.frame(new TextEncoder().encode(domain));
  }

  update(value: unknown): void {
    const bytes = new TextEncoder().encode(canonical(value));
    this.frame(bytes);
    this.countValue += 1;
    this.bytesValue += bytes.byteLength;
  }

  finish(): { digest: ProjectionSha256Digest; count: number; bytes: number } {
    return { digest: `sha256:${this.hash.digest('hex')}`, count: this.countValue, bytes: this.bytesValue };
  }

  private frame(bytes: Uint8Array): void {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    this.hash.update(length).update(bytes);
  }
}

export function projectionMigrationDigest(value: unknown, domain = 'redemeine:migration:value:v2'): ProjectionSha256Digest {
  const digest = new ProjectionMigrationStreamingDigest(domain);
  digest.update(value);
  return digest.finish().digest;
}

export function projectionMigrationManifestPayload(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { manifestDigest: _manifestDigest, ...payload } = value;
  return payload;
}
