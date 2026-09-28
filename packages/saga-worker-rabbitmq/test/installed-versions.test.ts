import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const workerDirectory = join(__dirname, '..');
const workerRequire = createRequire(join(workerDirectory, 'scripts', 'installed-versions.mjs'));
const moduleDirectory = dirname(workerRequire.resolve('mongodb'));
const installedManifest = JSON.parse(readFileSync(join(moduleDirectory, '..', 'package.json'), 'utf8')) as {
  version: string;
};

function evaluate(expression: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { installedPackageVersion, receiptPackageVersions } from './scripts/installed-versions.mjs'; ${expression}`
  ], { cwd: workerDirectory, encoding: 'utf8' });
}

describe('real-stack receipt dependency versions (no Docker)', () => {
  it('reports the worker-resolved MongoDB package version', () => {
    const result = evaluate('console.log(JSON.stringify(receiptPackageVersions()))');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mongodbDriver: installedManifest.version });
  });

  it('rejects a pinned expectation that differs from the resolved version', () => {
    const result = evaluate("installedPackageVersion('mongodb', '0.0.0')");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`mongodb resolved ${installedManifest.version}, expected 0.0.0`);
  });
});
