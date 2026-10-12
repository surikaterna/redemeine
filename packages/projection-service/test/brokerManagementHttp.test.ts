import { createServer, type Server } from 'node:http';
import { createBrokerManagement } from '../src/infrastructure/management';
import { parseConfig } from '../src/config';
import { externalEnvironment } from './fixtures';

async function serverFixture(status = 200, body = '{}', contentType = 'application/json') {
  const received: Array<{ path: string | undefined; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    received.push({ path: request.url, authorization: request.headers.authorization });
    response.writeHead(status, { 'content-type': contentType }); response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing_address');
  const config = parseConfig({ ...externalEnvironment, RABBITMQ_MANAGEMENT_URL: `http://127.0.0.1:${address.port}` }, []);
  if (config.mode !== 'external') throw new Error('external_expected');
  return { server, received, config, management: createBrokerManagement(config, new AbortController().signal) };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

test('real loopback management GET encodes every resource segment and keeps credentials only in authorization', async () => {
  const f = await serverFixture();
  try {
    expect(await f.management.get(['queues', '/tenant/a', 'rdm.projection.commits'])).toEqual({});
    expect(f.received).toEqual([{ path: '/api/queues/%2Ftenant%2Fa/rdm.projection.commits',
      authorization: `Basic ${Buffer.from('fixture:secret-canary').toString('base64')}` }]);
  } finally { await close(f.server); }
});

test.each([
  [401, '{"error":"secret-canary"}', 'application/json'], [302, '{}', 'application/json'],
  [200, 'not-json-secret-canary', 'application/json'], [200, '{}', 'text/html'],
  [200, 'x'.repeat(262145), 'application/json'], [404, '{"error":"not-authenticated"}', 'application/json']
])('bounded strict refusal for HTTP %s', async (status, body, type) => {
  const f = await serverFixture(status, body, type);
  try {
    const error: unknown = await f.management.get(['queues', '/', 'rdm.projection.commits'], true).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret-canary');
  } finally { await close(f.server); }
});

test('only explicit Rabbit404 response is recognized as missing, and aborted requests never become data', async () => {
  const f = await serverFixture(404, '{"error":"Object Not Found","reason":"Not Found"}');
  try {
    expect(await f.management.get(['queues', '/', 'rdm.projection.commits'], true)).toBeNull();
    const abort = new AbortController(); abort.abort();
    await expect(createBrokerManagement(f.config, abort.signal).get(['queues', '/', 'rdm.projection.commits'])).rejects.toThrow('broker_management_unavailable');
  } finally { await close(f.server); }
});

test('knownHTTP refusal code survives decoding,with safeendpoint/status facts and no rawresponse exposure', async () => {
  const f = await serverFixture(403, '{"error":"secret-canary"}'); const observe = jest.fn();
  try {
    const management = createBrokerManagement(f.config, new AbortController().signal, observe);
    await expect(management.get(['queues', '/', 'rdm.projection.commits'])).rejects.toThrow('broker_management_refused');
    expect(observe).toHaveBeenCalledWith('queue', 403, true);
    expect(JSON.stringify(observe.mock.calls)).not.toContain('secret-canary');
  } finally { await close(f.server); }
});

test('diagnostic sink failure cannot make a malformed response valid or escape the request promise', async () => {
  const f = await serverFixture(200, 'not-json-secret-canary');
  try {
    await expect(createBrokerManagement(f.config, new AbortController().signal, () => { throw new Error('secret-canary'); })
      .get(['queues', '/', 'rdm.projection.commits'])).rejects.toThrow('broker_schema_invalid');
  } finally { await close(f.server); }
});
