import assert from 'node:assert/strict';

export const legacyExceptionFlag = '--allow-legacy-bluebird-baseline';

export function assertExceptionScope(version, legacyVersion, sha256, aggregateSha256) {
  assert.equal(version, '1.0.0-pre.2', 'Legacy exception requires a newly reviewed scope for other candidates');
  assert.equal(legacyVersion, '1.3.0', 'Legacy exception is limited to published Demeine 1.3.0');
  assert.equal(
    sha256,
    'bfc5c06950e67884d06c2abd682ec78e2821394d81add4c222621e918bb6c2cf',
    'Changed artifact bytes require renewed exception review; version equality is insufficient'
  );
  assert.equal(
    aggregateSha256,
    '93feb3fac8c8f41ad32049a5850adcd366c483c27513c0173e8f793720418844',
    'Legacy exception requires the reviewed Aggregate artifact, not a registry fallback or replacement'
  );
}

export function classifyLegacyFailure(actual, baseline, allowException = false) {
  assert(actual.status > 0 && baseline.status > 0, 'Unexpected legacy compiler termination');
  assert.equal(actual.status, baseline.status, 'Legacy compiler exit statuses differ');
  assert.equal(actual.stdout, baseline.stdout, 'New diagnostics differ from the real legacy-only baseline');
  assert.equal(actual.stderr, '', 'Unexpected legacy compiler stderr');
  assert.equal(baseline.stderr, '', 'Unexpected legacy baseline stderr');
  const diagnostics = actual.stdout.split('\n').filter((line) => /error TS\d+:/.test(line));
  assert.equal(diagnostics.length, 1, 'Only the single known legacy declaration error is permitted');
  assert.match(
    diagnostics[0],
    /^node_modules\/demeine\/lib\/repository\/Partition\.interfaces\.d\.ts\(1,21\): error TS7016: Could not find a declaration file for module 'bluebird'\./
  );
  return {
    actualStatus: actual.status,
    baselineStatus: baseline.status,
    classification: allowException
      ? 'approved_prerelease_exception: redemeine-p169'
      : 'blocked: real legacy declaration prerequisites missing; not a strict compatibility pass',
    diagnostics: actual.stdout
  };
}
