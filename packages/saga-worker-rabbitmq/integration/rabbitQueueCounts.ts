export interface RabbitQueueCounts {
  readonly ready: number;
  readonly unacknowledged: number;
}

export interface RabbitQueueCountOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly queue: string;
  readonly timeoutMs?: number;
  readonly pollDelayMs?: number;
}

export interface RabbitManagementResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface RabbitQueueCountDependencies {
  readonly fetch: (url: string, init: { readonly headers: { readonly Authorization: string } }) => Promise<RabbitManagementResponse>;
  readonly now: () => number;
  readonly sleep: (delayMs: number) => Promise<void>;
}

const defaultDependencies: RabbitQueueCountDependencies = {
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => Date.now(),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
};

function parseCounts(value: unknown): RabbitQueueCounts | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Rabbit management response must be an object');
  }
  const hasReady = Object.hasOwn(value, 'messages_ready');
  const hasUnacknowledged = Object.hasOwn(value, 'messages_unacknowledged');
  if (!hasReady && !hasUnacknowledged) return null;
  if (!hasReady || !hasUnacknowledged) throw new Error('Rabbit queue counts are partial');
  const ready = Reflect.get(value, 'messages_ready');
  const unacknowledged = Reflect.get(value, 'messages_unacknowledged');
  if (typeof ready !== 'number' || typeof unacknowledged !== 'number') {
    throw new Error('Rabbit queue counts are non-numeric');
  }
  return { ready, unacknowledged };
}

export async function readRabbitQueueCounts(
  options: RabbitQueueCountOptions,
  dependencies: RabbitQueueCountDependencies = defaultDependencies
): Promise<RabbitQueueCounts> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollDelayMs = options.pollDelayMs ?? 100;
  const deadline = dependencies.now() + timeoutMs;
  const auth = Buffer.from(`${options.username}:${options.password}`).toString('base64');
  const url = `${options.baseUrl}/api/queues/%2F/${encodeURIComponent(options.queue)}`;
  while (true) {
    const response = await dependencies.fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!response.ok) throw new Error(`Rabbit management returned ${response.status}`);
    const counts = parseCounts(await response.json());
    if (counts) return counts;
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) throw new Error('Rabbit queue count metrics sampling timed out');
    await dependencies.sleep(Math.min(pollDelayMs, remainingMs));
  }
}
