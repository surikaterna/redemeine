import { describe, expect, it, jest } from '@jest/globals';
import { type RabbitManagementResponse, type RabbitQueueCountDependencies, type RabbitQueueCountOptions, readRabbitQueueCounts } from './rabbitQueueCounts';

const options: RabbitQueueCountOptions = {
  baseUrl: 'http://rabbit.test',
  username: 'alice',
  password: 'secret',
  queue: 'queue with/slash',
  timeoutMs: 200,
  pollDelayMs: 100
};

function response(value: unknown, status = 200): RabbitManagementResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function dependencies(responses: readonly RabbitManagementResponse[]) {
  let now = 0;
  let index = 0;
  const fetch = jest.fn(async (_url: string, _init: { readonly headers: { readonly Authorization: string } }) => {
    return responses[Math.min(index++, responses.length - 1)] ?? response({});
  });
  const sleep = jest.fn(async (delayMs: number) => {
    now += delayMs;
  });
  const value: RabbitQueueCountDependencies = { fetch, now: () => now, sleep };
  return { value, fetch, sleep };
}

describe('Rabbit queue count observation', () => {
  it('retries expected unsampled metrics and preserves auth and root-vhost path', async () => {
    const fixture = dependencies([response({ name: 'queue with/slash' }), response({ messages_ready: 2, messages_unacknowledged: 1 })]);
    await expect(readRabbitQueueCounts(options, fixture.value)).resolves.toEqual({ ready: 2, unacknowledged: 1 });
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(fixture.fetch).toHaveBeenNthCalledWith(1, 'http://rabbit.test/api/queues/%2F/queue%20with%2Fslash', {
      headers: { Authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}` }
    });
    expect(fixture.sleep).toHaveBeenCalledWith(100);
  });

  it('times out when both sampled metrics remain absent', async () => {
    const fixture = dependencies([response({})]);
    await expect(readRabbitQueueCounts(options, fixture.value)).rejects.toThrow('Rabbit queue count metrics sampling timed out');
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(fixture.sleep).toHaveBeenCalledTimes(2);
  });

  it('rejects non-object and non-numeric management payloads', async () => {
    const nonObject = dependencies([response(null)]);
    const nonNumeric = dependencies([response({ messages_ready: '0', messages_unacknowledged: 0 })]);
    await expect(readRabbitQueueCounts(options, nonObject.value)).rejects.toThrow('Rabbit management response must be an object');
    await expect(readRabbitQueueCounts(options, nonNumeric.value)).rejects.toThrow('Rabbit queue counts are non-numeric');
  });

  it('rejects partial queue count payloads instead of polling them', async () => {
    const fixture = dependencies([response({ messages_ready: 0 })]);
    await expect(readRabbitQueueCounts(options, fixture.value)).rejects.toThrow('Rabbit queue counts are partial');
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  it('rejects a missing queue response without polling', async () => {
    const fixture = dependencies([response({ error: 'Object Not Found' }, 404)]);
    await expect(readRabbitQueueCounts(options, fixture.value)).rejects.toThrow('Rabbit management returned 404');
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  it('accepts zero only when both metrics explicitly contain numeric zero', async () => {
    const fixture = dependencies([response({ messages_ready: 0, messages_unacknowledged: 0 })]);
    await expect(readRabbitQueueCounts(options, fixture.value)).resolves.toEqual({ ready: 0, unacknowledged: 0 });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.sleep).not.toHaveBeenCalled();
  });
});
