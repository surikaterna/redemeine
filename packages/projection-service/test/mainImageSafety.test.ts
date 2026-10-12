import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('native offline packaging supervisor/intent ledger/actual capability regressions, no Docker subprocess', () => {
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(__dirname, 'support/mainImageSafety.test.mjs')],
    { cwd: join(__dirname, '../../..'), encoding: 'utf8', timeout: 15000 });
  expect(child.signal).toBeNull(); expect(child.stderr).toBe(''); expect(child.status).toBe(0);
  expect(child.stdout).toMatch(/# fail 0/); expect(child.stdout).toMatch(/# cancelled 0/);
});
