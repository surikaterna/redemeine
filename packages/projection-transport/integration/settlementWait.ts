/** Clears the deadline on every exit, including a prompt broker settlement or failure. */
export async function waitForSettlement(settled: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([settled, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Child settlement timeout.')), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
