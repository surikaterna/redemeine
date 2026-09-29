async function waitForRabbitApp({ probe, isExited, interrupted = () => false, onAttempt = () => undefined,
  onProbe = () => undefined, deadlineMs = 90_000, probeMs = 5_000, delayMs = 500 }) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline && !interrupted()) {
    onAttempt();
    let ready = true;
    for (const command of ['ping', 'check_running']) {
      if (interrupted() || Date.now() >= deadline) { ready = false; break; }
      const duration = Math.max(1, Math.min(probeMs, deadline - Date.now()));
      const outcome = await probe(command, duration);
      onProbe(command, outcome);
      if (outcome.code !== 0) { ready = false; break; }
    }
    if (ready && !interrupted()) return;
    if (interrupted()) break;
    if (await isExited()) throw new Error('Rabbit container exited before application ready');
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(interrupted() ? 'Rabbit readiness interrupted by external signal' : 'Rabbit readiness deadline exceeded');
}

module.exports.waitForRabbitApp = waitForRabbitApp;
