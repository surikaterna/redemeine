export interface ChildResources {
  worker?: { stop(): Promise<void> };
  channel?: { close(): Promise<unknown> };
  rabbit?: { close(): Promise<unknown> };
  mongo: { close(): Promise<unknown> };
}

async function closeBounded(name: string, close: () => Promise<unknown>, timeoutMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([close(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cleanup deadline exceeded')), timeoutMs);
    })]);
    return null;
  } catch (error) {
    return `${name}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Always close all resources, even if an earlier stop failed; retain the original assertion error. */
export async function cleanupChildResources(resources: ChildResources, original?: unknown, timeoutMs = 3_000,
  report: (message: string) => void = (message) => process.stderr.write(`${message}\n`)
): Promise<void> {
  const failures: string[] = [];
  const { worker, channel, rabbit, mongo } = resources;
  const steps: Array<readonly [string, () => Promise<unknown>]> = [
    ...(worker ? [['worker.stop', () => worker.stop()] as const] : []),
    ...(channel ? [['channel.close', () => channel.close()] as const] : []),
    ...(rabbit ? [['rabbit.close', () => rabbit.close()] as const] : []),
    ['mongo.close', () => mongo.close()]
  ];
  for (const [name, close] of steps) {
    const failure = await closeBounded(name, close, timeoutMs);
    if (failure) failures.push(failure);
  }
  if (failures.length) {
    try { report(`Child cleanup failures: ${failures.join('; ')}`); } catch { /* Preserve the original failure. */ }
  }
  if (original !== undefined) throw original;
  if (failures.length) throw new Error(`Child cleanup failed: ${failures.join('; ')}`);
}
