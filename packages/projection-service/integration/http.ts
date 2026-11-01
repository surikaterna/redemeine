import { budgets, QualificationError } from './plan';
import { assert } from './schema';

export class BrokerHttp {
  constructor(private readonly port: number, private readonly username: string, private readonly password: string,
    private readonly signal: AbortSignal) {
    assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'invalid_broker_loopback_port');
  }

  async request(method: 'GET' | 'PUT' | 'POST' | 'DELETE', segments: readonly string[], body?: Record<string, unknown>, operationSignal?: AbortSignal): Promise<unknown> {
    const url = `http://127.0.0.1:${this.port}/api/${segments.map(encodeURIComponent).join('/')}`;
    const signal = AbortSignal.any([this.signal, ...(operationSignal ? [operationSignal] : []), AbortSignal.timeout(5000)]);
    let response: Response;
    try { response = await fetch(url, { method, signal, redirect: 'error', headers: {
      authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
      'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new QualificationError('qualification_http_unavailable'); }
    assert(response.status >= 200 && response.status < 300, 'qualification_http_refused');
    const chunks: Uint8Array[] = []; let bytes = 0;
    const reader = response.body?.getReader();
    if (!reader) return null;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > Math.min(budgets.commandBytes, 262144)) { await reader.cancel(); throw new QualificationError('qualification_http_capacity'); }
      chunks.push(next.value);
    }
    if (bytes === 0) return null;
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); return value;
  }
}
