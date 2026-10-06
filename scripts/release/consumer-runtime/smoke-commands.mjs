function nodeCommand(mode, source) {
  return { program: 'node', args: [...(mode === 'import' ? ['--input-type=module'] : []), '-e', source] };
}

function blockedCommand(surface, mode) {
  const name = JSON.stringify(surface.specifier);
  const source =
    mode === 'import'
      ? `import assert from 'node:assert/strict';
    await assert.rejects(import(${name}),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`
      : `const assert=require('node:assert/strict'); assert.throws(()=>require(${name}),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`;
  return nodeCommand(mode, source);
}

function surfaceCommand(plan, surface, mode) {
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
  return nodeCommand(mode, source);
}

export function surfaceCommands(plan) {
  return plan.surfaces.flatMap((surface) => [
    ...(surface.blockedModes || []).map((mode) => blockedCommand(surface, mode)),
    ...surface.modes.map((mode) => surfaceCommand(plan, surface, mode))
  ]);
}

export function behaviorCommands(plan) {
  const prefix = `import assert from 'node:assert/strict'; import * as api from ${JSON.stringify(plan.name)};\n`;
  if (plan.adapter === 'fixture') return [];
  if (plan.adapter === 'kernel') {
    const source = `${prefix}for(const create of [api.createCommand,api.createEvent]) {
      const factory=create('consumer.operation'); const payload={amount:42}; const first=factory(payload),second=factory(payload);
      assert.deepEqual(first.payload,payload); assert.equal(first.type,'consumer.operation');
      assert.equal(factory.type,'consumer.operation'); assert.equal(String(factory),'consumer.operation');
      assert.equal(typeof first.id,'string'); assert(first.id.length>0); assert.notEqual(first.id,second.id);
    }`;
    return [nodeCommand('import', source)];
  }
  if (plan.adapter !== 'cli') throw new Error('Unsupported behavioral command adapter');
  return [
    { program: '/consumer/node_modules/.bin/redemeine', args: ['help'] },
    nodeCommand(
      'import',
      `${prefix}
    import {Contract} from '@redemeine/kernel'; import {z} from 'zod'; import * as reflector from '@redemeine/cli/reflector';
    const contract=new Contract().addCommand('accept',z.object({id:z.string()}));
    const described=api.describeContract(contract,'orders');
    assert.equal(described.aggregate,'orders'); assert.equal(described.commands.accept.properties.id.type,'string');
    assert.deepEqual(reflector.describeContract(contract,'orders'),described);`
    )
  ];
}

// Execution and admission share these bytes, but admission derives its plan from A's artifact, never B's declared smokes.
export function runtimeCommands(plan) {
  return [...surfaceCommands(plan), ...behaviorCommands(plan)];
}
