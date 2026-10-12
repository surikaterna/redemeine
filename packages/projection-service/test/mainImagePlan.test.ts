import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const root = join(__dirname, '../../..');
const runner = join(__dirname, '../scripts/check-main-image.mjs');

test('concrete plan emits only one unique image/two constrained owned containers without invoking Docker', () => {
  const result = spawnSync(process.execPath, [runner, '--plan', '0123456789abcdef'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0); expect(result.stderr).toBe(''); const plan = JSON.parse(result.stdout);
  expect(plan.reviewDigest).toMatch(/^[a-f0-9]{64}$/); expect(plan.workerDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(plan.dockerPrefix).toEqual(['--host', 'unix:///var/run/docker.sock']); expect(plan.containers).toHaveLength(2);
  expect(plan.build).toEqual(expect.arrayContaining(['--memory', '2g', '--cpu-quota', '100000', 'VCS_REF=uncommitted-source-snapshot']));
  for (const container of plan.containers) {
    expect(container.create).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--memory', '512m', '--cpus', '0.5', '--pids-limit', '128', '--cap-drop', 'ALL']));
    expect(container.create).not.toContain('--entrypoint'); expect(container.expectedExitCode).toBe(78);
  }
  expect(plan.containers[1].create.join(' ')).toContain('target=/app/definitions/invalid.mjs,readonly');
  expect(plan.containers[1].expectedDiagnostic.reason).toBe('definition_bundle_invalid');
  expect(plan.deadlines).toEqual({ build: 900000, smoke: 30000, command: 10000, cleanup: 120000 });
});

test('wrong approval binding refuses before creating resource directory or issuing Docker commands', () => {
  const result = spawnSync(process.execPath, [runner, '--execute', '0123456789abcdef', '--approved-review-digest', '0'.repeat(64)],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('main_image_packaging_refused\n');
});

test('runner has exact owned cleanup/uncertainty and bounded tar inspections, not image export or global prune', async () => {
  const source = await readFile(runner, 'utf8');
  expect(source).toContain('ledger.identify(intent, before)'); expect(source).toContain("['rm', '--force', id]");
  expect(source).toContain("['image', 'rm', entry.name]"); expect(source).toContain('failed_uncertain');
  expect(source.indexOf('assertDaemonCapabilities(capabilities)')).toBeLessThan(source.indexOf('const id = await build(plan, ledger)'));
  expect(source).toContain('Docker_worker_differs_from_reviewed_offline_seal');
  expect(source).not.toMatch(/shell:\s*true|\['(?:prune|push|export)'/);
});

test('tar inspection rejects unreadable seal metadata and traversal without extracting files', () => {
  const script = `import {tarEntries,checkPayload} from ${JSON.stringify(join(__dirname, '../scripts/main-image-tar.mjs'))};
    function finish(h){h.write('ustar',257);h.write('00',263);h.fill(32,148,156);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0'),148);h[154]=0;h[155]=32;}
    const h=Buffer.alloc(2048); h.write('../escape'); h.write('0000000',124); finish(h.subarray(0,512));let refused=0;
    try{tarEntries(h)}catch{refused++}
    const b=Buffer.alloc(2048); b.write('artifact.json'); b.write('0000600',100); b.write('0000000',108); b.write('0000000',124); b.write('0',156);finish(b.subarray(0,512));
    try{checkPayload(b)}catch(e){if(e.code==='payload_not_readable')refused++}
    console.log(refused);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(child.status).toBe(0); expect(child.stdout.trim()).toBe('2');
});

test('final tar requires regular root-owned 0644 worker code, seals and package type metadata', () => {
  const script = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
    import {checkPayload} from ${JSON.stringify(join(__dirname, '../scripts/main-image-tar.mjs'))};
    const dist=${JSON.stringify(join(__dirname, '../dist-worker'))};
    const names=['main.js','artifact.json','build-lock.sha256','package.json','LICENSE','licenses/DEPENDENCIES.json'];
    const rows=names.map(name=>({name,mode:0o644,uid:0,type:'0',bytes:readFileSync(name==='package.json'
      ? ${JSON.stringify(join(__dirname, '../worker-package.json'))} : name==='LICENSE'
      ? ${JSON.stringify(join(root, 'LICENSE'))} : dist+'/'+name)}));
    function tar(rows){return Buffer.concat(rows.map(row=>{
      const h=Buffer.alloc(512); h.write(row.name); h.write(row.mode.toString(8).padStart(7,'0'),100);
      h.write(row.uid.toString(8).padStart(7,'0'),108); h.write(row.bytes.length.toString(8).padStart(11,'0'),124); h.write(row.type,156);
      h.write('ustar',257);h.write('00',263);h.fill(32,148,156);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0'),148);h[154]=0;h[155]=32;
      return Buffer.concat([h,row.bytes,Buffer.alloc((512-row.bytes.length%512)%512)]);
    }).concat([Buffer.alloc(1024)]));}
    const valid=checkPayload(tar(rows)); assert.equal(valid.files.length,6);
    assert.throws(()=>checkPayload(tar(rows.map(row=>row.name==='main.js'?{...row,mode:0o755}:row))),
      error=>error.code==='payload_mode_invalid');
    for(const name of names.slice(0,4)){
      for(const mutation of [{mode:0o600},{mode:0o666},{mode:0o444},{uid:10001},{type:'2'}]){
        assert.throws(()=>checkPayload(tar(rows.map(row=>row.name===name?{...row,...mutation}:row))));
      }
    }
    assert.ok(valid.files.every(row=>row.uid===0&&row.mode===0o644&&row.type==='0'));
    console.log('PASS');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(child.stderr).toBe(''); expect(child.status).toBe(0); expect(child.stdout.trim()).toBe('PASS');
});
