import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanup, docker, dockerRun } from '../consumer-docker.mjs';
import { loadEnvelope } from '../handoff-input.mjs';
import { preparePublisher, publisherWorker } from '../publish-rehearsal.mjs';
import { stage } from '../quarantine.mjs';
import { packageArchive } from '../test/fixtures.mjs';
import { hash, sri } from '../workspace.mjs';

export async function publisherFaults(t, fixture, handoff) {
  for (const prefix of [0, 1, 2])
    await t.test(`C4.13 every-prefix ${prefix}/2 failure; fresh worker reconciles original bytes, never retries accepted uploads`, async (t) => {
      const directory = resolve(fixture.directory, `fault-${prefix}`);
      await mkdir(directory);
      const admitted = await loadEnvelope(
        resolve(fixture.directory, 'handoff/envelope.json'),
        handoff.sha256,
        resolve(directory, 'bundle'),
        handoff.envelope.toolsSnapshot
      );
      const state = dockerRun(directory, { workers: [] });
      t.after(async () => {
        assert(await cleanup(state));
        await writeFile(resolve(directory, 'result.json'), JSON.stringify(state.report, null, 2));
      });
      const publisher = await preparePublisher(state, admitted);
      await installFault(publisher, prefix);
      const first = await publisherWorker(state, publisher);
      assert.equal(first.exitCode, 2, JSON.stringify(first));
      assert(first.ledger.tags.every((entry) => entry.state === 'planned'));
      assert(!first.commands.some((entry) => entry.args[0] === 'dist-tag'));
      if (prefix === 1) await changedLedger(t, state, publisher, first.ledgerSha256);
      if (prefix === 2) await ambiguousRead(t, state, publisher, first.ledgerSha256);
      if (prefix === 0) await concurrentLock(t, state, publisher, first.ledgerSha256);
      const second = await publisherWorker(state, publisher, first.ledgerSha256);
      assert.equal(second.exitCode, 0, JSON.stringify(second));
      assert.equal(second.commands.filter((entry) => entry.args[0] === 'publish').length, 2 - prefix);
      assert(second.ledger.tags.every((entry) => entry.state === 'confirmed'));
      assert.equal(await docker(['exec', publisher.worker, 'node', '-e', "console.log(require('node:fs').readFileSync('/job/accepted-count','utf8'))"]), '2');
      assert(!JSON.stringify(state.report).includes('POISON_SECRET_CANARY'));
      assert.equal(
        await docker(['exec', publisher.worker, 'node', '-e', "console.log(require('node:fs').existsSync('/tmp/rehearsal/LIFECYCLE_RAN'))"]),
        'false'
      );
      if (prefix === 0) await wrongTarget(t, state, publisher, second.ledgerSha256);
    });
}

async function concurrentLock(t, state, publisher, digest) {
  await t.test('C4.14 concurrent worker lease prevents mutation', async () => {
    await docker([
      'exec',
      '-d',
      publisher.worker,
      'node',
      '-e',
      "const fs=require('node:fs');fs.mkdirSync('/job/release-lock');setTimeout(()=>fs.rmdirSync('/job/release-lock'),3000)"
    ]);
    await docker([
      'exec',
      publisher.worker,
      'node',
      '-e',
      "const fs=require('node:fs');let n=0;const t=setInterval(()=>{if(fs.existsSync('/job/release-lock'))clearInterval(t);else if(++n>100)process.exit(2)},10)"
    ]);
    const blocked = await publisherWorker(state, publisher, digest);
    assert.equal(blocked.exitCode, 2);
    assert.deepEqual(blocked.commands, []);
    await docker([
      'exec',
      publisher.worker,
      'node',
      '-e',
      "const fs=require('node:fs');let n=0;const t=setInterval(()=>{if(!fs.existsSync('/job/release-lock'))clearInterval(t);else if(++n>400)process.exit(2)},10)"
    ]);
  });
  await t.test('C4.14 changed resume source identity fails before mutation', async () => {
    const source = publisher.job.source;
    publisher.job.source = '0'.repeat(64);
    const blocked = await publisherWorker(state, publisher, digest);
    assert.equal(blocked.exitCode, 2);
    assert.deepEqual(blocked.commands, []);
    publisher.job.source = source;
  });
}

