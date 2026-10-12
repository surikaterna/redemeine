import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerifiedArtifact } from '../src/artifact';
import { fixtureRegistryDigest } from '../src/fixtureRegistry';
import { artifactDirectory, builtArtifact } from './fixtures';

test('identity binds actual executable bytes, fixed registration and copied dependency-lock digest', async () => {
  const artifact = await builtArtifact();
  const receipt = JSON.parse(await readFile(join(artifactDirectory, 'artifact.json'), 'utf8'));
  const main = await readFile(join(artifactDirectory, 'main.js'));
  expect(receipt.files['main.js']).toBe(createHash('sha256').update(main).digest('hex'));
  expect(receipt.inputs['src/fixtureRegistry.ts']).toBe(createHash('sha256')
    .update(await readFile(join(__dirname, '../src/fixtureRegistry.ts'))).digest('hex'));
  expect(receipt.inputs['../projection-worker-core/dist/index.js']).toBeDefined();
  expect(Object.keys(receipt.inputs).some((path) => path.endsWith('/mongodb/lib/mongo_client.js'))).toBe(true);
  expect(Object.keys(receipt.inputs).some((path) => path.endsWith('/amqplib/channel_api.js'))).toBe(true);
  expect(artifact.registryDigest).toBe(fixtureRegistryDigest(receipt.digest));
  expect(Object.isFrozen(artifact)).toBe(true);
});

test.each(['main.js', 'build-lock.sha256', 'artifact.json', 'injected.js'])('mutation of %s is refused', async (file) => {
  const root = await mkdtemp(join(tmpdir(), 'projection-artifact-'));
  try {
    await cp(artifactDirectory, root, { recursive: true });
    const path = join(root, file);
    const content = file === 'injected.js' ? '' : await readFile(path, 'utf8');
    const mutated = file === 'artifact.json' ? content.replace('92a2b19d', '00000000') : `${content}\n// mutation`;
    expect(mutated).not.toBe(content);
    await writeFile(path, mutated);
    await expect(VerifiedArtifact.read(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('different built artifact identity cannot reuse registry digest', async () => {
  const artifact = await builtArtifact();
  expect(fixtureRegistryDigest('f'.repeat(64))).not.toBe(artifact.registryDigest);
  expect(() => fixtureRegistryDigest('caller-trusted')).toThrow('artifact_identity_invalid');
});
