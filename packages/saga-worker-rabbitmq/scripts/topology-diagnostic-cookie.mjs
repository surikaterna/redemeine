import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { createOwned, inspectOwned, OWNER_LABEL, ownedResources } from './topology-runner-ownership.mjs';
import { verifiedContainerState } from './topology-diagnostic-core.mjs';

const COMMAND = "id -u rabbitmq; id -g rabbitmq; getent passwd rabbitmq; stat -c 'dir:%u:%g:%a' /var/lib/rabbitmq; stat -c 'cookie:%u:%g:%a' /var/lib/rabbitmq/.erlang.cookie";

export function helperOwnership(main) {
  return ownedResources({ ...main.names, container: `${main.runId}-helper` }, main.runId);
}

export function cookieHelperArgs(main, helper) {
  return ['create', '--name', helper.names.container, '--label', `${OWNER_LABEL}=${main.runId}`, '--network', 'none',
    '--mount', `source=${main.names.volume},target=/var/lib/rabbitmq,readonly`,
    '--entrypoint', '/bin/sh', RABBIT_IMAGE, '-c', COMMAND];
}

function metadata(line, prefix) {
  const match = line?.match(new RegExp(`^${prefix}:([0-9]+):([0-9]+):([0-7]{3,4})$`));
  return match ? { uid: Number(match[1]), gid: Number(match[2]), mode: match[3] } : null;
}

export function parseCookieMetadata(result) {
  const lines = result.stdout?.trim().split(/\r?\n/) ?? [];
  const uid = /^[0-9]+$/.test(lines[0]) ? Number(lines[0]) : null;
  const gid = /^[0-9]+$/.test(lines[1]) ? Number(lines[1]) : null;
  const user = lines[2]?.match(/^rabbitmq:[^:]*:([0-9]+):([0-9]+):/);
  const directory = metadata(lines.find((line) => line.startsWith('dir:')), 'dir');
  const cookie = metadata(lines.find((line) => line.startsWith('cookie:')), 'cookie');
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || !user || uid !== Number(user[1]) || gid !== Number(user[2])) {
    return { status: 'identity-unavailable' };
  }
  if (!directory) return { status: 'directory-metadata-unavailable', rabbitUid: uid, rabbitGid: gid };
  if (!cookie) return { status: /\.erlang\.cookie.*No such file or directory/i.test(result.stderr ?? '') ? 'cookie-missing' : 'cookie-metadata-unavailable',
    rabbitUid: uid, rabbitGid: gid, directory };
  return { status: result.code === 0 ? 'ok' : 'helper-exited-nonzero', rabbitUid: uid, rabbitGid: gid, directory, cookie };
}

export async function inspectCookieMetadata(docker, main, helper) {
  await verifiedContainerState(docker, main);
  const volume = await inspectOwned(docker, main, 'volume');
  if (!volume?.owned || volume.id !== main.ids.volume) throw new Error('owned volume identity not verified');
  if (await inspectOwned(docker, helper, 'container')) throw new Error('helper name collision');
  helper.preflight = true;
  const id = await createOwned(docker, helper, 'container', cookieHelperArgs(main, helper));
  const result = await docker(['start', '-a', id], { allowed: true, cleanup: true, timeoutMs: 5_000, maxOutputBytes: 2048 });
  return parseCookieMetadata(result);
}

export async function cleanupCookieHelper(docker, helper) {
  const inspected = await inspectOwned(docker, helper, 'container');
  if (!inspected) return { absent: true, action: 'absent' };
  if (!helper.attempted.has('container') || helper.collisions.has('container') || !inspected.owned ||
      (helper.ids.container && helper.ids.container !== inspected.id)) return { absent: false, action: 'preserved-unverified' };
  const result = await docker(['rm', '-f', inspected.id], { allowed: true, cleanup: true, timeoutMs: 5_000 });
  const absent = await inspectOwned(docker, helper, 'container') === null;
  return { absent: absent && result.code === 0, action: 'removed', removalCode: result.code, id: inspected.id };
}
