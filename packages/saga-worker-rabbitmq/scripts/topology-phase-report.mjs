const MARKER = 'REDEMEINE_TOPOLOGY_PHASE:';
const SOURCE = 'integration/topology-real.integration.test.ts';
const PHASES = new Set([
  'setup-topology', 'inspect-topology', 'publish-routed', 'publish-wrong-partition', 'publish-wrong-tenant',
  'publish-wrong-collection', 'broker-restart', 'restore-topology', 'held-unack', 'ack-settlement',
  'dead-letter', 'mismatch-setup', 'mismatch-reply-406', 'restricted-user-setup', 'restricted-reply-403',
  'production-health', 'production-open', 'production-provision', 'production-inspect',
  'production-publisher-connect', 'production-publisher-publish', 'production-publisher-close',
  'production-delivery', 'production-wrong-partition', 'production-wrong-collection', 'production-wrong-tenant',
  'production-ready', 'production-reopen', 'production-retained-topology', 'production-retained-message',
  'production-reprovision', 'production-held-ack', 'production-dlq', 'production-close'
]);
const INVARIANTS = new Set([
  'declared-and-bound', 'broker-inspected', 'routed-confirmed', 'mandatory-return', 'queue-ready-one',
  'same-volume-restarted', 'queue-retained-one', 'held-unack-one', 'queue-acked-zero', 'single-ack',
  'dead-letter-visible', 'declaration-conflict', 'reply-code-406', 'restricted-channel', 'reply-code-403', 'broker-available',
  'owner-channel-open', 'publisher-connected', 'publisher-confirmed', 'publisher-closed', 'publisher-observed',
  'retained-before-provision', 'channel-closed'
]);
const CLASSES = new Set(['timeout', 'broker-reply', 'assertion', 'operation', 'blocked_on_broker_unavailable']);
const SUBPHASES = new Set(['docker-restart', 'app-ready', 'amqp-connect']);
const AMQP_CLASSES = new Set(['none', 'ECONNREFUSED', 'ETIMEDOUT', 'ACCESS_REFUSED', 'auth-failure', 'channel-close', 'unknown']);
const UNKNOWN = Object.freeze({ phase: 'unknown', invariant: 'unknown', errorClass: 'unknown', code: null,
  replyCode: null, expected: null, actual: null, source: SOURCE, line: 0 });

function safeNumber(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function safeAmqpCode(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999;
}

function validated(value) {
  if (!value || typeof value !== 'object' || !PHASES.has(value.phase) || !INVARIANTS.has(value.invariant) ||
      !CLASSES.has(value.errorClass) || value.source !== SOURCE || !Number.isSafeInteger(value.line) || value.line <= 0) return UNKNOWN;
  const restart = value.restartSubphase === undefined ? {} : validatedRestart(value);
  if (restart === null) return UNKNOWN;
  return { phase: value.phase, invariant: value.invariant, errorClass: value.errorClass,
    code: safeNumber(value.code), replyCode: safeNumber(value.replyCode), expected: safeNumber(value.expected),
    actual: safeNumber(value.actual), source: SOURCE, line: value.line, ...restart };
}

function validatedRestart(value) {
  if (!SUBPHASES.has(value.restartSubphase) || !AMQP_CLASSES.has(value.amqpErrorClass) ||
      !['restartDocker', 'restartApp', 'restartAmqp'].every((name) => typeof value[name] === 'boolean') ||
      (value.amqpCode !== null && !safeAmqpCode(value.amqpCode)) ||
      !['broker-restart', 'mismatch-setup', 'restricted-user-setup'].includes(value.phase)) return null;
  return { restartSubphase: value.restartSubphase, restartDocker: value.restartDocker,
    restartApp: value.restartApp, restartAmqp: value.restartAmqp, amqpErrorClass: value.amqpErrorClass,
    amqpCode: safeNumber(value.amqpCode) };
}

export function phaseFromJest(assertion) {
  const messages = [...(assertion.failureMessages ?? []), ...(assertion.failureDetails ?? []).map((detail) => detail?.message)];
  for (const message of messages) {
    if (typeof message !== 'string') continue;
    const token = message.match(/REDEMEINE_TOPOLOGY_PHASE:([A-Za-z0-9_-]+)/)?.[1];
    if (!token || token.length > 2048) continue;
    try { return validated(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))); }
    catch { return UNKNOWN; }
  }
  return UNKNOWN;
}

export { MARKER };