export async function conflictControl(t, fixture, handoff) {
  await t.test('C4.9 existing same identity with different original bytes stops before any candidate upload', async (t) => {
    const directory = resolve(fixture.directory, 'conflict-control');
    await mkdir(directory);
    const admitted = await loadEnvelope(
      resolve(fixture.directory, 'handoff/envelope.json'),
      handoff.sha256,
      resolve(directory, 'bundle'),
      handoff.envelope.toolsSnapshot
    );
    const state = dockerRun(directory, { workers: [] });
    t.after(async () => {
      assert(await cleanup(state));
      await writeFile(resolve(directory, 'result.json'), JSON.stringify(state.report, null, 2));
    });
    const publisher = await preparePublisher(state, admitted);
    const first = admitted.input.artifacts.find((item) => `${item.manifest.name}@${item.manifest.version}` === admitted.selection.order[0]);
    const bytes = packageArchive({ ...first.manifest, description: 'Conflicting original registry fixture' });
    const copy = resolve(directory, 'conflicting.tgz');
    await writeFile(copy, bytes);
    const input = { artifacts: [{ ...first, copy, sha256: hash(bytes), integrity: sri(bytes) }] };
    await stage(state, input, { order: [admitted.selection.order[0]] }, publisher.registry, { id: publisher.image });
    const rejected = await publisherWorker(state, publisher);
    assert.equal(rejected.exitCode, 1, JSON.stringify(rejected));
    assert.deepEqual(rejected.commands, []);
    assert(rejected.ledger.tags.every((entry) => entry.state === 'planned'));
  });
}

async function installFault(publisher, prefix) {
  await docker(['cp', resolve(publisher.directory, 'publish-rehearsal.mjs'), `${publisher.worker}:/job/original.mjs`]);
  const wrapper = `import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
process.env.NPM_CONFIG_REGISTRY='https://registry.npmjs.org/';
process.env.NODE_AUTH_TOKEN='POISON_SECRET_CANARY';
const original=child.spawnSync;
let attempts=0;
child.spawnSync=(program,args,options)=>{
  if(program!=='npm'||args[0]!=='publish') return original(program,args,options);
  attempts++;
  const fail=!fs.existsSync('/job/injected') && attempts===${Math.max(1, prefix)};
  if(fail) fs.writeFileSync('/job/injected','once');
  if(fail && ${prefix}===0) return {status:1,stdout:'',stderr:'injected before acceptance'};
  const result=original(program,args,options);
  if(result.status===0){const previous=fs.existsSync('/job/accepted-count')?Number(fs.readFileSync('/job/accepted-count')):0;fs.writeFileSync('/job/accepted-count',String(previous+1));}
  return fail?{...result,status:1,stderr:'injected accepted upload, lost response'}:result;
};
syncBuiltinESMExports();
await import('./original.mjs');
`;
  const path = resolve(publisher.directory, 'fault.mjs');
  await writeFile(path, wrapper);
  await docker(['cp', path, `${publisher.worker}:/job/publish-rehearsal.mjs`]);
}

async function changedLedger(t, state, publisher, sha256) {
  await t.test('C4.14 changed durable ledger rejected before mutation', async () => {
    const path = resolve(state.output, 'original-ledger.json');
    await docker(['cp', `${publisher.worker}:/job/ledger.json`, path]);
    await docker(['exec', publisher.worker, 'node', '-e', "require('node:fs').appendFileSync('/job/ledger.json',' ')"]);
    const rejected = await publisherWorker(state, publisher, sha256);
    assert.equal(rejected.exitCode, 2);
    assert.deepEqual(rejected.commands, []);
    await docker(['cp', path, `${publisher.worker}:/job/ledger.json`]);
  });
}

async function ambiguousRead(t, state, publisher, sha256) {
  await t.test('C4.14 ambiguous registry read cannot authorize retry or promotion', async () => {
    const path = resolve(publisher.directory, 'ambiguous-http.mjs');
    await writeFile(
      path,
      "export async function registryRequest(endpoint,path){if(path==='-/ping')return Buffer.from('{}');throw new Error('Ambiguous registry observation');}\n"
    );
    await docker(['cp', path, `${publisher.worker}:/job/registry-http.mjs`]);
    const rejected = await publisherWorker(state, publisher, sha256);
    assert.equal(rejected.exitCode, 2);
    assert.deepEqual(rejected.commands, []);
    await docker(['cp', resolve(publisher.directory, 'registry-http.mjs'), `${publisher.worker}:/job/registry-http.mjs`]);
  });
}

async function wrongTarget(t, state, publisher, sha256) {
  await t.test('C4.12 public endpoint/config poison rejected before registry write', async () => {
    const endpoint = publisher.job.endpoint;
    publisher.job.endpoint = 'https://registry.npmjs.org/';
    const rejected = await publisherWorker(state, publisher, sha256);
    assert.equal(rejected.exitCode, 2);
    assert.deepEqual(rejected.commands, []);
    publisher.job.endpoint = endpoint;
    const report = await readFile(resolve(state.output, 'worker-0.json'), 'utf8');
    assert(!report.includes('POISON_SECRET_CANARY'));
  });
}
