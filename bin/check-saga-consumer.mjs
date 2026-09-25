import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'redemeine-saga-consumer-'));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });

try {
  run('pnpm', ['--dir', join(root, 'packages/saga'), 'pack', '--pack-destination', temp]);
  const tarball = join(temp, readdirSync(temp).find((name) => name.endsWith('.tgz')));
  writeFileSync(join(temp, 'package.json'), '{"name":"saga-installed-consumer","private":true,"type":"module"}');
  writeFileSync(join(temp, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true },
    files: ['consumer.mts', 'intent-consumer.mts']
  }));
  copyFileSync(join(root, 'packages/saga/test/consumer-start-dispatch.mts'), join(temp, 'consumer.mts'));
  copyFileSync(join(root, 'packages/saga-runtime/test/intent-consumer.mts'), join(temp, 'intent-consumer.mts'));
  const scope = join(temp, 'node_modules/@redemeine');
  const installed = join(scope, 'saga');
  mkdirSync(installed, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1']);
  symlinkSync(join(root, 'node_modules/immer'), join(temp, 'node_modules/immer'), 'dir');
  run(join(root, 'node_modules/.bin/tsc'), ['-p', join(temp, 'tsconfig.json')]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
