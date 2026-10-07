import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, '.cache/demeine-interop');
const snapshot = resolve(output, 'candidate');
const candidates = ['kernel', 'aggregate', 'demeine-interop', 'mirage'];
const run = (tool, args, cwd = root, env = process.env) => execFileSync(tool, args, { cwd, env, stdio: 'inherit' });
const pnpm = (args, cwd = root) => run('pnpm', ['--config.verify-deps-before-run=false', ...args], cwd);

pnpm([...candidates.flatMap(name => ['--filter', `@redemeine/${name}`]), 'build'], snapshot);
const approved = [];
for (const name of candidates) {
  const manifest = JSON.parse(await readFile(resolve(snapshot, 'packages', name, 'package.json')));
  approved.push(`${manifest.name}@${manifest.version}`);
}
const artifacts = resolve(output, 'artifacts');
await rm(artifacts, { recursive: true, force: true });
run('node', ['scripts/release/simple.mjs', 'check', artifacts], snapshot, {
  ...process.env, APPROVED_VERSIONS: approved.join(' '), RELEASE_TAG: 'pre',
});

// Developer-only pack: intentionally NOT passed to release selection while held.
const developer = resolve(output, 'developer');
await mkdir(developer, { recursive: true });
pnpm(['--filter', '@redemeine/cli', 'build']);
pnpm(['pack', '--pack-destination', developer], resolve(root, 'packages/cli'));
const inventory = [];
for (const directory of [artifacts, developer]) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.tgz')) continue;
    const path = resolve(directory, name);
    const bytes = await readFile(path);
    inventory.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` });
  }
}
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeFile(resolve(output, 'inventory.json'), `${JSON.stringify({ sourceBase: source, uncommittedImplementation: true, inventory }, null, 2)}\n`);
await copyFile(resolve(root, 'scripts/release/policy.json'), resolve(output, 'policy.json'));
console.log(JSON.stringify(inventory, null, 2));
