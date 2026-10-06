import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { cleanup, createContainer, docker, dockerRun, provision } from '../consumer-docker.mjs';
import { selectRoots } from '../consumer-graph.mjs';
import { loadInput } from '../consumer-input.mjs';
import { registryConfig, stage, startRegistry } from '../quarantine.mjs';
import { cli, manifest, workspace } from '../test/fixtures.mjs';
import { hash } from '../workspace.mjs';

async function preflight(fixture, directory) {
  assert.equal((await cli(fixture)).status, 0);
  const path = resolve(fixture.output, 'manifest.json');
  return loadInput(path, hash(await readFile(path)), resolve(directory, 'snapshot'), await readFile(resolve(fixture.root, 'scripts/release/policy.json')));
}

test('official upstream positive proxy control; zero scoped/unscoped/omitted owned ghost requests', { timeout: 600000 }, async (t) => {
  const ghosts = ['@fixture/ghost', 'ghost-unscoped', '@other/ghost', 'ghost-alias'];
  const fixture = await workspace([
    manifest('@fixture/root'),
    manifest('ghost-unscoped', { private: true }),
    manifest('@other/private', { private: true }),
    manifest('ghost-alias', { private: true })
  ]);
  const decoys = await workspace(['external-positive', ...ghosts].map((name) => manifest(name)));
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(decoys.root, { recursive: true, force: true });
  });
  const directory = await mkdtemp(resolve(tmpdir(), 'consumer-ghost-'));
  const upstreamDirectory = await mkdtemp(resolve(tmpdir(), 'consumer-ghost-upstream-'));
  const input = await preflight(fixture, directory);
  const seeds = await preflight(decoys, upstreamDirectory);
  const primary = dockerRun(directory, {});
  const upstream = dockerRun(upstreamDirectory, {});
  try {
    const [image] = await provision(primary);
    const source = await startRegistry(upstream, seeds, false);
    await stage(upstream, seeds, selectRoots(seeds, []), source, image);
    const target = await startRegistry(primary, input, false);
    await docker(['network', 'connect', target.internal, source.id]);
    const config = registryConfig(input.graph.owned, true);
    config.uplinks.npmjs.url = source.endpoint;
    const configPath = resolve(directory, 'fault-injection-proxy.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o644 });
    await docker(['cp', configPath, `${target.id}:/verdaccio/conf/config.yaml`]);
    await docker(['restart', target.id]);
    const before = await docker(['logs', source.id]);
    const probe = await createContainer(primary, image.id, target.internal, ['--entrypoint', 'node'], ['-e', probeSource(target.endpoint, ghosts)]);
    await docker(['start', probe]);
    assert.equal(await docker(['wait', probe], 60000), '0');
    await docker(['cp', `${probe}:/tmp/result.json`, resolve(directory, 'probe.json')]);
    const result = JSON.parse(await readFile(resolve(directory, 'probe.json'), 'utf8'));
    assert.equal(result.positive, 200);
    assert(result.ghosts.every((entry) => entry.status === 404));
    const after = await docker(['logs', source.id]);
    assert(after.startsWith(before));
    const requests = after.slice(before.length);
    assert(requests.includes('external-positive'), 'Positive control did not reach official upstream');
    assert(!requests.includes('ghost'), 'Owned namespace leaked upstream');
    await writeFile(resolve(directory, 'upstream-requests.log'), requests);
    await writeFile(
      resolve(directory, 'receipt.json'),
      JSON.stringify({
        positive: result.positive,
        ownedUpstreamRequests: 0,
        ghosts,
        requestsSha256: hash(requests),
        officialImage: source.image,
        source: source.id,
        target: target.id,
        topology: target.internal
      })
    );
    console.log(`Ghost proof: ${directory}`);
  } finally {
    assert(await cleanup(upstream));
    assert(await cleanup(primary));
  }
});

function probeSource(endpoint, ghosts) {
  return `const fs=require('node:fs');
    const endpoint=${JSON.stringify(endpoint)};
    async function get(name){return (await fetch(endpoint+encodeURIComponent(name),{redirect:'error',signal:AbortSignal.timeout(10000)})).status;}
    (async()=>{let ready=false;for(let i=0;i<30;i++){try{await get('-/ping');ready=true;break;}catch{await new Promise(r=>setTimeout(r,300));}}
      if(!ready)throw Error('Registry not ready');const positive=await get('external-positive');const ghosts=[];
      for(const name of ${JSON.stringify(ghosts)})ghosts.push({name,status:await get(name)});
      fs.writeFileSync('/tmp/result.json',JSON.stringify({positive,ghosts}));
    })().catch(()=>{process.exitCode=1;});`;
}
