import { writeFile, lstat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

const pnpmCodes = ['ERR_PNPM_WORKSPACE_PKG_NOT_FOUND', 'ERR_PNPM_OUTDATED_LOCKFILE', 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH',
  'ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE', 'ERR_PNPM_NO_MATCHING_VERSION', 'ERR_PNPM_FETCH_404', 'ERR_PNPM_FETCH_401',
  'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL', 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL', 'ERR_PNPM_UNSUPPORTED_ENGINE'];
const reasons = ['command_spawn_failed', 'command_child_error', 'command_pipe_error', 'packaging_interrupted',
  'command_timeout', 'command_output_capacity', 'command_unjoined'];

function recordsForLine(line, context) {
  if (line.length > 16384) return [{ kind: 'diagnostic_line_omitted' }];
  const records = []; const clean = stripVTControlCharacters(line);
  const step = /^Step ([0-9]{1,3})\/([0-9]{1,3}) : (FROM|WORKDIR|RUN|COPY|ARG|LABEL|USER|ENV|STOPSIGNAL|HEALTHCHECK|ENTRYPOINT)\b/.exec(clean);
  if (step) records.push({ kind: 'docker_step', step: Number(step[1]), total: Number(step[2]), instruction: step[3] });
  for (const code of pnpmCodes) {
    if (!clean.includes(code)) continue;
    const packages = [...new Set(clean.match(/@redemeine\/[a-z][a-z0-9-]{0,63}/g) ?? [])].filter((name) => context.packageNames.includes(name));
    records.push({ kind: 'pnpm_error', code, packages });
  }
  const npm = /(?:npm (?:ERR!|error) code|\bcode:)\s*(E[A-Z0-9_]{1,30})\b/.exec(clean);
  if (npm && ['E404', 'E401', 'E403', 'EBADENGINE', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(npm[1])) records.push({ kind: 'npm_error', code: npm[1] });
  const typescript = /\berror TS([0-9]{4,5})\b/.exec(clean);
  if (typescript) records.push({ kind: 'typescript_error', code: `TS${typescript[1]}` });
  if (/manifest (?:unknown|for .* not found)/.test(clean)) records.push({ kind: 'docker_manifest_unavailable' });
  if (/COPY failed|failed to compute cache key/.test(clean)) records.push({ kind: 'docker_copy_failed' });
  const exit = /returned a non-zero code: ([0-9]{1,3})\b/.exec(clean);
  if (exit) records.push({ kind: 'docker_command_failed', code: Number(exit[1]) });
  return records;
}

/** Persist only closed diagnostic facts; never arbitrary log lines or error messages. */
export function buildDiagnostics(result, context) {
  assert.ok(result.stdout.length + result.stderr.length <= 1048576, 'diagnostic_capacity');
  const records = []; const seen = new Set(); let omitted = false;
  const lines = [result.stdout, result.stderr].flatMap((stream) => stream.toString('utf8').split('\n'));
  for (const line of lines) {
    for (const row of recordsForLine(line, context)) {
        const key = JSON.stringify(row); if (seen.has(key)) continue; seen.add(key);
        if (records.length === 64) { omitted = true; continue; } records.push(row);
    }
  }
  return { version: 1, code: Number.isInteger(result.code) ? result.code : null,
    reason: result.reason === undefined ? null : reasons.includes(result.reason) ? result.reason : 'unknown_cli_failure', cliJoined: result.cliJoined === true,
    elapsedMilliseconds: typeof result.elapsedMilliseconds === 'number' && Number.isFinite(result.elapsedMilliseconds) && result.elapsedMilliseconds >= 0 ? result.elapsedMilliseconds : null, records, omitted,
    diagnosticStatus: records.length ? 'allowlisted_facts_only' : 'no_allowlisted_diagnostic' };
}

export async function persistBuildDiagnostics(directory, result, context, dependencies = {}) {
  const milliseconds = dependencies.milliseconds ?? 2000;
  assert.ok(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 2000, 'diagnostic_budget_refused');
  const now = dependencies.now ?? (() => performance.now()); const deadline = now() + milliseconds;
  let expired = false; let timer;
  const check = () => { if (expired || now() >= deadline) throw new Error('diagnostic_capture_unproven'); };
  const interrupted = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('diagnostic_capture_unproven')); }, milliseconds);
  });
  // Start supervision before metadata I/O; late metadata may never admit a new write.
  const capture = async () => {
    check(); const stat = await (dependencies.lstat ?? lstat)(directory); check();
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700, 'diagnostic_directory_refused');
    const facts = buildDiagnostics(result, context); const text = `${JSON.stringify(facts, null, 2)}\n`;
    assert.ok(Buffer.byteLength(text) <= 32768, 'diagnostic_capacity'); check();
    await (dependencies.writeFile ?? writeFile)(`${directory}/build-diagnostics.json`, text, { flag: 'wx', mode: 0o600 });
    check(); return facts;
  };
  const pending = capture(); void pending.catch(() => {}); void interrupted.catch(() => {});
  try {
    const facts = await Promise.race([pending, interrupted]); check(); return facts;
  } finally { clearTimeout(timer); }
}
