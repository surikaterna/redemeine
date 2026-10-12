import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';

const artifact = JSON.parse(await readFile('dist-worker/artifact.json', 'utf8'));
const packages = new Map();
for (const input of Object.keys(artifact.inputs)) {
  let path = dirname(resolve(input));
  while (path !== dirname(path)) {
    try {
      const meta = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      if (meta.name) { packages.set(path, meta); break; }
    } catch { /* Inputs may sit below directories without package metadata. */ }
    path = dirname(path);
  }
}
await mkdir('dist-worker/licenses', { recursive: true });
const notices = [];
for (const [path, meta] of packages) {
  const licenses = (await readdir(path)).filter((name) => /^(license|licence|notice|copying)([._-]|$)/i.test(name));
  for (const name of licenses) {
    if (!(await stat(join(path, name))).isFile()) continue;
    const target = `${String(meta.name).replace(/[^a-z0-9._-]/gi, '_')}-${basename(name)}`;
    await writeFile(join('dist-worker/licenses', target), await readFile(join(path, name)));
  }
  notices.push({ name: meta.name, version: meta.version, license: meta.license ?? 'see package notice', files: licenses });
}
await writeFile('dist-worker/licenses/DEPENDENCIES.json', JSON.stringify(notices, null, 2) + '\n');
