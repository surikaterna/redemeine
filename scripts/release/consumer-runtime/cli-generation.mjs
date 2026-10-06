import assert from 'node:assert/strict';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { compilerOptions } from './declarations.mjs';
import { sha256 } from './verify.mjs';

const bin = '/consumer/node_modules/.bin/redemeine';
const tsc = ['/opt/consumer-tools/node_modules/typescript/bin/tsc', '--project', '/consumer/tsconfig.json'];
const entry = '/consumer/src/domains/orders/aggregate.ts';

export async function cliGeneration(command, result) {
  const phase = (result.cliGeneration = { status: 'running', input: 'not-run', extraction: 'not-run', generatedTypes: 'not-run', schemaBehavior: 'not-run' });
  const missing = await missingPrerequisites();
  if (missing.length) {
    Object.assign(phase, { status: 'blocked', reason: 'missing-prerequisites', missing });
    result.notValidated.push('CLI generated project: documented aggregate prerequisite absent; no direct sibling installation permitted');
    throw Object.assign(new Error('CLI generated-project coverage is incomplete: missing documented prerequisite'), { code: 2, kind: 'coverage-incomplete' });
  }
  try {
    await prepareInput(command, result);
    await extract(command, result);
    await validateGenerated(command, result);
    phase.status = 'passed';
  } catch (error) {
    phase.status = 'failed';
    for (const key of ['input', 'extraction', 'generatedTypes', 'schemaBehavior']) if (phase[key] === 'running') phase[key] = 'failed';
    throw error;
  }
}

async function missingPrerequisites() {
  try {
    await access('/consumer/node_modules/@redemeine/aggregate/package.json');
    return [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return ['@redemeine/aggregate'];
  }
}

async function artifactFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw Object.assign(new Error(`CLI did not produce expected artifact: ${path}`), { code: 1 });
  }
}

async function prepareInput(command, result) {
  result.cliGeneration.input = 'running';
  command(bin, ['init', 'orders', '--no-install']);
  await artifactFile(entry);
  await appendFile(entry, "\nthrow Error('CONSUMER_SOURCE_EXECUTION_TRAP');\n");
  const source = await artifactFile(entry);
  await writeFile('/job/aggregate.ts', source);
  result.cliSourceSha256 = sha256(source);
  await writeFile('/consumer/tsconfig.json', JSON.stringify({ compilerOptions: compilerOptions('Bundler'), files: ['src/domains/orders/aggregate.ts'] }));
  const diagnosis = command('node', tsc, true);
  result.cliInput = { typecheckExit: diagnosis.exit, diagnosticsSha256: sha256(diagnosis.log) };
  if (diagnosis.exit === null) throw Object.assign(new Error('CLI input typecheck did not complete'), { code: 2 });
  result.cliGeneration.input = diagnosis.exit === 0 ? 'passed' : 'failed';
  assert.equal(diagnosis.exit, 0, 'CLI scaffold has invalid types despite available documented prerequisites');
}

async function extract(command, result) {
  result.cliGeneration.extraction = 'running';
  command(bin, ['extract-schemas', '--entry', entry, '--export', 'orders', '--tsconfig', '/consumer/tsconfig.json', '--out', '/consumer/generated.ts']);
  const generated = await artifactFile('/consumer/generated.ts');
  await writeFile('/job/generated.ts', generated);
  result.generatedSha256 = sha256(generated);
  result.cliGeneration.extraction = 'passed';
}

async function validateGenerated(command, result) {
  const options = { ...compilerOptions('NodeNext'), noEmit: false, outDir: './generated-output' };
  await writeFile('/consumer/generated-check.ts', generatedTypeCheck);
  const config = { compilerOptions: options, files: ['generated.ts', 'generated-check.ts'] };
  result.generatedCompilation = { files: config.files, configSha256: sha256(JSON.stringify(config)) };
  await writeFile('/consumer/tsconfig.json', JSON.stringify(config));
  result.cliGeneration.generatedTypes = 'running';
  command('node', tsc);
  result.cliGeneration.generatedTypes = 'passed';
  result.cliGeneration.schemaBehavior = 'running';
  command('node', ['--input-type=module', '-e', generatedRuntimeCheck]);
  result.cliGeneration.schemaBehavior = 'passed';
}

const generatedTypeCheck = `import {commandSchemas,eventSchemas,stateSchema} from './generated.js';
const commandId:string=commandSchemas.accept.parse({id:'order-1'}).id;
const eventId:string=eventSchemas.accepted.parse({id:'order-1'}).id;
const state=stateSchema.parse({id:'order-1',accepted:true});
const stateId:string=state.id;
const accepted:boolean=state.accepted;
export {commandId,eventId,stateId,accepted};
`;

const generatedRuntimeCheck = `import assert from 'node:assert/strict';
import * as generated from '/consumer/generated-output/generated.js';
assert.deepEqual(Object.keys(generated).sort(),['commandSchemas','eventSchemas','stateSchema']);
assert.deepEqual(Object.keys(generated.commandSchemas),['accept']);
assert.deepEqual(Object.keys(generated.eventSchemas),['accepted']);
for(const schema of [generated.commandSchemas.accept,generated.eventSchemas.accepted]) {
  assert.deepEqual(schema.parse({id:'order-1'}),{id:'order-1'});
  for(const invalid of [{id:42},{},null]) assert.equal(schema.safeParse(invalid).success,false);
}
for(const accepted of [true,false]) {
  const state={id:'order-1',accepted}; assert.deepEqual(generated.stateSchema.parse(state),state);
}
for(const invalid of [{id:42,accepted:true},{id:'order-1',accepted:'yes'},{},null]) {
  assert.equal(generated.stateSchema.safeParse(invalid).success,false);
}
`;
