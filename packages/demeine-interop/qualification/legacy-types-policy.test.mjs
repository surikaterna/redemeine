import assert from 'node:assert/strict';
import test from 'node:test';
import { assertExceptionScope, classifyLegacyFailure } from './legacy-types-policy.mjs';

const diagnostic =
  "node_modules/demeine/lib/repository/Partition.interfaces.d.ts(1,21): error TS7016: Could not find a declaration file for module 'bluebird'. '/fixture/node_modules/bluebird/index.js' implicitly has an 'any' type.\n";
const failed = (stdout = diagnostic, status = 2) => ({ status, stdout, stderr: '' });

test('default remains blocked and preserves actual compiler failure', () => {
  const result = classifyLegacyFailure(failed(), failed());
  assert.match(result.classification, /^blocked:/);
  assert.equal(result.actualStatus, 2);
  assert.equal(result.diagnostics, diagnostic);
});

test('explicit exception accepts only the known identical failure, not a strict pass', () => {
  for (const status of [1, 2]) {
    const result = classifyLegacyFailure(failed(diagnostic, status), failed(diagnostic, status), true);
    assert.equal(result.classification, 'approved_prerelease_exception: redemeine-p169');
    assert.equal(result.actualStatus, status);
  }
});

test('new, additional, different or missing diagnostics refuse', () => {
  const extra = 'consumer.mts(1,1): error TS2345: incompatible aggregate\n';
  assert.throws(() => classifyLegacyFailure(failed(diagnostic + extra), failed(), true));
  for (const stdout of [
    '',
    diagnostic + extra,
    diagnostic.replace('TS7016', 'TS2307'),
    diagnostic.replace("'bluebird'", "'other'"),
    diagnostic.replace('(1,21)', '(2,21)')
  ]) {
    assert.throws(() => classifyLegacyFailure(failed(stdout), failed(stdout), true));
  }
});

test('compiler crashes, baseline success and unexpected stderr refuse', () => {
  for (const status of [null, 0]) assert.throws(() => classifyLegacyFailure(failed(diagnostic, status), failed(), true));
  assert.throws(() => classifyLegacyFailure(failed(), failed(diagnostic, 0), true));
  assert.throws(() => classifyLegacyFailure(failed(), failed(diagnostic, 1), true));
  assert.throws(() => classifyLegacyFailure({ ...failed(), stderr: 'unexpected' }, failed(), true));
});

test('exception is bound to the reviewed prerelease and legacy package versions', () => {
  const reviewedHash = '71a850cf17ab2e7c604aec6c127488f36e26902c794d2ca13573e0b1aeb03cd8';
  const aggregateHash = '93feb3fac8c8f41ad32049a5850adcd366c483c27513c0173e8f793720418844';
  assert.doesNotThrow(() => assertExceptionScope('1.0.0-pre.2', '1.3.0', reviewedHash, aggregateHash));
  for (const version of ['1.0.0', '1.0.0-pre.3', '2.0.0-pre.2']) assert.throws(() => assertExceptionScope(version, '1.3.0', reviewedHash, aggregateHash));
  assert.throws(() => assertExceptionScope('1.0.0-pre.2', '1.3.1', reviewedHash, aggregateHash));
  assert.throws(
    () => assertExceptionScope('1.0.0-pre.2', '1.3.0', 'bfc5c06950e67884d06c2abd682ec78e2821394d81add4c222621e918bb6c2cf', aggregateHash),
    /Changed artifact bytes/
  );
  for (const hash of [undefined, '', '0'.repeat(64), '719181c2c7fe508eaf79de5253fe110a3cf62a6e26650ff58154ca41e1234cac']) {
    assert.throws(() => assertExceptionScope('1.0.0-pre.2', '1.3.0', hash, aggregateHash), /Changed artifact bytes/);
  }
  for (const hash of [undefined, '', '0'.repeat(64)]) {
    assert.throws(() => assertExceptionScope('1.0.0-pre.2', '1.3.0', reviewedHash, hash), /reviewed Aggregate artifact/);
  }
});
