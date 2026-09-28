import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

const require = createRequire(import.meta.url);

export function installedPackageVersion(name, expectedVersion) {
  let directory = dirname(require.resolve(name));
  while (directory !== parse(directory).root) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) {
        if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
          throw new Error(`${name} resolved ${manifest.version}, expected ${expectedVersion}`);
        }
        return manifest.version;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
  throw new Error(`Could not locate installed manifest for ${name}`);
}

export function receiptPackageVersions() {
  return { mongodbDriver: installedPackageVersion('mongodb') };
}
