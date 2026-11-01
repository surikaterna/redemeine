import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('native image optional metadata, strict required capabilities and safe refusal facts', () => {
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(__dirname, 'support/mainImageMetadata.test.mjs')],
    { cwd: join(__dirname, '../../..'), encoding: 'utf8', timeout: 10000 });
  expect(child.status).toBe(0); expect(child.signal).toBeNull(); expect(child.stderr).toBe('');
  expect(child.stdout).toMatch(/# fail 0/); expect(child.stdout).toMatch(/# cancelled 0/);
});
