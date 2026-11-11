import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkPayload, tarEntries, payloadValidationReason } from '../../scripts/main-image-tar.mjs';
import { canonicalTarPath } from '../../scripts/main-image-tar-format.mjs';
import { sha256 } from '../../scripts/main-image-plan.mjs';
import { tar, pax, checksum } from './tarFixture.mjs';

const service = new URL('../../', import.meta.url).pathname; const root = new URL('../../../../', import.meta.url).pathname;
async function payloadRows() {
  const names = ['main.js', 'artifact.json', 'build-lock.sha256', 'package.json', 'LICENSE', 'licenses/DEPENDENCIES.json'];
  return Promise.all(names.map(async (name) => ({ name, bytes: await readFile(name === 'package.json' ? `${service}/worker-package.json`
    : name === 'LICENSE' ? `${root}/LICENSE` : `${service}/dist-worker/${name}`) })));
}
test('USTAR prefixes, app/./ and repeated benign dot components normalize without relaxing containment', async () => {
  const rows = await payloadRows(); const facts = {};
  const archive = tar([{ name: 'app/./', type: '5' }, ...rows.map((row) => ({ ...row, name: `app/./${row.name}` }))]);
  const result = checkPayload(archive, facts); assert.equal(result.files.length, 6); assert.equal(facts.observedArtifact, result.artifact);
  const prefix = tar([{ name: 'DEPENDENCIES.json', prefix: 'app/./licenses', bytes: Buffer.from('[]') }]);
  assert.equal(tarEntries(prefix)[0].name, 'app/licenses/DEPENDENCIES.json');
  assert.equal(canonicalTarPath('././app//./main.js', true), 'main.js');
});
test('standard local PAX timestamp/path and global timestamps are metadata, not payload files', async () => {
  const rows = await payloadRows(); const facts = {};
  const archive = tar([{ name: 'GlobalHead.0.0', type: 'g', bytes: pax([['mtime', '1700000000.123456789']]) },
    { name: 'app/PaxHeaders.0/main.js', type: 'x', bytes: pax([['path', 'app/./main.js'], ['atime', '0.25'], ['ctime', '-1.5']]) },
    ...rows.map((row, index) => ({ ...row, name: index === 0 ? 'placeholder' : `app/${row.name}` }))]);
  assert.equal(checkPayload(archive, facts).files.length, 6); assert.equal(facts.paxLocal, 1); assert.equal(facts.paxGlobal, 1);
  const unicode = tar([{ name: 'PaxHeaders.0/file', type: 'x', bytes: pax([['path', 'app/café.txt']]) }, { name: 'file' }]);
  assert.equal(tarEntries(unicode)[0].name, 'app/café.txt');
});
test('checksum, numeric, format, truncation, padding and footer corruption refuse', () => {
  const valid = tar([{ name: 'main.js', bytes: Buffer.from('x') }]);
  const badChecksum = Buffer.from(valid); badChecksum[0] ^= 1;
  assert.throws(() => tarEntries(badChecksum), (error) => error.code === 'tar_checksum_invalid');
  for (const [offset, value, code] of [[124, '00000000009', 'tar_numeric_invalid'], [257, 'xxxxx', 'tar_format_unsupported']]) {
    const changed = Buffer.from(valid); changed.write(value, offset); checksum(changed.subarray(0, 512)); assert.throws(() => tarEntries(changed), (error) => error.code === code);
  }
  const padding = Buffer.from(valid); padding[513] = 1; assert.throws(() => tarEntries(padding), (error) => error.code === 'tar_padding_invalid');
  assert.throws(() => tarEntries(valid.subarray(0, valid.length - 512)), (error) => error.code === 'tar_footer_invalid');
  const trailing = Buffer.concat([valid, Buffer.alloc(512)]); trailing[trailing.length - 1] = 1;
  assert.throws(() => tarEntries(trailing), (error) => error.code === 'tar_footer_invalid');
  assert.throws(() => tarEntries(valid.subarray(0, 513))); assert.throws(() => tarEntries(Buffer.alloc(8389120)), (error) => error.code === 'tar_capacity');
  const version = Buffer.from(valid); version[263] |= 128; checksum(version.subarray(0, 512));
  assert.throws(() => tarEntries(version), (error) => error.code === 'tar_format_unsupported');
  const star = Buffer.from(valid); star.write('tar', 508); checksum(star.subarray(0, 512));
  assert.throws(() => tarEntries(star), (error) => error.code === 'tar_format_unsupported');
  assert.throws(() => tarEntries(tar(Array.from({ length: 1025 }, (_, index) => ({ name: `file-${index}` })))), (error) => error.code === 'tar_capacity');
});
test('links, devices, FIFO, GNU longlink/sparse types and unsafe paths always refuse', () => {
  for (const type of ['1', '2', '3', '4', '6', 'L', 'K', 'S']) assert.throws(() => tarEntries(tar([{ name: 'main.js', type }])), (error) => error.code === 'tar_entry_type_refused');
  for (const name of ['../main.js', 'app/../main.js', '/app/main.js', 'app\\main.js', `main${String.fromCharCode(0)}hidden`]) {
    assert.throws(() => tarEntries(tar([{ name }])), (error) => error.code === 'tar_path_refused');
  }
});
test('PAX byte lengths, UTF8, duplicates, unknown/ownership/sparse/link keys and global paths refuse', () => {
  for (const key of ['linkpath', 'size', 'uid', 'gid', 'GNU.sparse.map', 'SCHILY.xattr.security.capability']) {
    assert.throws(() => tarEntries(tar([{ name: 'pax', type: 'x', bytes: pax([[key, 'private']]) }, { name: 'file' }])), (error) => error.code === 'tar_pax_key_unsupported');
  }
  for (const value of ['../escape', '/absolute', `a${String.fromCharCode(0)}b`]) assert.throws(() => tarEntries(tar([
    { name: 'pax', type: 'x', bytes: pax([['path', value]]) }, { name: 'file' }])), (error) => error.code === 'tar_path_refused');
  assert.throws(() => tarEntries(tar([{ name: 'global', type: 'g', bytes: pax([['path', 'file']]) }, { name: 'file' }])), (error) => error.code === 'tar_pax_scope_refused');
  for (const bytes of [Buffer.from('99 mtime=1\n'), Buffer.from('12 mtime=1x'), pax([['mtime', '1'], ['mtime', '2']]), Buffer.from([49, 48, 32, 112, 97, 116, 104, 61, 255, 10])]) {
    assert.throws(() => tarEntries(tar([{ name: 'pax', type: 'x', bytes }, { name: 'file' }])));
  }
  assert.throws(() => tarEntries(tar([{ name: 'pax', type: 'x', bytes: pax([['mtime', '1']]) }])));
  const highBit = pax([['mtime', '1']]); highBit[0] |= 128;
  assert.throws(() => tarEntries(tar([{ name: 'pax', type: 'x', bytes: highBit }, { name: 'file' }])), (error) => error.code === 'tar_pax_invalid');
  assert.throws(() => tarEntries(tar([{ name: 'pax', type: 'x', bytes: Buffer.alloc(16385) }])), (error) => error.code === 'tar_capacity');
});
test('canonical duplicate paths and payload root aliases cannot overwrite sealed files', () => {
  assert.throws(() => tarEntries(tar([{ name: 'app/./main.js' }, { name: './app/main.js' }])), (error) => error.code === 'tar_duplicate_path');
  assert.throws(() => checkPayload(tar([{ name: 'app/main.js' }, { name: './main.js' }])), (error) => error.code === 'tar_duplicate_path');
});
test('permissions, root ownership, hashes/lock and fixture exclusion retain strict refusal facts', async () => {
  const rows = await payloadRows();
  for (const mutation of [{ uid: 10001 }, { gid: 10001 }, { mode: 0o600 }, { mode: 0o666 }, { mode: 0o444 }]) {
    assert.throws(() => checkPayload(tar(rows.map((row) => row.name === 'artifact.json' ? { ...row, ...mutation } : row))));
  }
  const facts = {}; assert.throws(() => checkPayload(tar(rows.map((row) => row.name === 'main.js' ? { ...row, bytes: Buffer.from('modified') } : row)), facts),
    (error) => error.code === 'payload_main_hash_mismatch'); assert.match(facts.mainHash, /^[a-f0-9]{64}$/);
  assert.throws(() => checkPayload(tar(rows.map((row) => row.name === 'build-lock.sha256' ? { ...row, bytes: Buffer.from('wrong') } : row))), (error) => error.code === 'payload_lock_mismatch');
  const fixture = Buffer.from('ModelCounter'); const { digest, ...artifact } = JSON.parse(rows.find((row) => row.name === 'artifact.json').bytes);
  artifact.files['main.js'] = sha256(fixture); const sealedFixture = Buffer.from(JSON.stringify({ ...artifact, digest: sha256(JSON.stringify(artifact)) }));
  assert.throws(() => checkPayload(tar(rows.map((row) => row.name === 'main.js' ? { ...row, bytes: fixture }
    : row.name === 'artifact.json' ? { ...row, bytes: sealedFixture } : row))), (error) => error.code === 'payload_fixture_refused');
});
test('actual caller captures only bounded facts before failure and never adopts a changed worker digest', async () => {
  const source = await readFile(new URL('../../scripts/check-main-image.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function payload('), source.indexOf('async function smoke('));
  const receipt = {}; const archive = tar(await payloadRows());
  const capture = new Function('required', 'checkPayload', 'receipt', `${body};return payload;`)(async () => archive, checkPayload, receipt);
  await assert.rejects(capture({ workerDigest: '0'.repeat(64) }, 'owned-id'), (error) => payloadValidationReason(error) === 'image_worker_digest_mismatch');
  assert.match(receipt.payloadValidation.facts.observedArtifact, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(receipt.payloadValidation), /private|PaxHeaders|mtime/);
  assert.equal(payloadValidationReason({ code: 'private-code' }), undefined);
});
test('actual caller refusal facts never persist unknown paths, metadata values or file content', async () => {
  const source = await readFile(new URL('../../scripts/check-main-image.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function payload('), source.indexOf('async function smoke('));
  const receipt = {}; const archive = tar([{ name: 'private-secret-path', bytes: Buffer.from('mongodb://secret:password@private') }]);
  const capture = new Function('required', 'checkPayload', 'receipt', `${body};return payload;`)(async () => archive, checkPayload, receipt);
  await assert.rejects(capture({ workerDigest: '0'.repeat(64) }, 'owned-id'), (error) => payloadValidationReason(error) === 'payload_entry_refused');
  assert.equal(receipt.payload, undefined); assert.equal(receipt.payloadValidation.facts.fileFacts.length, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /private-secret|mongodb|password/);
  assert.match(receipt.payloadValidation.facts.fileFacts[0].nameHash, /^[a-f0-9]{64}$/);
});
