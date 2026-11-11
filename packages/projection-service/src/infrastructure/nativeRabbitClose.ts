import { InfrastructureError } from './failure';

interface RabbitClosePort {
  close(): Promise<void>;
  on(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

/** Observe before other work: a native close event can precede rejection of already-invalidated operations. */
export class NativeRabbitClose {
  private closed = false;
  private closing: Promise<void> | undefined;
  private resolveClosed: () => void = () => {};
  private readonly confirmed: Promise<void>;
  private readonly observedClose = () => {
    this.closed = true;
    this.native.removeListener('close', this.observedClose);
    this.resolveClosed();
  };

  constructor(private readonly native: RabbitClosePort) {
    this.confirmed = new Promise((resolve) => { this.resolveClosed = resolve; });
    native.on('close', this.observedClose);
  }

  get isClosed(): boolean { return this.closed; }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closing ??= this.joinClose();
    return this.closing;
  }

  private joinClose(): Promise<void> {
    const operation = Promise.resolve().then(() => this.native.close()).catch(() => {
      if (!this.closed) throw new InfrastructureError('rabbit_prerequisite_failed');
    });
    // A confirmed transport close settles a pending RPC; late RPC rejections remain observed.
    return Promise.race([operation, this.confirmed]).then(() => this.observedClose());
  }
}
