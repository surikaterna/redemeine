import assert from 'node:assert/strict';
import { cliGeneration } from './cli-generation.mjs';
import { declarations } from './declarations.mjs';

export async function smoke(job, command, result) {
  for (const plan of job.smokes) {
    for (const surface of plan.surfaces) {
      for (const mode of surface.blockedModes || []) checkBlocked(surface, mode, command);
      for (const mode of surface.modes) {
        checkSurface(plan, surface, mode, command);
      }
    }
    await behavior(plan, command, result);
    await declarations(plan, command);
  }
}

function checkBlocked(surface, mode, command) {
  const name = JSON.stringify(surface.specifier);
  const source =
    mode === 'import'
      ? `import assert from 'node:assert/strict';
    await assert.rejects(import(${name}),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`
      : `const assert=require('node:assert/strict'); assert.throws(()=>require(${name}),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`;
  command('node', [...(mode === 'import' ? ['--input-type=module'] : []), '-e', source]);
}

function checkSurface(plan, surface, mode, command) {
  const specifier = JSON.stringify(surface.specifier);
  const expression = mode === 'require' ? `require(${specifier})` : `await import(${specifier})`;
  const resolved = mode === 'require' ? `require.resolve(${specifier})` : `new URL(import.meta.resolve(${specifier}))`;
  const prefix =
    mode === 'require'
      ? "const fs=require('node:fs'), assert=require('node:assert/strict');"
      : "import fs from 'node:fs'; import assert from 'node:assert/strict';";
  const target = `/consumer/node_modules/${plan.name}/${surface.targets[mode].replace(/^\.\//, '')}`;
  const source = `${prefix} assert.equal(fs.realpathSync(${resolved}),fs.realpathSync(${JSON.stringify(target)}));
    const api=${expression}; assert(Object.keys(api).length>0); ${plan.adapter === 'fixture' ? 'assert.equal(api.value+1,43);' : ''}`;
  command('node', [...(mode === 'import' ? ['--input-type=module'] : []), '-e', source]);
}

async function behavior(plan, command, result) {
  const prefix = `import assert from 'node:assert/strict'; import * as api from ${JSON.stringify(plan.name)};\n`;
  if (plan.adapter === 'fixture') {
    return;
  }
  if (plan.adapter === 'kernel') {
    const source = `${prefix}for(const create of [api.createCommand,api.createEvent]) {
      const factory=create('consumer.operation'); const payload={amount:42}; const first=factory(payload),second=factory(payload);
      assert.deepEqual(first.payload,payload); assert.equal(first.type,'consumer.operation');
      assert.equal(factory.type,'consumer.operation'); assert.equal(String(factory),'consumer.operation');
      assert.equal(typeof first.id,'string'); assert(first.id.length>0); assert.notEqual(first.id,second.id);
    }`;
    command('node', ['--input-type=module', '-e', source]);
    return;
  }
  await cliBehavior(plan, command, result, prefix);
}

async function cliBehavior(plan, command, result, prefix) {
  const help = command('/consumer/node_modules/.bin/redemeine', ['help']);
  assert(help.includes('extract-schemas') && help.includes('init'), 'Installed CLI help lacks commands');
  command('node', [
    '--input-type=module',
    '-e',
    `${prefix}
    import {Contract} from '@redemeine/kernel'; import {z} from 'zod'; import * as reflector from '@redemeine/cli/reflector';
    const contract=new Contract().addCommand('accept',z.object({id:z.string()}));
    const described=api.describeContract(contract,'orders');
    assert.equal(described.aggregate,'orders'); assert.equal(described.commands.accept.properties.id.type,'string');
    assert.deepEqual(reflector.describeContract(contract,'orders'),described);`
  ]);
  result.phases.cliApi = 'passed';
  await declarations(plan, command);
  result.phases.cliDeclarations = 'passed';
  await cliGeneration(command, result);
}
