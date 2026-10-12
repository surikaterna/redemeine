import { sha256 } from './main-image-plan.mjs';
import { canonicalTarPath, decodeTarHeader, decodePax, requireTar, payloadValidationReason } from './main-image-tar-format.mjs';
export { payloadValidationReason };

export function tarEntries(buffer, facts = {}) {
  requireTar(Buffer.isBuffer(buffer) && buffer.length <= 8388608 && buffer.length >= 1024 && buffer.length % 512 === 0, 'tar_capacity');
  facts.archiveBytes = buffer.length; facts.headers = 0; facts.paxLocal = 0; facts.paxGlobal = 0;
  const entries = []; const seen = new Set(); let offset = 0; let pending; let ended = false;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      requireTar(!pending && buffer.length - offset >= 1024 && buffer.subarray(offset).every((byte) => byte === 0), 'tar_footer_invalid'); ended = true; break;
    }
    requireTar(++facts.headers <= 1024, 'tar_capacity'); const row = decodeTarHeader(header);
    const end = offset + 512 + row.size; const next = offset + 512 + Math.ceil(row.size / 512) * 512;
    requireTar(next <= buffer.length, 'tar_truncated'); requireTar(buffer.subarray(end, next).every((byte) => byte === 0), 'tar_padding_invalid');
    const bytes = buffer.subarray(offset + 512, end); offset = next;
    if (row.type === 'x' || row.type === 'g') {
      const metadata = decodePax(bytes, row.type === 'g');
      if (row.type === 'g') { requireTar(!pending, 'tar_pax_scope_refused'); facts.paxGlobal++; }
      else { requireTar(!pending, 'tar_pax_scope_refused'); pending = metadata; facts.paxLocal++; }
      continue;
    }
    row.name = pending?.path ?? row.name; pending = undefined;
    requireTar(row.type !== '5' || row.size === 0, 'tar_entry_type_refused');
    requireTar(row.name !== '' || row.type === '5', 'tar_path_refused');
    requireTar(!seen.has(row.name), 'tar_duplicate_path'); seen.add(row.name);
    entries.push({ ...row, bytes });
  }
  requireTar(ended, 'tar_footer_invalid'); facts.entries = entries.length;
  return entries;
}

export function checkPayload(buffer, facts = {}) {
  const rows = tarEntries(buffer, facts); const files = rows.filter((row) => row.type === '0' || row.type === '');
  const seen = new Set(); facts.fileFacts = [];
  for (const row of rows) {
    row.name = canonicalTarPath(row.name, true); requireTar(!seen.has(row.name), 'tar_duplicate_path'); seen.add(row.name);
    if (row.type === '5') requireTar(['', 'licenses', 'definitions'].includes(row.name), 'payload_entry_refused');
  }
  const find = (name) => { const row = files.find((row) => row.name === name); requireTar(row, 'payload_file_missing'); return row; };
  for (const row of files) {
    const important = ['main.js', 'artifact.json', 'build-lock.sha256', 'package.json'].includes(row.name);
    requireTar(facts.fileFacts.length < 64, 'tar_capacity');
    facts.fileFacts.push({ nameHash: sha256(row.name), type: row.type || '0', bytes: row.size, mode: row.mode, uid: row.uid, gid: row.gid, important });
    requireTar(['main.js', 'artifact.json', 'build-lock.sha256', 'package.json', 'LICENSE'].includes(row.name) || /^licenses\/[a-zA-Z0-9_.-]{1,128}$/.test(row.name), 'payload_entry_refused');
    requireTar((row.mode & 4) !== 0, 'payload_not_readable');
    if (important) {
      requireTar(row.uid === 0 && row.gid === 0, 'payload_not_root_owned'); requireTar(row.mode === 0o644, 'payload_mode_invalid');
    }
  }
  return validatePayloadDocuments(find, files, facts);
}

function parseDocument(bytes) {
  try { return JSON.parse(bytes); } catch { throw Object.assign(new Error('payload_metadata_invalid'), { code: 'payload_metadata_invalid' }); }
}
function validatePayloadDocuments(find, files, facts) {
  const artifact = parseDocument(find('artifact.json').bytes);
  requireTar(artifact && typeof artifact === 'object' && !Array.isArray(artifact)
    && typeof artifact.digest === 'string' && /^[a-f0-9]{64}$/.test(artifact.digest), 'payload_metadata_invalid');
  const { digest, ...payload } = artifact; facts.observedArtifact = digest; facts.mainHash = sha256(find('main.js').bytes);
  requireTar(sha256(JSON.stringify(payload)) === digest, 'payload_artifact_digest_mismatch');
  requireTar(artifact.files && facts.mainHash === artifact.files['main.js'], 'payload_main_hash_mismatch');
  requireTar(find('build-lock.sha256').bytes.toString().trim() === artifact.lockDigest, 'payload_lock_mismatch');
  requireTar(!find('main.js').bytes.toString().includes('ModelCounter'), 'payload_fixture_refused');
  requireTar(parseDocument(find('package.json').bytes)?.type === 'module', 'payload_package_invalid');
  const notices = parseDocument(find('licenses/DEPENDENCIES.json').bytes); requireTar(Array.isArray(notices) && notices.length > 0, 'payload_notices_invalid'); find('LICENSE');
  return { artifact: digest, main: facts.mainHash, files: files.map((row) => ({ name: row.name, hash: sha256(row.bytes), mode: row.mode, uid: row.uid, gid: row.gid, type: row.type })) };
}
