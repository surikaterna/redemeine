import { stackManifest } from '../integration/realStackFixtures';
import { projectionRegistryDigest } from '../src/registryDigest';

test('retains the audited immutable live queue identity after extracting migration-only tooling', () => {
  const manifest = stackManifest('redemeine_accepted_stack_1790240045747.empty');
  expect(manifest.manifestId).toBe('sha256:68a73fd005afbda06d3973582794fefa016978397b8b6a5f56dd2afbe97df6bc');
  expect(manifest.identity.normalizedRuntimeConfigurationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(projectionRegistryDigest({}, 'test')).toMatch(/^sha256:[0-9a-f]{64}$/);
});
