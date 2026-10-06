import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { isExpectedCliCoverage } from './real-control-verdict.mjs';

function expectedReport() {
  const consumers = ['22.23.3', '24.20.0'].map((node) => ({
    node,
    exitCode: 2,
    failureKind: 'coverage-incomplete',
    identity: { id: `consumer-${node}` },
    phases: { install: 'passed', installedGraph: 'passed', cliApi: 'passed', cliDeclarations: 'passed' },
    cliGeneration: {
      status: 'blocked',
      reason: 'missing-prerequisites',
      missing: ['@redemeine/aggregate'],
      input: 'not-run',
      extraction: 'not-run',
      generatedTypes: 'not-run',
      schemaBehavior: 'not-run'
    }
  }));
  return {
    exitCode: 2,
    complete: false,
    error: 'Consumer matrix did not fully qualify; all runtime/root outcomes retained',
    cleanup: { complete: true, failures: [] },
    staging: { exitCode: 0, receipts: [{}, {}] },
    consumers,
    resourceOutcomes: [
      { id: 'registry', running: true, oomKilled: false, exitCode: 0 },
      ...consumers.map((consumer) => ({ id: consumer.identity.id, running: false, oomKilled: false, exitCode: 2 }))
    ]
  };
}

const mutations = {
  'cleanup failed': (r) => {
    r.cleanup = { complete: false, failures: [{ resource: 'registry', operation: 'cleanup' }] };
  },
  'cleanup missing': (r) => {
    delete r.cleanup;
  },
  'cleanup evidence incomplete': (r) => {
    r.cleanup = { complete: true };
  },
  'cleanup failure contradicts complete': (r) => {
    r.cleanup.failures.push({ resource: 'registry', operation: 'cleanup' });
  },
  'malformed cleanup failures': (r) => {
    r.cleanup.failures = false;
  },
  interrupted: (r) => {
    r.interrupted = 'SIGTERM';
  },
  'signal recorded': (r) => {
    r.signal = 'SIGINT';
  },
  'arbitrary overall error': (r) => {
    r.error = 'Registry infrastructure validation failed';
  },
  'missing expected matrix error': (r) => {
    delete r.error;
  },
  'independent infrastructure kind': (r) => {
    r.failureKind = 'infrastructure';
  },
  'independent infrastructure marker': (r) => {
    r.infrastructureFailure = true;
  },
  'independent failures': (r) => {
    r.failures = ['transport'];
  },
  'stage failure with retained consumers': (r) => {
    r.staging.exitCode = 2;
  },
  'transport failure': (r) => {
    r.consumers[0].failureKind = 'infrastructure';
  },
  'missing runtime': (r) => {
    r.consumers.pop();
  },
  'duplicate runtime': (r) => {
    r.consumers[1].node = r.consumers[0].node;
  },
  'consumer exit contradicts blocker': (r) => {
    r.consumers[0].exitCode = 1;
  },
  'contradictory complete report': (r) => {
    r.complete = true;
  },
  'registry aborted after consumers': (r) => {
    r.resourceOutcomes[0].exitCode = 134;
  },
  'resource OOM': (r) => {
    r.resourceOutcomes[0].oomKilled = true;
  }
};

function executeControl(report) {
  const code = `import {mock} from 'node:test';
    const report=${JSON.stringify(report)};
    mock.module('node:fs/promises',{namedExports:{cp:async()=>{},mkdtemp:async()=>'/virtual/control',
      readFile:async()=>Buffer.from('{}'),rm:async()=>{},writeFile:async()=>{}}});
    mock.module(${JSON.stringify(new URL('../check.mjs', import.meta.url).href)},
      {namedExports:{audit:(()=>{let calls=0;return async()=>calls++===0?1:0;})()}});
    mock.module(${JSON.stringify(new URL('../consumer.mjs', import.meta.url).href)},
      {namedExports:{qualify:(()=>{let calls=0;return async()=>calls++===0?
        {exitCode:1,staging:{receipts:[]},consumers:[]}:report;})()}});
    mock.module(${JSON.stringify(new URL('../test/fixtures.mjs', import.meta.url).href)},
      {namedExports:{repo:'/virtual/repo',put:async()=>{},workspace:async()=>({root:'/virtual/fixture'})}});
    mock.module(${JSON.stringify(new URL('../workspace.mjs', import.meta.url).href)},
      {namedExports:{hash:()=> '0'.repeat(64)}});
    await import(${JSON.stringify(new URL('./real-controls.mjs', import.meta.url).href)});`;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  assert.ifError(result.error);
  return result;
}

test('F4 actual control accepts only clean two-runtime coverage blockers; qualification stays2', () => {
  const report = expectedReport();
  assert.equal(isExpectedCliCoverage(report), true);
  const result = executeControl(report);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"b":2/);
  assert.equal(report.exitCode, 2);
});

for (const [name, mutate] of Object.entries(mutations)) {
  test(`F4 actual control rejects ${name} despite expected consumer blockers`, () => {
    const report = expectedReport();
    mutate(report);
    assert.equal(isExpectedCliCoverage(report), false);
    const result = executeControl(report);
    assert.equal(result.status, 2, result.stderr);
  });
}

test('F4 malformed predicate inputs fail closed', () => {
  for (const report of [null, undefined, {}, { ...expectedReport(), consumers: null }]) assert.equal(isExpectedCliCoverage(report), false);
});
