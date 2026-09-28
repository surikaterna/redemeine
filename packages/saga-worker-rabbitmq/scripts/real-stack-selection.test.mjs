import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertScenarioEvidence, scenarioHash, selectRealStackSuites } from './real-stack-selection.mjs';

const original = 'saga-real-stack.integration.test.ts';
const intent = 'saga-intent-real.integration.test.ts';
const suite = (name, status = 'passed', count = 1) => ({
  name: `/workspace/integration/${name}`, assertionResults: Array.from({ length: count }, () => ({ status }))
});

test('default and explicit qualification select both suites in canonical order; identity remains isolated', () => {
  const full = { issue: 'redemeine-vpwm.3.3', paths: [original, intent] };
  assert.deepEqual(selectRealStackSuites(undefined), full);
  assert.deepEqual(selectRealStackSuites('redemeine-vpwm.3.3'), full);
  assert.deepEqual(selectRealStackSuites('redemeine-371j.1'),
    { issue: 'redemeine-371j.1', paths: ['saga-identity-real.integration.test.ts'] });
  assert.deepEqual(selectRealStackSuites('redemeine-371j.2'),
    { issue: 'redemeine-371j.2', paths: ['saga-identity-real.integration.test.ts'] });
  assert.throws(() => selectRealStackSuites('unknown'), /Unsupported/);
});

test('hash frames both scenario files by name, length, contents and order', async () => {
  const source = name => Buffer.from(name === original ? 'first' : 'second');
  const expected = createHash('sha256').update(original).update('\0').update('5').update('\0').update('first')
    .update(intent).update('\0').update('6').update('\0').update('second').digest('hex');
  assert.equal(await scenarioHash([original, intent], source), expected);
  assert.notEqual(await scenarioHash([intent, original], source), expected);
  assert.notEqual(await scenarioHash([original], source), expected);
});

test('no empty, skipped, failed, duplicate, or missing suite can qualify', () => {
  const paths = [original, intent];
  assert.doesNotThrow(() => assertScenarioEvidence({ testResults: [suite(original, 'passed', 13), suite(intent, 'passed', 10)] }, paths));
  for (const results of [[suite(original)], [suite(original), suite(original)],
    [suite(original), suite(intent, 'passed', 0)], [suite(original), suite(intent, 'pending')],
    [suite(original), suite(intent, 'failed')], [suite(original), suite('other')]]) {
    assert.throws(() => assertScenarioEvidence({ testResults: results }, paths));
  }
  assert.throws(() => assertScenarioEvidence(null, paths));
});
