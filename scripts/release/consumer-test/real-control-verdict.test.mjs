import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { tools } from '../consumer-docker.mjs';
import { selectRoots } from '../consumer-graph.mjs';
import { loadInput } from '../consumer-input.mjs';
import { addRegistry, cli, manifest, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';
import { isExpectedCliCoverage } from './real-control-verdict.mjs';

const roots = ['@redemeine/cli@0.1.0'];
let context;
let redContext;
let fixture;
let redFixture;
before(async () => {
  fixture = await workspace([manifest('@redemeine/cli', { version: '0.1.0', peerDependencies: { '@redemeine/kernel': '1.0.0' } })], {
    schemaVersion: 1,
    registry: 'https://registry.npmjs.org/',
    internalScopes: ['@redemeine'],
    holds: {},
    knownBad: {}
  });
  await addRegistry(fixture, '@redemeine/kernel', [manifest('@redemeine/kernel')]);
  assert.equal((await cli(fixture)).status, 0);
  const path = resolve(fixture.output, 'manifest.json');
  const input = await loadInput(
    path,
    hash(await readFile(path)),
    resolve(fixture.root, 'control-input'),
    await readFile(resolve(fixture.root, 'scripts/release/policy.json'))
  );
  context = { a: 0, input, roots, pins: tools, selection: selectRoots(input, roots) };
  redFixture = await workspace([manifest('@fixture/root', { dependencies: { '@fixture/private': '1.0.0' } }), manifest('@fixture/private', { private: true })]);
  assert.equal((await cli(redFixture)).status, 1);
  const redPath = resolve(redFixture.output, 'manifest.json');
  const redInput = await loadInput(
    redPath,
    hash(await readFile(redPath)),
    resolve(redFixture.root, 'control-input'),
    await readFile(resolve(redFixture.root, 'scripts/release/policy.json'))
  );
  redContext = { a: 1, roots: [], pins: tools, input: redInput };
});
after(async () => {
  for (const entry of [fixture, redFixture]) if (entry) await rm(entry.root, { recursive: true, force: true });
});

function boundInput(input) {
  return Object.fromEntries(['repository', 'tools', 'policy', 'inputs', 'diagnostics', 'verdict'].map((key) => [key, input.manifest[key]]));
}

function redReport() {
  return {
    exitCode: 1,
    complete: true,
    inputSha256: redContext.input.digest,
    input: boundInput(redContext.input),
    staging: { receipts: [] },
    consumers: [],
    coverage: []
  };
}

function expectedConsumers() {
  return tools.nodes.map(({ version: node }) => ({
    node,
    root: roots,
    npm: tools.npm.version,
    exitCode: 2,
    failureKind: 'coverage-incomplete',
    identity: identity(`consumer-${node}`),
    error: 'CLI generated-project coverage is incomplete: missing documented prerequisite',
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
}

function expectedReport() {
  const consumers = expectedConsumers();
  return {
    inputSha256: context.input.digest,
    input: boundInput(context.input),
    selection: context.selection,
    requestedConsumers: consumers.map((c) => ({ root: roots[0], node: c.node })),
    coverage: consumers.map((c) => ({ root: roots[0], node: c.node, exitCode: 2, status: 'blocked' })),
    toolPins: tools,
    platform: tools.platform,
    images: tools.nodes.map((node) => ({ ...node, actual: { node: node.version, npm: tools.npm.version, typescript: tools.typescript } })),
    runId: 'control-run',
    registry: { id: 'registry', version: tools.registry.version, identity: identity('registry') },
    exitCode: 2,
    complete: false,
    error: 'Consumer matrix did not fully qualify; all runtime/root outcomes retained',
    cleanup: { complete: true, failures: [] },
    staging: {
      exitCode: 0,
      identity: identity('stager'),
      receipts: context.selection.order.map((key, index) => {
        const a = context.input.artifacts.find((a) => `${a.manifest.name}@${a.manifest.version}` === key);
        return {
          key,
          file: `${index}.tgz`,
          name: a.manifest.name,
          version: a.manifest.version,
          sha256: a.sha256,
          integrity: a.integrity,
          origins: a.origins,
          downloadedSha256: a.sha256,
          downloadedIntegrity: a.integrity,
          dist: { integrity: a.integrity }
        };
      })
    },
    consumers,
    resourceOutcomes: [
      { id: 'registry', running: true, oomKilled: false, exitCode: 0 },
      { id: 'stager', running: false, oomKilled: false, exitCode: 0 },
      ...consumers.map((consumer) => ({ id: consumer.identity.id, running: false, oomKilled: false, exitCode: 2 }))
    ]
  };
}

function identity(id) {
  return { id, labels: { 'org.redemeine.consumer-run': 'control-run' } };
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
  'arbitrary overall error': (r) => {
    r.error = 'Registry infrastructure validation failed';
  },
  'missing expected matrix error': (r) => {
    delete r.error;
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
  },
  'missing resource outcomes': (r) => {
    delete r.resourceOutcomes;
  },
  'empty resource outcomes': (r) => {
    r.resourceOutcomes = [];
  },
  'registry-only resource outcomes': (r) => {
    r.resourceOutcomes = [r.resourceOutcomes[0]];
  },
  'missing Node22 resource outcome': (r) => {
    r.resourceOutcomes = r.resourceOutcomes.filter((resource) => resource.id !== r.consumers[0].identity.id);
  },
  'missing Node24 resource outcome': (r) => {
    r.resourceOutcomes = r.resourceOutcomes.filter((resource) => resource.id !== r.consumers[1].identity.id);
  },
  'wrong consumer resource ID': (r) => {
    r.resourceOutcomes[2].id = 'unknown-consumer';
  },
  'Node22 resource exit0 contradicts blocker': (r) => {
    r.resourceOutcomes[2].exitCode = 0;
  },
  'Node24 resource exit0 contradicts blocker': (r) => {
    r.resourceOutcomes[3].exitCode = 0;
  },
  'consumer still running': (r) => {
    r.resourceOutcomes[2].running = true;
  },
  'consumer resource OOM': (r) => {
    r.resourceOutcomes[2].oomKilled = true;
  },
  'missing consumer identity': (r) => {
    delete r.consumers[0].identity;
  },
  'empty consumer identity ID': (r) => {
    r.consumers[0].identity.id = r.resourceOutcomes[2].id = '';
  },
  'nonstring consumer identity ID': (r) => {
    r.consumers[0].identity.id = r.resourceOutcomes[2].id = 22;
  },
  'duplicate consumer identities sharing one outcome': (r) => {
    r.consumers[1].identity.id = r.consumers[0].identity.id;
    r.resourceOutcomes.pop();
  },
  'duplicate consumer resource outcome': (r) => {
    r.resourceOutcomes.push({ ...r.resourceOutcomes[2] });
  },
  'conflicting duplicate consumer resource outcome': (r) => {
    r.resourceOutcomes.push({ ...r.resourceOutcomes[2], exitCode: 0 });
  },
  'unknown additional consumer exit2': (r) => {
    r.resourceOutcomes.push({ id: 'unknown-consumer', running: false, oomKilled: false, exitCode: 2 });
  },
  'artifact failure before staging': (r) => {
    r.exitCode = 1;
    r.staging.receipts = [];
    r.consumers = [];
  },
  'unexpected success before staging': (r) => {
    r.exitCode = 0;
    r.staging.receipts = [];
    r.consumers = [];
  }
};

function executeControl(report, repository = redReport(), expected = context) {
  const code = `import {mock} from 'node:test';
    import {hash} from ${JSON.stringify(new URL('../workspace.mjs', import.meta.url).href)};
    const {report,repository,expected,red,pins}=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>resolve(s));}));
    const bytes=input=>Buffer.from(typeof input.bytes==='string'?input.bytes:input.bytes.data);
    mock.module('node:fs/promises',{namedExports:{cp:async()=>{},mkdtemp:async()=>'/virtual/control',
      readFile:async(path)=>String(path).endsWith('manifest.json')?bytes((calls===1?red:expected).input):Buffer.from('{}'),rm:async()=>{},writeFile:async()=>{}}});
    let calls=0;
    mock.module(${JSON.stringify(new URL('../check.mjs', import.meta.url).href)},
      {namedExports:{audit:async()=>++calls===1?red.a:expected.a}});
    mock.module(${JSON.stringify(new URL('../consumer-docker.mjs', import.meta.url).href)}, {namedExports:{tools:pins}});
    mock.module(${JSON.stringify(new URL('../consumer-input.mjs', import.meta.url).href)}, {namedExports:{loadInput:async(path,digest)=>{
      const input=(calls===1?red:expected).input;
      if(hash(bytes(input))!==digest)throw Error('mock admission digest mismatch');
      return {...input,digest};
    }}});
    mock.module(${JSON.stringify(new URL('../consumer.mjs', import.meta.url).href)},
      {namedExports:{qualify:async(options)=>{
        const input=(calls===1?red:expected).input;
        if(options['manifest-sha256']!==hash(bytes(input))||JSON.stringify(options.root)!==JSON.stringify(calls===1?[]:expected.roots))throw Error('request mismatch');
        return calls===1?repository:report;
      }}});
    mock.module(${JSON.stringify(new URL('../test/fixtures.mjs', import.meta.url).href)},
      {namedExports:{repo:'/virtual/repo',put:async()=>{},workspace:async()=>({root:'/virtual/fixture'})}});
    await import(${JSON.stringify(new URL('./real-controls.mjs', import.meta.url).href)});`;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', code], {
    encoding: 'utf8',
    input: JSON.stringify({ report, repository, expected, red: redContext, pins: tools }),
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  assert.ifError(result.error);
  return result;
}

test('F4 actual control accepts only clean two-runtime coverage blockers; qualification stays2', () => {
  const report = expectedReport();
  assert.equal(isExpectedCliCoverage(report, context), true);
  const result = executeControl(report);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"b":2/);
  assert.equal(report.exitCode, 2);
});

for (const [name, mutate] of Object.entries(mutations)) {
  test(`F4 actual control rejects ${name} despite expected consumer blockers`, () => {
    const report = structuredClone(expectedReport());
    mutate(report);
    const result = executeControl(report);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(isExpectedCliCoverage(report, context), false);
  });
}

test('F4 malformed predicate inputs fail closed', () => {
  for (const report of [null, undefined, {}, { ...expectedReport(), consumers: null }]) assert.equal(isExpectedCliCoverage(report, context), false);
});

function change(report, path, value, remove = false) {
  const parts = path.split('.');
  const key = parts.pop();
  const parent = parts.reduce((entry, part) => entry[part], report);
  if (remove) delete parent[key];
  else parent[key] = value;
}

const required = {
  platform: 'other',
  images: [],
  'images.0.actual.npm': '0.0.0',
  'images.0.actual.typescript': '0.0.0',
  'images.0.image': 'wrong',
  'registry.version': '0.0.0',
  runId: '',
  inputSha256: 'wrong',
  'input.repository.snapshotIdentity': 'wrong',
  'input.diagnostics': [{}],
  'input.verdict': 'violations',
  'staging.receipts': [],
  'staging.receipts.0': {},
  'staging.receipts.0.key': '@other/root@1.0.0',
  'staging.receipts.0.name': '@other/root',
  'staging.receipts.0.version': '9.0.0',
  'staging.receipts.0.sha256': 'wrong',
  'staging.receipts.0.integrity': 'wrong',
  'staging.receipts.0.downloadedSha256': 'wrong',
  'staging.receipts.0.downloadedIntegrity': 'wrong',
  'staging.receipts.0.dist.integrity': 'wrong',
  'staging.receipts.0.file': '1.tgz',
  'staging.receipts.0.origins': ['candidate'],
  'selection.roots': [],
  'selection.order': [],
  'selection.unselected': [],
  requestedConsumers: [],
  coverage: [],
  consumers: [],
  'consumers.0.root': ['@other/root@1.0.0'],
  'consumers.0.npm': '0.0.0',
  'consumers.0.error': 'Registry transport failed',
  'consumers.0.cliGeneration.missing': [],
  'consumers.0.phases.install': 'failed',
  'toolPins.npm.version': '0.0.0',
  'registry.identity.id': 'wrong',
  'registry.id': 'wrong',
  'staging.identity.id': 'wrong',
  'registry.identity.labels': {},
  'staging.identity.labels': {},
  'consumers.0.identity.labels': {}
};
for (const phase of ['installedGraph', 'cliApi', 'cliDeclarations']) required[`consumers.0.phases.${phase}`] = 'failed';
for (const phase of ['input', 'extraction', 'generatedTypes', 'schemaBehavior']) required[`consumers.0.cliGeneration.${phase}`] = 'passed';
for (const [path, wrong] of Object.entries(required)) {
  for (const [kind, value] of [
    ['omitted', undefined],
    ['null', null],
    ['wrong', wrong]
  ]) {
    test(`bounded contract ${path}: ${kind}`, () => {
      const report = structuredClone(expectedReport());
      change(report, path, value, kind === 'omitted');
      assert.equal(isExpectedCliCoverage(report, context), false);
      assert.equal(executeControl(report).status, 2);
    });
  }
}

const contradictions = {
  'staging duplicate': (r) => {
    r.staging.receipts[1] = r.staging.receipts[0];
  },
  'staging extra': (r) => {
    r.staging.receipts.push(r.staging.receipts[0]);
  },
  'staging reversed': (r) => {
    r.staging.receipts.reverse();
  },
  'self consistent wrong bytes': (r) => {
    r.staging.receipts[0].sha256 = r.staging.receipts[0].downloadedSha256 = hash('other bytes');
  },
  'self consistent wrong root': (r) => {
    r.selection.roots = r.consumers[0].root = ['@other/root@1.0.0'];
    r.requestedConsumers[0].root = r.coverage[0].root = '@other/root@1.0.0';
  },
  'requested substituted runtime': (r) => {
    r.requestedConsumers[0].node = '18.0.0';
  },
  'coverage contradiction': (r) => {
    r.coverage[0].exitCode = 0;
  },
  'coverage duplicate': (r) => {
    r.coverage[1] = r.coverage[0];
  },
  'consumer extra': (r) => {
    r.consumers.push(r.consumers[0]);
  },
  'consumer duplicate pair': (r) => {
    r.consumers[1] = r.consumers[0];
  },
  'foreign registry label': (r) => {
    r.registry.identity.labels['org.redemeine.consumer-run'] = 'foreign';
  },
  'registry stager collision': (r) => {
    r.staging.identity.id = r.registry.identity.id;
  },
  'stager consumer collision': (r) => {
    r.staging.identity.id = r.consumers[0].identity.id;
  },
  'unknown healthy outcome': (r) => {
    r.resourceOutcomes.push({ id: 'unknown', running: false, oomKilled: false, exitCode: 0 });
  }
};
for (const index of [0, 1, 2, 3]) {
  for (const [name, action] of Object.entries({
    omitted: (r) => {
      r.resourceOutcomes.splice(index, 1);
    },
    duplicate: (r) => {
      r.resourceOutcomes.push(r.resourceOutcomes[index]);
    },
    substitute: (r) => {
      r.resourceOutcomes[index].id = 'unknown';
    },
    state: (r) => {
      r.resourceOutcomes[index].running = !r.resourceOutcomes[index].running;
    },
    oom: (r) => {
      r.resourceOutcomes[index].oomKilled = true;
    },
    exit: (r) => {
      r.resourceOutcomes[index].exitCode = index < 2 ? 2 : 0;
    }
  }))
    contradictions[`resource ${index} ${name}`] = action;
}
for (const [name, mutate] of Object.entries(contradictions)) {
  test(`bounded contract rejects ${name}`, () => {
    const report = structuredClone(expectedReport());
    mutate(report);
    assert.equal(isExpectedCliCoverage(report, context), false);
    assert.equal(executeControl(report).status, 2);
  });
}

test('benign unknown metadata is not a failure blacklist; resource enumeration order is irrelevant', () => {
  const report = structuredClone(expectedReport());
  Object.assign(report, {
    note: 'future annotation',
    signal: 'metadata only',
    errors: [],
    failureKind: 'annotation',
    infrastructureFailure: false,
    failures: []
  });
  report.staging.receipts[0].annotation = 'retained';
  report.resourceOutcomes.reverse();
  assert.equal(isExpectedCliCoverage(report, context), true);
  assert.equal(executeControl(report).status, 0);
});

for (const path of ['inputSha256', 'input', 'input.diagnostics', 'input.repository', 'complete', 'exitCode', 'staging.receipts', 'consumers', 'coverage']) {
  test(`repository negative is bound: missing ${path}`, () => {
    const report = structuredClone(redReport());
    change(report, path, undefined, true);
    assert.notEqual(executeControl(expectedReport(), report).status, 0);
  });
}
for (const [path, value] of Object.entries({
  error: 'random failure',
  interrupted: 'SIGTERM',
  images: [],
  resourceOutcomes: [],
  registry: {},
  'staging.receipts': [{}],
  consumers: [{}],
  'input.diagnostics': [],
  inputSha256: hash('different A')
})) {
  test(`repository negative rejects ${path} contradiction`, () => {
    const report = structuredClone(redReport());
    change(report, path, value);
    assert.notEqual(executeControl(expectedReport(), report).status, 0);
  });
}

test('CLI context must come from successful A and the requested root, never from B', () => {
  for (const expected of [undefined, {}, { ...context, a: 1 }, { ...context, roots: ['@other/root@1.0.0'] }]) {
    assert.equal(isExpectedCliCoverage(expectedReport(), expected), false);
  }
});
