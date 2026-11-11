import { pathToFileURL } from 'node:url';
import { definitionFile } from './definitionFile';
import { validateRegistrations } from './definitionValidation';
import { moduleRegistrations } from './definitionModule';

export class DefinitionBundleError extends Error {
  constructor(readonly code: 'definition_bundle_invalid' | 'definition_bundle_timeout' | 'definition_bundle_cancelled') { super(code); }
}
interface BundleDependencies { now?: () => number; importModule?: (url: string) => Promise<unknown> }

async function load(path: string, check: () => void, importer: (url: string) => Promise<unknown>) {
  check(); const before = await definitionFile(path); check();
  const url = pathToFileURL(path); url.searchParams.set('sha256', before.hash);
  const module: unknown = await importer(url.href); check();
  const after = await definitionFile(path); check();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('invalid_definition_module');
  const definitions = validateRegistrations(moduleRegistrations(module)); check();
  return Object.freeze({ moduleHash: before.hash, definitions });
}

/** Trusted code evaluation, not a sandbox or transitive-import attestation. */
export async function loadDefinitionBundle(path: string, milliseconds: number, signal: AbortSignal = new AbortController().signal,
  dependencies: BundleDependencies = {}) {
  const now = dependencies.now ?? (() => performance.now()); const deadline = now() + milliseconds;
  const check = () => {
    if (signal.aborted) throw new DefinitionBundleError('definition_bundle_cancelled');
    if (now() >= deadline) throw new DefinitionBundleError('definition_bundle_timeout');
  };
  let refuse: (error: unknown) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { refuse = reject; }); void interrupted.catch(() => {});
  const abort = () => refuse(new DefinitionBundleError('definition_bundle_cancelled'));
  const timer = setTimeout(() => refuse(new DefinitionBundleError('definition_bundle_timeout')), milliseconds);
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  try {
    const result = await Promise.race([load(path, check, dependencies.importModule ?? ((url) => import(url))), interrupted]); check(); return result;
  } catch (error) { throw error instanceof DefinitionBundleError ? error : new DefinitionBundleError('definition_bundle_invalid'); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
