import { demand } from './consumer-schema.mjs';

function validateConditions(value) {
  if (value === null) return;
  if (typeof value === 'string') return;
  demand(value && !Array.isArray(value), 'Unsupported export adapter shape');
  for (const [key, child] of Object.entries(value)) {
    demand(['node', 'import', 'require', 'default', 'types'].includes(key), 'Unsupported advertised export condition');
    validateConditions(child);
  }
}

// No matching condition permits fallback; an explicit null blocks it at every depth.
function selectedTarget(value, mode, required = false) {
  if (value === null) return null;
  if (typeof value === 'string') return { target: value, required };
  for (const [condition, child] of Object.entries(value)) {
    if (!['node', 'default', mode].includes(condition)) continue;
    const selected = selectedTarget(child, mode, required || condition === 'require');
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function surfaceFor(path, target, manifest) {
  demand(!path.includes('*') && (path === '.' || path.startsWith('./')), 'Wildcard/unknown export adapter coverage');
  validateConditions(target);
  const targets = {};
  const esm = selectedTarget(target, 'import');
  const cjs = selectedTarget(target, 'require');
  if (esm) targets.import = esm.target;
  if (cjs && (cjs.required || cjs.target.endsWith('.cjs') || (manifest.type !== 'module' && !cjs.target.endsWith('.mjs')))) targets.require = cjs.target;
  demand(Object.keys(targets).length, 'Type-only export needs explicit coverage');
  const blockedModes = [esm === null ? 'import' : null, cjs === null ? 'require' : null].filter(Boolean);
  return { specifier: path === '.' ? manifest.name : `${manifest.name}/${path.slice(2)}`, modes: Object.keys(targets), targets, blockedModes };
}

export function smokePlan(artifact) {
  const manifest = artifact.manifest;
  const name = manifest.name;
  const adapter = name === '@redemeine/kernel' ? 'kernel' : name === '@redemeine/cli' ? 'cli' : name.startsWith('@fixture/') ? 'fixture' : null;
  demand(adapter, `No reviewed behavioral adapter for ${name}`);
  const exports = manifest.exports;
  const mappings =
    exports && typeof exports === 'object' && Object.keys(exports).some((key) => key.startsWith('.')) ? exports : { '.': exports || manifest.main };
  const surfaces = [];
  for (const [path, target] of Object.entries(mappings)) {
    if (target !== null) surfaces.push(surfaceFor(path, target, manifest));
  }
  demand(
    surfaces.some((surface) => surface.specifier === name),
    'Adapter requires advertised root API'
  );
  demand(manifest.types || manifest.typings || JSON.stringify(exports || {}).includes('types'), 'No supported declaration surface');
  return { name, adapter, surfaces, types: ['NodeNext', 'Bundler'] };
}
