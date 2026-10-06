import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { registryRequest } from '../consumer-runtime/registry-http.mjs';

test('registry transport rejects public/credential targets before requests and never follows redirects', async (t) => {
  const requests = [];
  // A transport fault responder, not an npm registry or a substitute for Verdaccio integration.
  const server = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method });
    response.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/forbidden-target` });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((accept) => server.close(accept)));
  const endpoint = `http://127.0.0.1:${server.address().port}/`;
  for (const target of ['https://registry.npmjs.org/package', 'https://example.invalid/', 'http://user:secret@127.0.0.1/', '//registry.npmjs.org/']) {
    await assert.rejects(registryRequest(endpoint, target, { method: 'PUT', body: '{}' }), /escaped owned registry/);
  }
  assert.equal(requests.length, 0);
  await assert.rejects(registryRequest(endpoint, '-/ping'), /fetch failed/);
  assert.deepEqual(requests, [{ path: '/-/ping', method: 'GET' }]);
});
