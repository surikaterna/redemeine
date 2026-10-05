import npa from 'npm-package-arg';
import semver from 'semver';
import { diagnostic, object } from './workspace.mjs';

export const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

export function parseSpec(name, spec) {
  if (typeof spec !== 'string') throw new Error('Dependency spec must be a string');
  const parsed = npa.resolve(name, spec);
  const target = parsed.type === 'alias' ? parsed.subSpec : parsed;
  if (!target || !['version', 'range'].includes(target.type) || !semver.validRange(target.rawSpec))
    throw new Error(`Nonportable/unsupported dependency spec: ${spec}`);
  return { canonical: target.name, range: target.rawSpec };
}

function scanExtras(value, path, report, context, depth = 0) {
  if (depth > 12) {
    diagnostic(report, 'SPEC', 'Dependency override nesting limit', { ...context, field: path });
    return;
  }
  if (typeof value === 'string') {
    try {
      parseSpec('override-target', value);
    } catch (error) {
      diagnostic(report, 'SPEC', error.message, { ...context, field: path, spec: value });
    }
    return;
  }
  if (!object(value)) {
    diagnostic(report, 'SPEC', 'Unsupported dependency-bearing shape', { ...context, field: path });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    checkSelector(key, path, report, context);
    scanExtras(child, `${path}.${key}`, report, context, depth + 1);
  }
}

function checkSelector(key, field, report, context) {
  if (key === '.') return;
  try {
    const parsed = npa(key);
    if (!parsed.name) throw new Error('Unsupported dependency selector');
    parseSpec(parsed.name, parsed.rawSpec);
  } catch (error) {
    diagnostic(report, 'SPEC', `Unsupported dependency selector ${key}: ${error.message}`, { ...context, field });
  }
}

export function edges(artifact, report, chain) {
  const result = [];
  const context = { package: artifact.manifest.name, origin: artifact.origin, chain };
  for (const field of fields) scanField(artifact, field, report, context, result);
  for (const field of ['overrides', 'resolutions']) {
    if (artifact.manifest[field] !== undefined) scanExtras(artifact.manifest[field], field, report, context);
  }
  const publish = artifact.manifest.publishConfig;
  if (publish !== undefined && !object(publish)) diagnostic(report, 'SPEC', 'Invalid publishConfig', context);
  for (const field of [...fields, 'overrides', 'resolutions']) {
    if (publish?.[field] !== undefined) scanExtras(publish[field], `publishConfig.${field}`, report, context);
  }
  if (artifact.manifest.pnpm?.overrides !== undefined) scanExtras(artifact.manifest.pnpm.overrides, 'pnpm.overrides', report, context);
  return result;
}

function scanField(artifact, field, report, context, result) {
  const dependencies = artifact.manifest[field];
  if (dependencies === undefined) return;
  if (!object(dependencies)) {
    diagnostic(report, 'SPEC', 'Dependency field must be an object', { ...context, field });
    return;
  }
  for (const [name, spec] of Object.entries(dependencies)) {
    const edge = { ...context, field, name, spec, sourceSpec: artifact.source?.[field]?.[name], devOnly: field === 'devDependencies' };
    try {
      result.push({
        ...edge,
        ...parseSpec(name, spec),
        optionalPeer: field === 'peerDependencies' && artifact.manifest.peerDependenciesMeta?.[name]?.optional === true
      });
    } catch (error) {
      diagnostic(report, 'SPEC', `${edge.devOnly ? 'Dev-only hygiene: ' : ''}${error.message}`, edge);
    }
  }
}
