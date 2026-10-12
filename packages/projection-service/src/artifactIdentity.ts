import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const protectedManifest = '92a2b19da875987c819ff3283845839323a9652d522f8d00f0d62ebd5ca0da5e';

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashRecord(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
}

interface Receipt {
  version: 1;
  files: Record<string, string>;
  lockDigest: string;
  inputs: Record<string, string>;
  protectedManifest: string;
  digest: string;
}

function isReceipt(value: unknown): value is Receipt {
  return record(value) && value.version === 1 && hashRecord(value.files) && hashRecord(value.inputs)
    && Object.keys(value.inputs).length > 0 && typeof value.lockDigest === 'string'
    && /^[a-f0-9]{64}$/.test(value.lockDigest) && value.protectedManifest === protectedManifest
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest);
}

async function verifiedDigest(directory: string): Promise<string> {
  if ((await stat(join(directory, 'artifact.json'))).size > 1048576) throw new Error('artifact_receipt_capacity');
  const receipt: unknown = JSON.parse(await readFile(join(directory, 'artifact.json'), 'utf8'));
  if (!isReceipt(receipt)) throw new Error('artifact_receipt_invalid');
  const { version, files, lockDigest, inputs } = receipt;
  const names = (await readdir(directory)).filter((name) => name.endsWith('.js')).sort();
  if (JSON.stringify(names) !== '["main.js"]' || JSON.stringify(Object.keys(files)) !== '["main.js"]') {
    throw new Error('artifact_outputs_mismatch');
  }
  if (sha256(await readFile(join(directory, 'main.js'))) !== files['main.js']
    || (await readFile(join(directory, 'build-lock.sha256'), 'utf8')) !== `${lockDigest}\n`
    || sha256(JSON.stringify({ version, files, lockDigest, inputs, protectedManifest })) !== receipt.digest) {
    throw new Error('artifact_identity_mismatch');
  }
  return receipt.digest;
}

/** Integrity identity, not publisher trust or a signature against a malicious artifact owner. */
export class SealedArtifact {
  private constructor(private readonly identity: string) {
    Object.freeze(this);
  }

  get digest(): string { return this.identity; }

  static async read(directory: string): Promise<SealedArtifact> {
    return new SealedArtifact(await verifiedDigest(directory));
  }
}
