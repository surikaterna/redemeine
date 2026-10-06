import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { cleanup, createContainer, docker, dockerRun, provision } from '../consumer-docker.mjs';

test('actual lock verifier rejects traversal components and links on both pinned runtimes', { timeout: 600000 }, async (t) => {
  const state = dockerRun(await mkdtemp(resolve(tmpdir(), 'consumer-lock-path-')), {});
  t.after(async () => assert(await cleanup(state)));
  const code = `import assert from 'node:assert/strict';
    import {writeFile} from 'node:fs/promises';
    import {verifyLock} from '/verify.mjs';
    const paths=['node_modules/../escape','node_modules/x/../../escape','node_modules/./x',
      'node_modules//x','node_modules/x/','node_modules\\\\x','/node_modules/x'];
    for(const path of paths) {
      await writeFile('/consumer/package-lock.json',JSON.stringify({lockfileVersion:3,packages:{[path]:{}}}));
      await assert.rejects(verifyLock({},{}),{code:'ERR_ASSERTION'});
    }
    await writeFile('/consumer/package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/x':{link:true}}}));
    await assert.rejects(verifyLock({},{}),{code:'ERR_ASSERTION'});
    console.log('eight unsafe lock entries rejected');`;
  for (const image of await provision(state)) {
    const id = await createContainer(state, image.id, 'none', ['--entrypoint', 'node'], ['--input-type=module', '-e', code]);
    await docker(['cp', new URL('../consumer-runtime/verify.mjs', import.meta.url).pathname, `${id}:/verify.mjs`]);
    await docker(['start', id]);
    assert.equal(await docker(['wait', id]), '0', await docker(['logs', id]));
    assert.match(await docker(['logs', id]), /eight unsafe lock entries rejected/);
  }
});
