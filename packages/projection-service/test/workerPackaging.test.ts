import { readFile, readdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SealedArtifact } from '../src/artifactIdentity';

const root = join(__dirname, '../../..'); const service = join(__dirname, '..');
test('independent worker seal and metafile exclude fixture/reference/integration graphs', async () => {
  const artifact = await SealedArtifact.read(join(service, 'dist-worker')); expect(artifact.digest).toMatch(/^[a-f0-9]{64}$/);
  const meta = JSON.parse(await readFile(join(service, 'dist-worker/metafile-esm.json'), 'utf8'));
  expect(Object.keys(meta.inputs).join('\n')).not.toMatch(/fixtureRegistry|referenceRegistry|mongoFixtures|src\/reference\/|\/test\/|\/integration\//);
  expect((await readFile(join(service, 'dist-worker/main.js'), 'utf8'))).not.toContain('ModelCounter');
  const config = JSON.parse(await readFile(join(service, 'turbo.json'), 'utf8'));
  expect(config.tasks.build.outputs).toEqual(['dist/**', 'dist-worker/**']);
  const notices = JSON.parse(await readFile(join(service, 'dist-worker/licenses/DEPENDENCIES.json'), 'utf8'));
  expect(notices.find((entry: { name: string }) => entry.name === 'punycode').files).toContain('LICENSE-MIT.txt');
  expect((await readdir(join(service, 'dist-worker/licenses'))).length).toBeGreaterThan(10);
});

test('Git-free build blob hashes match Git for every protected input and binary/nonASCII samples', async () => {
  const script = join(service, 'scripts/artifact-inputs.mjs');
  const lines = (await readFile(join(service, 'scripts/protected-runtime.manifest'), 'utf8')).trimEnd().split('\n');
  for (const line of lines) {
    const [expected, path] = line.split('  '); if (!path) throw new Error('invalid_manifest');
    const bytes = await readFile(join(root, path));
    expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')).toBe(expected);
  }
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `import {gitBlob} from ${JSON.stringify(script)};console.log(gitBlob(Buffer.from([0,255,128,13,10])));`], { encoding: 'utf8' });
  const git = spawnSync('git', ['hash-object', '--stdin'], { input: Buffer.from([0, 255, 128, 13, 10]), encoding: 'utf8', cwd: root });
  expect(probe.status).toBe(0); expect(probe.stdout.trim()).toBe(git.stdout.trim());
});

test('worker output mutation refuses and sealer cannot select an arbitrary output directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-seal-'));
  try {
    for (const name of ['main.js', 'artifact.json', 'build-lock.sha256']) await writeFile(join(directory, name), await readFile(join(service, 'dist-worker', name)));
    await writeFile(join(directory, 'main.js'), 'modified'); await expect(SealedArtifact.read(directory)).rejects.toThrow('artifact_identity_mismatch');
    const refused = spawnSync(process.execPath, ['scripts/seal-artifact.mjs', '../arbitrary'], { cwd: service, encoding: 'utf8' });
    expect(refused.status).toBe(1); expect(refused.stderr).toContain('artifact_directory_refused');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('main Dockerfile is nonroot/signal-forwarding/worker-only and context excludes nested secrets; no Docker executed', async () => {
  const dockerfile = await readFile(join(service, 'Dockerfile'), 'utf8');
  const final = dockerfile.slice(dockerfile.indexOf('AS runtime'));
  expect(final).toContain('USER 10001:10001'); expect(final).toContain('STOPSIGNAL SIGTERM');
  expect(final).toContain('"/usr/bin/tini", "-g", "--", "node", "/app/main.js"');
  expect(final).toContain('0700 /var/lib/redemeine-projection'); expect(final).toContain('util-linux tini ca-certificates');
  expect(final).toContain('rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-*');
  expect(final).not.toMatch(/socat|qualification-entry|integration\/Projection|dist\/main\.js|examples\/|npm install|pnpm install/);
  const ignore = await readFile(join(root, '.dockerignore'), 'utf8');
  for (const pattern of ['**/.git', '**/.beads', '**/worktrees', '**/node_modules', '**/.env*', '**/.npmrc*', '**/*.key', '**/*.pem']) expect(ignore).toContain(pattern);
  expect(dockerfile).toContain('pnpm install --frozen-lockfile'); expect(dockerfile).toContain('pnpm@11.9.0');
  expect(createHash('sha256').update(await readFile(join(root, '.github/workflows/publish.yml'))).digest('hex')).toBe('c85ceff42da7f74f9e0d9bd10a513688eb9879efa3eb187532575238b48d9911');
});

test('final-stage instruction order normalizes exactly four trusted payload files before nonroot USER', async () => {
  const dockerfile = await readFile(join(service, 'Dockerfile'), 'utf8');
  const instructions = dockerfile.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    .map((line) => ({ opcode: line.split(/\s/, 1)[0] ?? '', args: line.replace(/^\S+\s*/, '') }));
  const stage = instructions.findIndex(({ opcode, args }) => opcode === 'FROM' && args.endsWith(' AS runtime'));
  expect(stage).toBeGreaterThan(0);
  const final = instructions.slice(stage + 1);
  const chmod = 'chmod 0644 /app/main.js /app/artifact.json /app/build-lock.sha256 /app/package.json';
  const permission = final.findIndex(({ opcode, args }) => opcode === 'RUN' && args === chmod);
  const user = final.findIndex(({ opcode }) => opcode === 'USER');
  expect(permission).toBeGreaterThan(final.findIndex(({ opcode }) => opcode === 'COPY'));
  expect(permission).toBe(final.map(({ opcode }) => opcode).lastIndexOf('COPY') + 1);
  expect(user).toBe(permission + 1); expect(final[user]?.args).toBe('10001:10001');
  expect(final.filter(({ opcode, args }) => opcode === 'RUN' && /\b(?:chmod|chown)\b/.test(args)))
    .toEqual([{ opcode: 'RUN', args: chmod }]);
  expect(final.filter(({ opcode }) => opcode === 'COPY').every(({ args }) => args.startsWith('--from=build ') && !args.includes('--chown'))).toBe(true);
  for (const name of ['artifact.json', 'build-lock.sha256']) {
    expect((await stat(join(service, 'dist-worker', name))).mode & 0o777).toBe(0o600);
  }
});

test('host worker remains executable while final image explicitly invokes Node on non-executable code', async () => {
  const main = join(service, 'dist-worker/main.js');
  expect((await stat(main)).mode & 0o777).toBe(0o755);
  expect((await readFile(main, 'utf8')).startsWith('#!/usr/bin/env node')).toBe(true);
  const pkg = JSON.parse(await readFile(join(service, 'package.json'), 'utf8'));
  expect(pkg.bin['projection-worker']).toBe('./dist-worker/main.js');
  const dockerfile = await readFile(join(service, 'Dockerfile'), 'utf8');
  expect(dockerfile).toContain('RUN chmod 0644 /app/main.js /app/artifact.json /app/build-lock.sha256 /app/package.json');
  expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "/app/main.js"]');
});
