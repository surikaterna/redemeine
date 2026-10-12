import { createHash } from 'node:crypto';
import { executeCapturedLogs } from '../integration/logProcess';
import { LogCapture, logLimits } from '../integration/logCapture';
import { executeBufferedCommand, Commands, commandFailure } from '../integration/commands';
import { Receipts } from '../integration/receipts';
import { budgets, QualificationError } from '../integration/plan';

const cwd = process.cwd();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => { jest.restoreAllMocks(); });

test('native bounded streaming drains >1MiB and an oversized line, retaining only allowlisted records and exact raw hashes', async () => {
  const large = JSON.stringify({ payload: 'amqp://secret-canary/' + 'x'.repeat(budgets.commandBytes * 2) }) + '\n';
  const safe = JSON.stringify({ phase: 'paused', reason: 'worker_paused', processedCommits: 1, uri: 'secret-canary' }) + '\n';
  const error = 'stderr-secret-canary\n';
  const script = `process.stdout.write(JSON.stringify({payload:'amqp://secret-canary/'+'x'.repeat(${budgets.commandBytes * 2})})+${JSON.stringify('\n')});process.stdout.write(${JSON.stringify(safe)});process.stderr.write(${JSON.stringify(error)});`;
  const result = await executeCapturedLogs(process.execPath, ['-e', script], cwd, 5000, new AbortController().signal);
  expect(result.code).toBe(0); expect(result.signal).toBeNull(); expect(result.logs?.rawBytes).toBeGreaterThan(budgets.commandBytes);
  expect(result.logs?.stdoutSha256).toBe(digest(large + safe)); expect(result.logs?.stderrSha256).toBe(digest(error));
  expect(result.stdout).not.toMatch(/secret-canary|amqp:\/\//); expect(Buffer.byteLength(result.stdout)).toBeLessThan(budgets.commandBytes);
  expect(JSON.parse(result.stdout)).toMatchObject({ observations: [{ phase: 'paused', reason: 'worker_paused', processedCommits: 1 }],
    oversizedLines: 1, truncated: true, fullHistory: false, unstructuredOutput: 'omitted' });
});

test('previous buffered collector reproduces capacity refusal on the same native >1MiB output mode', async () => {
  await expect(executeBufferedCommand(process.execPath, ['-e', `process.stdout.write('x'.repeat(${budgets.commandBytes * 2}));`],
    cwd, 5000, new AbortController().signal)).rejects.toThrow('qualification_command_deadline_or_capacity');
});

test('split chunks, oversized suffixes and record overflow remain bounded and explicitly truncated', () => {
  const capture = new LogCapture(); capture.push('stdout', Buffer.alloc(logLimits.lineBytes + 1, 120));
  capture.push('stdout', Buffer.from('{"phase":"external_active"}\n'));
  for (let i = 0; i < logLimits.records + 1; i += 1) capture.push('stderr', Buffer.from('{"phase":"paused"}\n'));
  const value = JSON.parse(capture.result().body);
  expect(value.observations).toHaveLength(logLimits.records); expect(value.oversizedLines).toBe(1); expect(value.omittedRecords).toBe(1);
  expect(value.observations).not.toContainEqual({ phase: 'external_active' }); expect(value.truncated).toBe(true);
});

test('nonzero native exit remains a command and cleanup failure, not successful truncated capture', async () => {
  const receipt = new Receipts('/tmp/opencode', '5c2ea80b79d4'); jest.spyOn(receipt, 'save').mockResolvedValue();
  const commands = new Commands(cwd, receipt, async () => executeCapturedLogs(process.execPath,
    ['-e', "process.stderr.write('secret-error');process.exitCode=7"], cwd, 5000, new AbortController().signal));
  commands.beginCleanup();
  await expect(commands.docker('collect_owned_logs', ['container', 'logs', '--tail', '200', 'owned'], new AbortController().signal))
    .rejects.toThrow('qualification_docker_command_failed');
  expect(receipt.commands[0]?.code).toBe(7);
  await expect(commands.docker('collect_owned_logs', ['container', 'logs', '--follow', 'owned'], new AbortController().signal))
    .rejects.toThrow('runner_admission_fenced');
  commands.closeFence();
  await expect(commands.docker('collect_owned_logs', ['container', 'logs', '--tail', '200', 'owned'], new AbortController().signal))
    .rejects.toThrow('runner_admission_fenced');
});

test('raw input capacity still fails, never merely flags truncation', async () => {
  const script = `const b=Buffer.alloc(65536,120);(async()=>{for(let i=0;i<600;i++)await new Promise(r=>process.stdout.write(b,r));})();`;
  await expect(executeCapturedLogs(process.execPath, ['-e', script], cwd, 5000, new AbortController().signal))
    .rejects.toThrow('qualification_log_input_capacity');
});

test('hung native child never succeeds: close is joined or explicitly unjoined at unchanged kill grace', async () => {
  const started = performance.now();
  const labels: string[] = [];
  const result = await executeCapturedLogs(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    cwd, 300, new AbortController().signal, { unjoined: (label) => labels.push(label) }).catch((error: unknown) => error);
  expect(result).toMatchObject(labels.length ? { reason: 'qualification_log_child_unjoined', firstCause: 'qualification_log_deadline', unjoined: true }
    : { reason: 'qualification_log_deadline' });
  expect(performance.now() - started).toBeLessThan(4500);
});

test('abort and spawn failure retain closed causes without raw errors', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(executeCapturedLogs(process.execPath, ['-e', 'setInterval(()=>{},1000)'], cwd, 5000, controller.signal))
      .rejects.toThrow('qualification_stopping');
  } finally { clearTimeout(timer); }
  await expect(executeCapturedLogs('/no-such-owned-test-binary', [], cwd, 1000, new AbortController().signal))
    .rejects.toThrow('qualification_spawn_failed');
  const error = new QualificationError('amqp://secret'); expect(commandFailure(error)).toBe('qualification_command_failed');
  Object.defineProperty(error, 'reason', { get() { throw new Error('getter-secret'); } });
  expect(commandFailure(error)).toBe('qualification_command_failed');
});
