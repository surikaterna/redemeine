import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { createOwned, inspectOwned, OWNER_LABEL, preflightOwned } from './topology-runner-ownership.mjs';
import { cleanupCookieHelper, helperOwnership } from './topology-diagnostic-cookie.mjs';
import { verifiedContainerState } from './topology-diagnostic-core.mjs';

const COMMAND = "id -u rabbitmq; id -g rabbitmq; stat -c 'dir:%F:%h:%u:%g:%a' /var/lib/rabbitmq; stat -c 'cookie:%F:%h:%u:%g:%a' /var/lib/rabbitmq/.erlang.cookie";

export function prebootContainerArgs(main) {
  return ['create', '--name', main.names.container, '--label', `${OWNER_LABEL}=${main.runId}`, '--network', 'none',
    '--mount', `source=${main.names.volume},target=/var/lib/rabbitmq`, RABBIT_IMAGE];
}

export function prebootHelperArgs(main, helper) {
  return ['create', '--name', helper.names.container, '--label', `${OWNER_LABEL}=${main.runId}`, '--network', 'none',
    '--mount', `source=${main.names.volume},target=/var/lib/rabbitmq,readonly`,
    '--entrypoint', '/bin/sh', RABBIT_IMAGE, '-c', COMMAND];
}

function parsedStat(line, prefix) {
  const match = line?.match(new RegExp(`^${prefix}:([^:]+):([0-9]+):([0-9]+):([0-9]+):([0-7]{3,4})$`));
  return match ? { type: match[1] === 'regular file' ? 'regular' : match[1] === 'symbolic link' ? 'symlink' :
    match[1] === 'directory' ? 'directory' : 'other', links: Number(match[2]), uid: Number(match[3]),
    gid: Number(match[4]), mode: match[5] } : null;
}

export function parsePrebootMetadata(result) {
  const lines = result.stdout?.trim().split(/\r?\n/) ?? [];
  const uid = /^[0-9]+$/.test(lines[0]) ? Number(lines[0]) : null;
  const gid = /^[0-9]+$/.test(lines[1]) ? Number(lines[1]) : null;
  const directory = parsedStat(lines.find((line) => line.startsWith('dir:')), 'dir');
  const cookie = parsedStat(lines.find((line) => line.startsWith('cookie:')), 'cookie');
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || directory?.type !== 'directory') {
    return { status: 'metadata-unavailable', cookieExists: null };
  }
  const base = { rabbitUid: uid, rabbitGid: gid, directory };
  if (cookie && result.code === 0) return { status: 'captured', ...base, cookieExists: true, cookie,
    regular: cookie.type === 'regular', nonSymlink: cookie.type !== 'symlink' };
  if (!cookie && result.code !== 0 && /\.erlang\.cookie.*No such file or directory/i.test(result.stderr ?? '')) {
    return { status: 'cookie-absent', ...base, cookieExists: false };
  }
  return { status: 'metadata-unavailable', ...base, cookieExists: null };
}

export async function createPrebootResources(docker, main) {
  await preflightOwned(docker, main);
  await docker(['pull', RABBIT_IMAGE]);
  await createOwned(docker, main, 'volume', ['volume', 'create', '--label', `${OWNER_LABEL}=${main.runId}`, main.names.volume]);
  await createOwned(docker, main, 'container', prebootContainerArgs(main));
}

export async function inspectPreboot(docker, main, helper) {
  const state = await verifiedContainerState(docker, main);
  if (state.status !== 'created' || state.running) throw new Error('preboot main container unexpectedly started');
  const volume = await inspectOwned(docker, main, 'volume');
  if (!volume?.owned || volume.id !== main.ids.volume) throw new Error('preboot owned volume unverified');
  if (await inspectOwned(docker, helper, 'container')) throw new Error('preboot helper collision');
  helper.preflight = true;
  const id = await createOwned(docker, helper, 'container', prebootHelperArgs(main, helper));
  const result = await docker(['start', '-a', id], { allowed: true, cleanup: true, timeoutMs: 5_000, maxOutputBytes: 2048 });
  const metadata = parsePrebootMetadata(result);
  if (metadata.status === 'metadata-unavailable') throw new Error('preboot metadata not established');
  return { main: state, metadata };
}

export { cleanupCookieHelper, helperOwnership };
