/** Supervise the CLI, not daemon-side completion of Docker effects. */
class ChildSupervisor {
  constructor(child, options, resolve) {
    this.child = child; this.options = options; this.resolve = resolve;
    this.now = options.now ?? (() => performance.now()); this.started = options.started ?? this.now(); this.deadline = options.deadline ?? this.started + options.milliseconds;
    this.buffers = [[], []]; this.bytes = 0; this.spawned = Number.isInteger(child.pid); this.settled = false;
    this.terminating = false; this.reason = undefined; this.secondary = []; this.signal = options.signal;
  }

  start() {
    this.child.on('spawn', () => { this.spawned = true; });
    this.child.on('error', (error) => this.error(error));
    this.child.on('close', (code, signal) => this.close(code, signal));
    [this.child.stdout, this.child.stderr].forEach((stream, index) => {
      stream?.on('error', () => this.fail('command_pipe_error'));
      stream?.on('data', (buffer) => this.data(buffer, index));
    });
    this.abort = () => this.fail('packaging_interrupted');
    this.signal?.addEventListener('abort', this.abort);
    this.timer = setTimeout(() => this.fail('command_timeout'), Math.max(0, this.deadline - this.now()));
    if (this.signal?.aborted) this.abort();
    if (this.now() >= this.deadline) this.fail('command_timeout');
  }

  error(error) {
    if (this.settled) return;
    if (!this.spawned && this.child.pid === undefined && ['ENOENT', 'EACCES', 'ENOEXEC', 'E2BIG'].includes(error?.code)) {
      this.reason ??= 'command_spawn_failed'; this.finish(null, null, true, true); return;
    }
    this.fail('command_child_error');
  }

  data(buffer, index) {
    if (this.settled) return;
    if (this.now() >= this.deadline) this.fail('command_timeout');
    this.bytes += buffer.length;
    if (this.bytes > this.options.limit) { this.fail('command_output_capacity'); return; }
    this.buffers[index].push(buffer);
  }

  fail(reason) {
    if (this.settled) return;
    this.reason ??= reason;
    if (this.terminating) return;
    this.terminating = true; // A synchronous kill error cannot recursively start termination.
    const grace = this.options.graceMilliseconds ?? 2000;
    this.graceDeadline = this.now() + grace;
    this.grace = setTimeout(() => this.finish(null, 'unjoined', false, false), grace);
    this.killTimer = setTimeout(() => this.kill('SIGKILL'), Math.floor(grace / 2));
    this.kill('SIGTERM');
  }

  kill(signal) {
    if (this.settled) return;
    try { if (!this.child.kill(signal)) this.secondary.push('signal_not_sent'); }
    catch { this.secondary.push('signal_failed'); }
  }

  close(code, signal) {
    if (this.settled) return;
    if (this.now() >= this.deadline) this.reason ??= 'command_timeout';
    if (this.signal?.aborted) this.reason ??= 'packaging_interrupted';
    if (this.terminating && this.now() >= this.graceDeadline) { this.finish(code, signal, false, false); return; }
    this.finish(code, signal, true, false);
  }

  finish(code, signal, cliJoined, nativeNoSpawn) {
    if (this.settled) return; this.settled = true;
    clearTimeout(this.timer); clearTimeout(this.grace); clearTimeout(this.killTimer);
    this.signal?.removeEventListener('abort', this.abort);
    if (!cliJoined) {
      this.reason ??= 'command_unjoined';
      for (const stream of [this.child.stdout, this.child.stderr]) { try { stream?.destroy(); } catch { this.secondary.push('pipe_detach_failed'); } }
      try { this.child.unref(); } catch { this.secondary.push('child_detach_failed'); }
    }
    const stdout = Buffer.concat(this.buffers[0]); const stderr = Buffer.concat(this.buffers[1]);
    const finished = this.now(); if (finished >= this.deadline) this.reason ??= 'command_timeout';
    this.resolve({ code, signal, reason: this.reason, cliJoined, nativeNoSpawn, secondary: this.secondary, stdout, stderr, bytes: this.bytes,
      elapsedMilliseconds: Math.max(0, finished - this.started) });
  }
}

export function superviseChild(child, options) {
  return new Promise((resolve) => new ChildSupervisor(child, options, resolve).start());
}

export function noSpawnResult() {
  return { code: null, signal: null, reason: 'command_spawn_failed', cliJoined: true, nativeNoSpawn: true,
    secondary: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), bytes: 0 };
}

export function armFailureExit() {
  setTimeout(() => process.exit(1), 2000).unref();
}
