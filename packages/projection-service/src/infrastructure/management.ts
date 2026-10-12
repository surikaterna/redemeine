import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ExternalConfig } from './mongo';
import { BrokerRefusal } from './brokerSchema';
import { startupHttpRoute, type StartupHttpRoute } from '../startupDiagnostics';

export interface BrokerManagement { get(segments: readonly string[], allowMissing?: boolean): Promise<unknown> }

function decodeResponse(response: IncomingMessage, chunks: Buffer[], allowMissing: boolean): unknown {
  if (typeof response.headers['content-type'] !== 'string' || !response.headers['content-type'].startsWith('application/json')) {
    throw new BrokerRefusal('broker_schema_invalid');
  }
  if (response.statusCode !== 200 && !(response.statusCode === 404 && allowMissing)) throw new BrokerRefusal('broker_management_refused');
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (response.statusCode !== 404) return value;
  if (!value || typeof value !== 'object' || !('error' in value) || value.error !== 'Object Not Found') throw new BrokerRefusal('broker_schema_invalid');
  return null;
}

export function createBrokerManagement(config: ExternalConfig, signal: AbortSignal,
  observe?: (route: StartupHttpRoute, status: number | undefined, json: boolean) => void): BrokerManagement {
  const origin = config.external.managementUrl;
  const authorization = `Basic ${Buffer.from(`${config.external.managementUsername}:${config.external.managementPassword}`).toString('base64')}`;
  return { get: (segments, allowMissing = false) => new Promise((resolve, reject) => {
    const url = new URL(`/api/${segments.map(encodeURIComponent).join('/')}`, origin);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', signal, headers: { authorization, accept: 'application/json' }
    });
    const timer = setTimeout(() => request.destroy(new BrokerRefusal('broker_management_timeout')), config.connectTimeoutMs);
    request.once('error', () => { clearTimeout(timer); reject(new BrokerRefusal('broker_management_unavailable')); });
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 262144) { clearTimeout(timer); reject(new BrokerRefusal('broker_management_capacity')); request.destroy(); return; }
        chunks.push(chunk);
      });
      response.once('error', () => { clearTimeout(timer); reject(new BrokerRefusal('broker_management_unavailable')); });
      response.once('end', () => {
        clearTimeout(timer);
        try { observe?.(startupHttpRoute(segments), response.statusCode,
          typeof response.headers['content-type'] === 'string' && response.headers['content-type'].startsWith('application/json')); }
        catch { /* Diagnostic sinks cannot alter response validation. */ }
        try { resolve(decodeResponse(response, chunks, allowMissing)); }
        catch (error) { reject(error instanceof BrokerRefusal ? error : new BrokerRefusal('broker_schema_invalid')); }
      });
    });
    request.end();
  }) };
}
