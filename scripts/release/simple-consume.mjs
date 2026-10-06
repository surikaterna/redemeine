import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const job = JSON.parse(await readFile('/job/job.json', 'utf8'));
const report = { node: process.version, commands: [], roots: [], exitCode: 1 };
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/consumer', NODE_OPTIONS: '--max-old-space-size=1536',
  npm_config_userconfig: '/consumer/.npmrc', npm_config_globalconfig: '/consumer/global.npmrc', npm_config_cache: '/consumer/cache'
};

function command(cwd, cmd, args) {
  const result = spawnSync(cmd, args, { cwd, env: { ...env, npm_config_cache: `${cwd}/cache` }, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  report.commands.push({ cmd, args, cwd, status: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 0, `${cmd}: ${result.stdout}\n${result.stderr}`);
}

async function checkLock(directory, root) {
  const lock = JSON.parse(await readFile(`${directory}/package-lock.json`));
  assert.deepEqual(Object.keys(lock.packages[''].dependencies), [root.manifest.name]);
  const owned = Object.entries(lock.packages).filter(([path]) => job.owned.names.some((name) => path.endsWith(`node_modules/${name}`)) ||
    job.owned.scopes.some((scope) => path.includes(`node_modules/${scope}/`)));
  for (const [path, entry] of owned) {
    const artifact = job.artifacts.find((a) => path.endsWith(`node_modules/${a.manifest.name}`) && entry.version === a.manifest.version);
    assert.ok(artifact, `Unqualified dependency: ${path}@${entry.version}`);
    assert.equal(entry.integrity, artifact.integrity);
    assert.ok(entry.resolved.startsWith(job.endpoint), `Registry escape: ${entry.resolved}`);
    assert.ok(!entry.link);
  }
  assert.ok(owned.filter(([path]) => path.endsWith('node_modules/@redemeine/kernel')).length <= 1, 'Duplicate kernel identity');
  report.roots.push({ name: root.manifest.name, owned });
  await copyFile(`${directory}/package-lock.json`, `/job/lock-${report.roots.length}.json`);
}

async function testingFixture(directory) {
  await copyFile('/job/testing-consumer.ts', `${directory}/testing-consumer.ts`);
  const compilerOptions = {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false,
    types: ['node'], typeRoots: ['/opt/consumer-tools/node_modules/@types'], outDir: 'out'
  };
  await writeFile(`${directory}/tsconfig.json`, JSON.stringify({ compilerOptions, files: ['testing-consumer.ts'] }));
  command(directory, 'node', ['/opt/consumer-tools/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']);
  command(directory, 'node', ['/opt/consumer-tools/node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
  command(directory, 'node', ['out/testing-consumer.js']);
}

async function consume(root, index) {
  const directory = `/consumer/root-${index}`;
  await mkdir(directory);
  await writeFile(`${directory}/package.json`, JSON.stringify({ name: 'release-consumer', private: true, type: 'module' }));
  command(directory, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0',
    '--registry', job.endpoint, `${root.manifest.name}@${root.manifest.version}`]);
  command(directory, 'npm', ['ls', '--all']);
  await checkLock(directory, root);
  command(directory, 'node', ['--input-type=module', '-e', `await import(${JSON.stringify(root.manifest.name)})`]);
  if (root.manifest.name === '@redemeine/testing') await testingFixture(directory);
}

try {
  assert.ok(job.endpoint === 'https://registry.npmjs.org/' || /^http:\/\/consumer-[a-f0-9-]+-registry:4873\/$/.test(job.endpoint));
  await mkdir('/consumer', { recursive: true });
  await writeFile('/consumer/.npmrc', `registry=${job.endpoint}\n`);
  await writeFile('/consumer/global.npmrc', '');
  for (const [index, root] of job.roots.entries()) await consume(root, index);
  report.exitCode = 0;
} catch (error) {
  report.error = error.stack;
} finally {
  await writeFile('/job/result.json', JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
