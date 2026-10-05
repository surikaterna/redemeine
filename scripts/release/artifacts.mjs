import { mkdir, readdir, readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { minimatch } from 'minimatch';
import semver from 'semver';
import { t } from 'tar';
import { diagnostic, hash, object, run, sri } from './workspace.mjs';

const MAX_BYTES = 64 * 1024 * 1024;

export function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !/[\\:]/.test(path) &&
    ![...path].some((character) => character.charCodeAt(0) < 32) &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '..' || part === '.' || part === '')
  );
}

function inventoryEntry(entry, state) {
  const path = entry.path.replace(/\/$/, '');
  state.size += entry.size;
  if (++state.count > 10000 || state.size > MAX_BYTES) throw new Error('Archive inventory limit exceeded');
  if (!safePath(path) || (path !== 'package' && !path.startsWith('package/'))) throw new Error(`Unsafe archive path: ${entry.path}`);
  if (!['File', 'Directory'].includes(entry.type)) throw new Error(`Unsupported archive entry ${entry.type}: ${path}`);
  if (state.entries.has(path)) throw new Error(`Duplicate archive entry: ${path}`);
  for (const [existing, value] of state.entries) {
    if ((path.startsWith(`${existing}/`) && value.type === 'File') || (existing.startsWith(`${path}/`) && entry.type === 'File'))
      throw new Error(`Colliding archive entry: ${path}`);
  }
  const info = { path, type: entry.type, size: entry.size, mode: entry.mode, prefix: '' };
  state.entries.set(path, info);
  const chunks = [];
  if (path === 'package/package.json' && entry.size > 1024 * 1024) throw new Error('Manifest too large');
  entry.on('data', (chunk) => {
    if (info.prefix.length < 2) info.prefix += chunk.toString('utf8').slice(0, 2 - info.prefix.length);
    if (path === 'package/package.json') chunks.push(chunk);
  });
  entry.on('end', () => {
    if (path === 'package/package.json') state.manifestBytes = Buffer.concat(chunks);
  });
}

export async function inventory(bytes) {
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Compressed archive too large');
  const raw = gunzipSync(bytes, { maxOutputLength: MAX_BYTES });
  const state = { entries: new Map(), size: 0, count: 0 };
  await new Promise((accept, reject) => {
    const parser = t({
      strict: true,
      onReadEntry: (entry) => {
        try {
          inventoryEntry(entry, state);
        } catch (error) {
          state.error ||= error;
          entry.resume();
        }
      }
    });
    parser.on('error', reject);
    parser.on('end', accept);
    parser.end(raw);
  });
  if (state.error) throw state.error;
  if (!state.manifestBytes) throw new Error('Missing regular package/package.json');
  const manifest = JSON.parse(state.manifestBytes.toString('utf8'));
  if (!object(manifest) || typeof manifest.name !== 'string' || !semver.valid(manifest.version)) throw new Error('Invalid packed manifest identity');
  return { manifest, manifestSha256: hash(state.manifestBytes), entries: [...state.entries.values()] };
}

