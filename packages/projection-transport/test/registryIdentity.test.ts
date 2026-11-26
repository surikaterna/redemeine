import { stackDefinitions, stackManifest } from '../integration/realStackFixtures';
import { projectionRegistryDigest } from '../src/registryDigest';
import { normalizeProjectionRegistryDefinitions, projectionRuntimeConfigurationDigest } from '../src/registryIdentity';

test('retains the audited immutable live queue identity after extracting migration-only tooling', () => {
  const manifest = stackManifest('redemeine_accepted_stack_1790240045747.empty');
  expect(manifest.manifestId).toBe('sha256:68a73fd005afbda06d3973582794fefa016978397b8b6a5f56dd2afbe97df6bc');
  expect(manifest.identity.normalizedRuntimeConfigurationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(projectionRegistryDigest({}, 'test')).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test('runtime identity binds history enabling and its logical target collection', () => {
  const entries = stackDefinitions();
  const configurations = entries.map(() => ({}));
  const normalize = (projectionChanges?: string) => normalizeProjectionRegistryDefinitions(entries.map((entry, index) =>
    index === 0 && projectionChanges !== undefined ? { ...entry, projectionChanges } : entry), configurations);
  expect(normalize()[0]).not.toHaveProperty('projectionChanges');
  expect(normalize('orders')[0]).toMatchObject({ projectionChanges: 'orders' });
  expect(new Set([normalize(), normalize('orders'), normalize('other')].map(projectionRuntimeConfigurationDigest)).size).toBe(3);
});
