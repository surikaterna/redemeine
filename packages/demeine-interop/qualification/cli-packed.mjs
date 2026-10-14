import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x } from 'tar';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const snapshot = resolve(root, '.cache/demeine-interop/developer-smoke');
await rm(snapshot, { recursive: true, force: true });
await mkdir(resolve(snapshot, 'tarballs'), { recursive: true });
await cp(resolve(root, 'package.json'), resolve(snapshot, 'package.json'));
await cp(resolve(root, 'pnpm-workspace.yaml'), resolve(snapshot, 'pnpm-workspace.yaml'));
for (const name of ['kernel', 'aggregate', 'projection', 'cli']) {
  const source = resolve(root, 'packages', name);
  execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'pack', '--pack-destination', resolve(snapshot, 'tarballs')], { cwd: source, stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json')));
  const destination = resolve(snapshot, 'packages', name);
  await mkdir(destination, { recursive: true });
  await x({ file: resolve(snapshot, 'tarballs', `redemeine-${name}-${manifest.version}.tgz`), cwd: destination, strip: 1 });
}
// Run the existing gate against pnpm's real registry-layout manifests, not npm's
// unconverted workspace:* source packs. No held package enters a release plan.
await cp(resolve(root, 'packages/cli/test'), resolve(snapshot, 'packages/cli/test'), { recursive: true });
await writeFile(resolve(snapshot, 'qualification.txt'), 'Developer-only source versions; pnpm pack materializes workspace ranges. No publication.\n');
execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--filter', '@redemeine/cli', 'test:packed'], { cwd: snapshot, stdio: 'inherit' });
