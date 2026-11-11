import { verifyCheckpointAfterStop } from '../integration/scenarios';

const before = { kind: 'boundary', primaryHash: 'initial-native-boundary', hasUuidProgress: false };

test('checkpoint advancement during graceful stop is caught by post-stop read', async () => {
  let current = before;
  await expect(verifyCheckpointAfterStop(before, async () => {
    current = { kind: 'changeStream', primaryHash: 'late-progress', hasUuidProgress: true }; return 0;
  }, async () => current)).rejects.toThrow('unrouted_checkpoint_advanced_after_stop');
});

test('stable blocked checkpoint after confirmed graceful stop passes', async () => {
  const order: string[] = [];
  const after = await verifyCheckpointAfterStop(before, async () => { order.push('stopped'); return 0; }, async () => {
    order.push('majority-read'); return before;
  });
  expect(order).toEqual(['stopped', 'majority-read']); expect(after).toBe(before);
});

test('deadline or unclear stop outcome cannot be treated as no checkpoint advancement', async () => {
  const read = jest.fn(async () => before);
  await expect(verifyCheckpointAfterStop(before, async () => 124, read)).rejects.toThrow('producer_unrouted_stop_failed');
  expect(read).not.toHaveBeenCalled();
});
