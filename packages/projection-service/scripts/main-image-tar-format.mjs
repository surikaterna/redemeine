const codes = ['tar_capacity', 'tar_truncated', 'tar_checksum_invalid', 'tar_format_unsupported', 'tar_numeric_invalid', 'tar_padding_invalid',
  'tar_path_refused', 'tar_entry_type_refused', 'tar_duplicate_path', 'tar_footer_invalid', 'tar_pax_invalid', 'tar_pax_key_unsupported', 'tar_pax_scope_refused',
  'payload_entry_refused', 'payload_file_missing', 'payload_not_readable', 'payload_not_root_owned', 'payload_mode_invalid', 'payload_metadata_invalid',
  'payload_artifact_digest_mismatch', 'payload_main_hash_mismatch', 'payload_lock_mismatch', 'payload_fixture_refused', 'payload_package_invalid',
  'payload_notices_invalid', 'image_worker_digest_mismatch'];
export function payloadValidationReason(error) { return codes.includes(error?.code) ? error.code : undefined; }
export function requireTar(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }

function octal(field) {
  let start = 0; let end = field.length;
  while (start < end && [0, 32].includes(field[start])) start++;
  while (end > start && [0, 32].includes(field[end - 1])) end--;
  const value = field.subarray(start, end).toString('ascii');
  requireTar([...field.subarray(start, end)].every((byte) => byte >= 48 && byte <= 55), 'tar_numeric_invalid');
  const number = value ? Number.parseInt(value, 8) : 0;
  requireTar(Number.isSafeInteger(number) && number >= 0, 'tar_numeric_invalid'); return number;
}
function text(field) {
  const end = field.indexOf(0); const bytes = end < 0 ? field : field.subarray(0, end);
  requireTar(end < 0 || field.subarray(end).every((byte) => byte === 0), 'tar_path_refused');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Object.assign(new Error('tar_path_refused'), { code: 'tar_path_refused' }); }
}
export function canonicalTarPath(name, stripApp = false) {
  requireTar(typeof name === 'string' && name.length <= 4096 && !name.startsWith('/') && !name.includes('\\')
    && [...name].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'tar_path_refused');
  const parts = name.split('/'); requireTar(!parts.includes('..'), 'tar_path_refused');
  const canonical = parts.filter((part) => part !== '' && part !== '.');
  if (stripApp && canonical[0] === 'app') canonical.shift();
  return canonical.join('/');
}
export function decodeTarHeader(header) {
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
  requireTar(sum === octal(header.subarray(148, 156)), 'tar_checksum_invalid');
  const magic = text(header.subarray(257, 263));
  requireTar(magic === 'ustar' && header.subarray(263, 265).equals(Buffer.from('00'))
    && header.subarray(500).every((byte) => byte === 0), 'tar_format_unsupported');
  const prefix = text(header.subarray(345, 500)); const suffix = text(header.subarray(0, 100));
  const type = header[156] === 0 ? '' : String.fromCharCode(header[156]);
  requireTar(['', '0', '5', 'x', 'g'].includes(type), 'tar_entry_type_refused');
  requireTar(text(header.subarray(157, 257)) === '', 'tar_entry_type_refused');
  return { name: canonicalTarPath(prefix ? `${prefix}/${suffix}` : suffix), type, size: octal(header.subarray(124, 136)),
    mode: octal(header.subarray(100, 108)), uid: octal(header.subarray(108, 116)), gid: octal(header.subarray(116, 124)) };
}

/** PAX subset cannot override sizes, ownership, links, sparse data or arbitrary xattrs. */
export function decodePax(bytes, global = false) {
  requireTar(bytes.length <= 16384, 'tar_capacity'); const records = {}; let offset = 0; let count = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset); requireTar(space > offset && space - offset <= 6, 'tar_pax_invalid');
    const lengthBytes = bytes.subarray(offset, space);
    requireTar(lengthBytes.every((byte) => byte >= 48 && byte <= 57), 'tar_pax_invalid');
    const lengthText = lengthBytes.toString('ascii');
    requireTar(/^[1-9][0-9]*$/.test(lengthText), 'tar_pax_invalid'); const length = Number(lengthText);
    requireTar(length >= 5 && offset + length <= bytes.length && bytes[offset + length - 1] === 10, 'tar_pax_invalid');
    let record;
    try { record = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(space + 1, offset + length - 1)); }
    catch { throw Object.assign(new Error('tar_pax_invalid'), { code: 'tar_pax_invalid' }); }
    const equals = record.indexOf('='); requireTar(equals > 0, 'tar_pax_invalid');
    const key = record.slice(0, equals); const value = record.slice(equals + 1);
    requireTar(['path', 'mtime', 'atime', 'ctime'].includes(key), 'tar_pax_key_unsupported');
    requireTar(!Object.hasOwn(records, key) && ++count <= 16, 'tar_pax_invalid');
    if (key === 'path') { requireTar(!global, 'tar_pax_scope_refused'); records.path = canonicalTarPath(value); }
    else { requireTar(value.length <= 64 && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value) && Number.isFinite(Number(value)), 'tar_pax_invalid'); records[key] = value; }
    offset += length;
  }
  return records;
}
