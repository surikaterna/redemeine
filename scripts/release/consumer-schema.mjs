import semver from 'semver';
import { z } from 'zod';
import { planSchema } from './release-plan-schema.mjs';

export class ConsumerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function demand(condition, message, code = 2) {
  if (!condition) throw new ConsumerError(code, message);
}

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().refine((value) => semver.valid(value) === value);
const name = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
  .max(214);
const text = z.string().min(1).max(4096);
const strings = z.array(text).max(10000);
const integrity = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/);
const origin = z.enum(['candidate', 'held-audit', 'registry', 'fixture-registry']);
const jsonObject = z.record(z.string(), z.json());

export const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    registry: z.literal('https://registry.npmjs.org/'),
    internalScopes: z.array(z.string().regex(/^@[a-z0-9-]+$/)).max(100),
    holds: z.record(name, z.object({ owner: text, reason: text }).strict()),
    knownBad: z.record(name, z.array(version).max(10000))
  })
  .strict();

const artifact = z
  .object({
    manifest: jsonObject,
    manifestSha256: digest,
    entries: z
      .array(
        z
          .object({
            path: text,
            type: z.enum(['File', 'Directory']),
            size: z.number().int().nonnegative(),
            mode: z.number().int().nonnegative(),
            prefix: z.string().max(2)
          })
          .strict()
      )
      .max(10000),
    size: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
    sha256: digest,
    integrity,
    archive: text,
    origin,
    sourcePath: text.optional(),
    package: name.optional(),
    version: version.optional(),
    chain: strings.optional(),
    registryIntegrity: text.optional(),
    tarball: text.optional()
  })
  .strict();

const edge = z
  .object({
    package: name,
    origin,
    chain: strings,
    field: z.enum(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']),
    name,
    spec: text,
    sourceSpec: text.optional(),
    devOnly: z.boolean(),
    canonical: name,
    range: text,
    optionalPeer: z.boolean(),
    resolution: text.optional(),
    resolved: z.object({ name, version, origin, integrity, sha256: digest }).strict().optional()
  })
  .strict();

export const v1ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    beads: strings,
    purpose: text,
    runId: z.uuid(),
    timestamp: z.iso.datetime(),
    repository: z
      .object({
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        dirty: z.boolean(),
        diffSha256: digest,
        untracked: z.array(z.object({ path: text, type: z.enum(['file', 'symlink']), sha256: digest }).strict()).max(10000),
        snapshotIdentity: digest
      })
      .strict(),
    tools: z.object({ node: text, pnpm: text, npm: text, packageManager: text, helpers: z.record(text, text) }).strict(),
    inputs: z.object({ 'pnpm-lock.yaml': digest, 'pnpm-workspace.yaml': digest, 'scripts/release/policy.json': digest }).strict(),
    policy: policySchema,
    workspaces: z
      .array(
        z
          .object({
            name,
            version,
            sourcePath: text,
            selection: z.enum(['private', 'held-audit', 'candidate']),
            reason: z.union([text, z.object({ owner: text, reason: text }).strict()])
          })
          .strict()
      )
      .min(1)
      .max(1000),
    artifacts: z.array(artifact).max(1000),
    edges: z.array(edge).max(10000),
    registrySnapshots: z
      .array(
        z
          .object({
            name,
            origin: z.enum(['fixture', 'https://registry.npmjs.org/']),
            missing: z.boolean(),
            sha256: digest.nullable(),
            versions: z.array(version).max(10000)
          })
          .strict()
      )
      .max(1000),
    invocations: z
      .array(
        z
          .object({
            cwd: text,
            command: text,
            args: strings,
            exit: z.number().int().nullable(),
            ignoreScripts: z.boolean(),
            ignorePnpmfile: z.boolean(),
            enforcedEnvironment: z.record(text, text).optional()
          })
          .strict()
      )
      .max(10000),
    diagnostics: z.array(z.object({ code: text, message: text, severity: z.enum(['error', 'incomplete']) }).catchall(z.json())).max(10000),
    notValidated: strings,
    complete: z.boolean(),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    verdict: z.enum(['static-clean', 'violations', 'incomplete'])
  })
  .strict();

const v2ManifestSchema = v1ManifestSchema.extend({
  schemaVersion: z.literal(2),
  purpose: z.literal('selected-release-audit'),
  releasePlan: z.object({ sha256: digest, plan: planSchema }).strict(),
  workspaces: z
    .array(
      v1ManifestSchema.shape.workspaces.element.extend({
        selection: z.enum(['private', 'held-audit', 'candidate', 'not-selected'])
      })
    )
    .min(1)
    .max(1000)
});

export const manifestSchema = z.discriminatedUnion('schemaVersion', [v1ManifestSchema, v2ManifestSchema]);

export function inputVerdict(manifest) {
  demand([1, 2].includes(manifest.schemaVersion) && Array.isArray(manifest.diagnostics), 'Unsupported A manifest');
  const incomplete = manifest.diagnostics.some((entry) => entry.severity === 'incomplete');
  const code = incomplete ? 2 : Number(manifest.diagnostics.length > 0);
  demand(
    manifest.complete === !incomplete && manifest.exitCode === code && manifest.verdict === ['static-clean', 'violations', 'incomplete'][code],
    'Contradictory A verdict'
  );
  return code;
}
