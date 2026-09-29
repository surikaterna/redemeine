import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { createOwned, inspectOwned, OWNER_LABEL, ownedResources } from './topology-runner-ownership.mjs';
import { cleanupCookieHelper } from './topology-diagnostic-cookie.mjs';

// Only the run-owned volume is writable; the shell never reads cookie bytes.
const COOKIE_COMMAND = `set -eu
cookie=/var/lib/rabbitmq/.erlang.cookie
uid=$(id -u rabbitmq)
gid=$(id -g rabbitmq)
[ "$uid:$gid" = "100:101" ] || exit 41
[ -e "$cookie" ] || exit 42
before=$(stat -c '%F:%h:%u:%g:%a' "$cookie") || exit 42
case "$before" in
  'regular file:1:0:0:400') chown -h 100:101 "$cookie" ;;
  'regular file:1:100:101:400') ;;
  *) exit 43 ;;
esac
after=$(stat -c '%F:%h:%u:%g:%a' "$cookie") || exit 44
[ "$after" = 'regular file:1:100:101:400' ] || exit 44`;

export function prepOwnership(main) {
  return ownedResources({ ...main.names, container: `${main.runId}-cookie-prep` }, main.runId);
}

export function cookiePrepArgs(main, helper) {
  return ['create', '--name', helper.names.container, '--label', `${OWNER_LABEL}=${main.runId}`, '--network', 'none',
    '--mount', `source=${main.names.volume},target=/var/lib/rabbitmq`, '--user', '0:0',
    '--entrypoint', '/bin/sh', RABBIT_IMAGE, '-c', COOKIE_COMMAND];
}

export async function runCookiePrep(docker, main, helper) {
  const volume = await inspectOwned(docker, main, 'volume');
  if (!volume?.owned || volume.id !== main.ids.volume) throw new Error('cookie prep owned volume not verified');
  if (await inspectOwned(docker, helper, 'container')) throw new Error('cookie prep helper name collision');
  helper.preflight = true;
  const id = await createOwned(docker, helper, 'container', cookiePrepArgs(main, helper));
  const result = await docker(['start', '-a', id], { allowed: true, cleanup: true, timeoutMs: 5_000, maxOutputBytes: 1024 });
  const verified = await inspectOwned(docker, helper, 'container');
  if (!verified?.owned || verified.id !== id) throw new Error('cookie prep helper identity mismatch');
  const state = await docker(['container', 'inspect', id, '--format', '{{json .State}}'],
    { allowed: true, cleanup: true, timeoutMs: 5_000, maxOutputBytes: 2048 });
  if (state.code !== 0) throw new Error('cookie prep state unavailable');
  const exited = JSON.parse(state.stdout);
  if (result.code !== 0 || exited.Status !== 'exited' || exited.ExitCode !== 0 || exited.OOMKilled === true) {
    throw new Error('cookie prep rejected unsafe or unavailable cookie metadata');
  }
  return { status: 'prepared', rabbitUid: 100, rabbitGid: 101, mode: '0400', linkCount: 1 };
}

export async function prepareCookieBeforeRabbit(docker, main, helper, receipt) {
  let failure;
  let prepared;
  try { prepared = await runCookiePrep(docker, main, helper); }
  catch { failure = new Error('cookie ownership preparation failed closed'); }
  try {
    receipt.cookiePrepCleanup = await cleanupCookieHelper(docker, helper);
    if (!receipt.cookiePrepCleanup.absent) throw new Error('cookie prep helper not verified absent');
  } catch { throw new Error('cookie prep helper cleanup failed closed'); }
  if (failure) throw failure;
  return prepared;
}
