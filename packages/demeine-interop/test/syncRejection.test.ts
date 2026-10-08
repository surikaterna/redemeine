import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const boundaries = ['eventHandler', 'envelope', 'process', 'apply'];
const failures = ['promise', 'thenable', 'delayed', 'getter', 'throw', 'callable'];

test.each(boundaries.flatMap(boundary => failures.map(failure => [boundary, failure]))) (
  '%s safely rejects %s with strict unhandled-rejection behavior', (boundary, failure) => {
    const result = spawnSync(process.execPath, [
      '--unhandled-rejections=strict', '--no-experimental-require-module', '--import', 'tsx',
      join(__dirname, 'syncRejection.fixture.mjs'), boundary!, failure!,
    ], { encoding: 'utf8', timeout: 10_000 });
    expect({ status: result.status, signal: result.signal, error: result.error, stderr: result.stderr })
      .toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
    expect(result.stdout).toContain(`safe synchronous rejection ${boundary} ${failure}`);
  },
);
