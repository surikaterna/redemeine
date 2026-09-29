export const OWNER_LABEL = 'redemeine.fyp3.3.run';
const KINDS = ['network', 'volume', 'container'];

export function ownedResources(names, runId) {
  if (!/^topology-[a-f0-9]{32}$/.test(runId) || !KINDS.every((kind) => names[kind]?.startsWith(runId))) {
    throw new Error('invalid owned resource identity');
  }
  return { names, runId, attempted: new Set(), collisions: new Set(), ids: {}, preflight: false };
}

function missing(result, kind, name) {
  if (result.code !== 1 || typeof result.stderr !== 'string') return false;
  const exactName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const formats = {
    network: `Error response from daemon: network ${exactName} not found`,
    volume: `Error response from daemon: get ${exactName}: no such volume`,
    container: `(?:Error: No such container: ${exactName}|Error response from daemon: No such container: ${exactName})`
  };
  return new RegExp(`^${formats[kind]}$`).test(result.stderr.trim());
}

export async function inspectOwned(docker, state, kind) {
  const result = await docker([kind, 'inspect', state.names[kind], '--format', '{{json .}}'], { allowed: true, cleanup: true });
  if (missing(result, kind, state.names[kind])) return null;
  if (result.code !== 0) throw new Error(`cannot verify ${kind} ownership: ${result.stderr}`);
  const object = JSON.parse(result.stdout);
  const id = kind === 'volume' ? object.Name : object.Id;
  const labels = kind === 'container' ? object.Config?.Labels : object.Labels;
  const actualName = kind === 'container' ? object.Name?.replace(/^\//, '') : object.Name;
  if (typeof id !== 'string' || !id || actualName !== state.names[kind]) {
    throw new Error(`${kind} inspect identity/name mismatch`);
  }
  return { id, owned: labels?.[OWNER_LABEL] === state.runId };
}

export async function preflightOwned(docker, state) {
  for (const kind of KINDS) {
    if (await inspectOwned(docker, state, kind)) throw new Error(`${kind} name collision before creation`);
  }
  state.preflight = true;
}

export async function createOwned(docker, state, kind, args) {
  if (!state.preflight || !KINDS.includes(kind)) throw new Error('owned resource preflight required');
  if (await inspectOwned(docker, state, kind)) {
    state.collisions.add(kind);
    throw new Error(`${kind} name collision before creation`);
  }
  state.attempted.add(kind);
  let result;
  try {
    result = await docker(args);
  } catch (error) {
    if (/already exists|already in use|conflict/i.test(String(error))) state.collisions.add(kind);
    throw error;
  }
  const inspected = await inspectOwned(docker, state, kind);
  if (!inspected?.owned || inspected.id !== result.stdout) throw new Error(`${kind} creation ownership/identity mismatch`);
  state.ids[kind] = inspected.id;
  return inspected.id;
}

async function removeOne(docker, state, kind) {
  if (!state.attempted.has(kind) || state.collisions.has(kind)) return { kind, action: 'skipped' };
  const inspected = await inspectOwned(docker, state, kind);
  if (!inspected) return { kind, action: 'absent' };
  if (!inspected.owned || (state.ids[kind] && state.ids[kind] !== inspected.id)) {
    return { kind, action: 'preserved-unverified' };
  }
  const target = state.ids[kind] ?? inspected.id;
  const args = kind === 'container' ? ['rm', '-f', target] : [kind, 'rm', target];
  const removal = await docker(args, { allowed: true, cleanup: true });
  return { kind, action: 'removed', removalCode: removal.code, id: target };
}

export async function cleanupOwned(docker, state) {
  const actions = [];
  for (const kind of [...KINDS].reverse()) {
    try { actions.push(await removeOne(docker, state, kind)); }
    catch (error) { actions.push({ kind, action: 'inspect-or-remove-failed', error: String(error) }); }
  }
  const postCleanup = [];
  for (const kind of KINDS) {
    try { postCleanup.push({ kind, resource: await inspectOwned(docker, state, kind) }); }
    catch (error) { postCleanup.push({ kind, error: String(error) }); }
  }
  const absent = actions.every(({ action }) => !['preserved-unverified', 'inspect-or-remove-failed'].includes(action)) &&
    postCleanup.every(({ resource, error }) => resource === null && !error);
  return { actions, postCleanup, absent };
}