function targetFiles(target, files, exportTarget) {
  if (typeof target !== 'string' || (exportTarget && !target.startsWith('./'))) throw new Error('Unsupported target; expected package-relative string');
  const path = target.replace(/^\.\//, '');
  if (/[#?%]/.test(path)) throw new Error(`Unsupported URL fragment/query/encoded target: ${target}`);
  if (!safePath(path) || /[?[\]{}!()]/.test(path) || path.split('*').length > 2) throw new Error(`Unsafe/unsupported target: ${target}`);
  if (/(^|\/)node_modules(\/|$)/.test(path)) throw new Error(`Unsupported node_modules target: ${target}`);
  const pattern = targetPattern(path, exportTarget);
  const matches = files.filter((file) => minimatch(file.path, `package/${pattern}`, { dot: true, nobrace: true, noext: true }));
  if (!matches.length) throw new Error(`Missing packed target: ${target}`);
  return matches;
}

function targetPattern(path, exportTarget) {
  if (!path.includes('*')) return path;
  const leaf = path.split('/').at(-1);
  if (!exportTarget || !leaf.startsWith('*')) throw new Error(`Unsupported wildcard target: ${path}`);
  // Node export substitution spans directories; a glob's single star does not.
  return path.replace('*', '**/*');
}

function exportLeaves(value, field, visit, depth = 0) {
  if (depth > 12) throw new Error('Exports nesting limit');
  if (value === null) return;
  if (typeof value === 'string') {
    visit(value, field);
    return;
  }
  if (!object(value) && !Array.isArray(value)) throw new Error(`Unsupported exports shape: ${field}`);
  if (!Object.keys(value).length) throw new Error(`Empty exports shape: ${field}`);
  if (object(value) && Object.keys(value).some((key) => !key || key.startsWith('.') || /^\d+$/.test(key)))
    throw new Error(`Unsupported export condition: ${field}`);
  for (const [key, child] of Object.entries(value)) exportLeaves(child, `${field}.${key}`, visit, depth + 1);
}

function checkExports(exports, files) {
  const subpaths = object(exports) && Object.keys(exports).some((key) => key.startsWith('.'));
  const mappings = subpaths ? Object.entries(exports) : [['.', exports]];
  for (const [key, value] of mappings) {
    if (key !== '.' && (!key.startsWith('./') || !safePath(key.slice(2)) || /[?[\]{}!()]/.test(key))) throw new Error(`Unsupported export key: ${key}`);
    const wildcard = key.includes('*');
    if (key.split('*').length > 2) throw new Error(`Unsupported repeated wildcard: ${key}`);
    const expansions = [];
    exportLeaves(value, key, (target) => {
      if (target.includes('*') !== wildcard) throw new Error(`Unsupported wildcard mapping: ${key} -> ${target}`);
      const matches = targetFiles(target, files, true);
      if (wildcard) expansions.push(wildcardValues(target, matches));
    });
    if (expansions.some((values) => values !== expansions[0])) throw new Error(`Conditional wildcard targets expose different subpaths: ${key}`);
  }
}

function wildcardValues(target, matches) {
  const [prefix, suffix] = `package/${target.slice(2)}`.split('*');
  return JSON.stringify(matches.map((file) => file.path.slice(prefix.length, suffix ? -suffix.length : undefined)).sort());
}

export function checkContent(artifact, report, context) {
  const { manifest, entries } = artifact;
  const files = entries.filter((entry) => entry.type === 'File');
  const check = (field, action) => {
    try {
      action();
    } catch (error) {
      diagnostic(report, 'CONTENT', error.message, { ...context, field });
    }
  };
  for (const field of ['main', 'module', 'types', 'typings']) {
    if (manifest[field] !== undefined) check(field, () => targetFiles(manifest[field], files, false));
  }
  if (manifest.exports !== undefined) check('exports', () => checkExports(manifest.exports, files));
  if (manifest.bin !== undefined) check('bin', () => checkBins(manifest.bin, files));
  if (manifest.files !== undefined) check('files', () => checkDistribution(manifest.files, files));
  if (manifest.typesVersions !== undefined)
    diagnostic(report, 'UNSUPPORTED_TYPES_VERSIONS', 'typesVersions mapping requires later consumer qualification', context);
}

function checkBins(bin, files) {
  if (typeof bin !== 'string' && !object(bin)) throw new Error('Unsupported bin shape');
  if (object(bin) && !Object.keys(bin).length) throw new Error('Empty bin mapping');
  for (const target of typeof bin === 'string' ? [bin] : Object.values(bin)) {
    if (typeof target !== 'string' || target.includes('*')) throw new Error('Invalid bin target');
    const [file] = targetFiles(target, files, false);
    if (file.prefix !== '#!' || !(file.mode & 0o111)) throw new Error(`Bin needs shebang and executable mode: ${target}`);
  }
}

function checkDistribution(patterns, files) {
  if (!Array.isArray(patterns) || !patterns.length) throw new Error('files must be a nonempty array');
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !safePath(pattern.replace(/^\.\//, '').replace(/\/$/, '')) || pattern.startsWith('!'))
      throw new Error('Unsupported files pattern');
    const prefix = `package/${pattern.replace(/^\.\//, '').replace(/\/$/, '')}`;
    if (!files.some((file) => minimatch(file.path, prefix, { dot: true }) || file.path.startsWith(`${prefix}/`)))
      throw new Error(`Empty distribution selection: ${pattern}`);
  }
}

export async function inspect(bytes, expected, report, context) {
  let artifact;
  try {
    artifact = await inventory(bytes);
  } catch (error) {
    diagnostic(report, 'ARCHIVE', error.message, { ...context, size: bytes.length, sha256: hash(bytes), integrity: sri(bytes) });
    return null;
  }
  const { manifest } = artifact;
  if (
    manifest.name !== expected.name ||
    manifest.version !== expected.version ||
    Boolean(manifest.private) !== Boolean(expected.private) ||
    manifest.private === true ||
    (manifest.private !== undefined && typeof manifest.private !== 'boolean')
  ) {
    diagnostic(report, 'IDENTITY', 'Packed identity/private flag disagrees with expected public package', context);
  }
  checkContent(artifact, report, context);
  return { ...artifact, size: bytes.length, sha256: hash(bytes), integrity: sri(bytes) };
}

export async function pack(workspace, output, report) {
  const directory = resolve(output, workspace.selection, encodeURIComponent(workspace.name));
  await mkdir(directory, { recursive: true });
  run(report, workspace.path, 'pnpm', ['pack', '--pack-destination', directory, '--json']);
  const archives = (await readdir(directory)).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error('Pack must produce exactly one tarball');
  const archive = resolve(directory, archives[0]);
  const context = { package: workspace.name, origin: workspace.selection, chain: [workspace.name] };
  const artifact = await inspect(await readFile(archive), workspace.manifest, report, context);
  if (!artifact) return null;
  return {
    ...artifact,
    archive: posix.join(workspace.selection, encodeURIComponent(workspace.name), archives[0]),
    origin: workspace.selection,
    sourcePath: workspace.sourcePath,
    source: workspace.manifest
  };
}
