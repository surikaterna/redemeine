import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const runtime = ['@redemeine/aggregate', '@redemeine/kernel', 'zod@^4.3.6'];
const tooling = ['@redemeine/cli', 'typescript', 'vitest'];

export function runInstall(packages: readonly string[], dev: boolean): Promise<void> {
  if (packages.some(name => ![...runtime, ...tooling].includes(name))) throw new Error('Unsupported dependency');
  const pm = existsSync('pnpm-lock.yaml') ? 'pnpm' : existsSync('yarn.lock') ? 'yarn' : 'npm';
  const args = [pm === 'npm' ? 'install' : 'add', ...(dev ? ['-D'] : []), ...packages];
  return new Promise((resolveInstall, reject) => {
    const child = spawn(pm, args, { shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveInstall() : reject(new Error(`Dependency installation failed (${code})`)));
  });
}

export function confirmInstall(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolveConsent => {
    rl.once('close', () => resolveConsent(false));
    rl.question('Install missing dependencies? [y/N] ', answer => {
      resolveConsent(['y', 'yes'].includes(answer.trim().toLowerCase()));
      rl.close();
    });
  });
}

export async function preflight(noInstall: boolean): Promise<void> {
  const path = resolve('package.json');
  if (!existsSync(path)) throw new Error('package.json not found. Run at the root of an existing project.');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  const missingRuntime = runtime.filter(name => !deps[name.split('@^')[0] ?? name]);
  const missingTooling = tooling.filter(name => !deps[name]);
  console.log('Use Zod 4, strict TypeScript and Vitest for the generated tests (adapt imports manually for Jest).');
  if (!missingRuntime.length && !missingTooling.length) return;
  console.log(`Missing dependencies: ${[...missingRuntime, ...missingTooling].join(', ')}`);
  if (noInstall || !process.stdin.isTTY || !process.stdout.isTTY || !await confirmInstall()) return;
  if (missingRuntime.length) await runInstall(missingRuntime, false);
  if (missingTooling.length) await runInstall(missingTooling, true);
}
