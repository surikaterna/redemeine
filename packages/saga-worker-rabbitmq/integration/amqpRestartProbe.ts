import { connect, type ChannelModel, type SocketOptions } from 'amqplib';

type ConnectFn = (url: string, options: SocketOptions) => Promise<ChannelModel>;

function discardLate(model: ChannelModel): void {
  model.on('error', () => undefined);
  const connection = model.connection as typeof model.connection & { stream?: { destroy(): void } };
  connection.stream?.destroy();
  try { void model.close().catch(() => undefined); }
  catch { /* A destroyed connection may reject synchronously. */ }
}

export async function probeAmqpConnect(url: string, timeoutMs: number, connectFn: ConnectFn = connect): Promise<void> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connecting = connectFn(url, { timeout: timeoutMs });
  void connecting.then((model) => { if (expired) discardLate(model); }).catch(() => undefined);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('AMQP connect probe timed out')); }, timeoutMs);
  });
  let model: ChannelModel;
  try { model = await Promise.race([connecting, deadline]); }
  finally { if (timer) clearTimeout(timer); }
  model.on('error', () => undefined);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([model.close(), new Promise<never>((_, reject) => {
      closeTimer = setTimeout(() => { discardLate(model); reject(new Error('AMQP close probe timed out')); }, timeoutMs);
    })]);
  } catch (error) {
    discardLate(model);
    throw error;
  } finally { if (closeTimer) clearTimeout(closeTimer); }
}

export async function waitForAmqpAfterRestart(url: string, onFailure: (error: unknown) => void,
  connectFn: ConnectFn = connect, deadlineMs = 15_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try { await probeAmqpConnect(url, Math.max(1, Math.min(5_000, until - Date.now())), connectFn); return; }
    catch (error) { onFailure(error); }
    if (Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())));
  }
  throw new Error('AMQP reconnect deadline exceeded');
}
