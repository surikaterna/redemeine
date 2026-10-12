import { createServer, type Server } from 'node:http';
import type { Observations } from './observability';

export type HealthSnapshot = ReturnType<Observations['snapshot']>;

export class HealthServer {
  private readonly server: Server;
  private starting: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;

  constructor(snapshot: () => HealthSnapshot, onFailure: () => void) {
    this.server = createServer((request, response) => {
      const view = snapshot();
      const path = request.url;
      const status = path === '/live' ? 200 : path === '/ready' ? (view.liveConsumerReady ? 200 : 503)
        : path === '/reference-ready' ? (view.referenceReady ? 200 : 503) : path === '/metrics' ? 200 : 404;
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(view));
    });
    this.server.maxHeadersCount = 32;
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 5000;
    this.server.on('error', onFailure);
  }

  start(port: number): Promise<void> {
    this.starting = new Promise((resolve, reject) => {
      const failed = () => { this.server.removeListener('listening', ready); reject(new Error('health_unavailable')); };
      const ready = () => { this.server.removeListener('error', failed); resolve(); };
      this.server.once('error', failed);
      this.server.once('listening', ready);
      this.server.listen(port, '127.0.0.1');
    });
    return this.starting;
  }

  get port(): number | undefined {
    const address = this.server.address();
    return address && typeof address !== 'string' ? address.port : undefined;
  }

  close(): Promise<void> {
    this.closing ??= this.closeJoined();
    return this.closing;
  }

  private async closeJoined(): Promise<void> {
    await this.starting.catch(() => undefined);
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(new Error('health_close_failed')) : resolve());
      this.server.closeAllConnections();
    });
  }
}
