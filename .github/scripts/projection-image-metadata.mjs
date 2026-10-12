import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function imageMetadata(env) {
  const prefix = 'projection-runtime-v';
  const release = env.EVENT_NAME === 'release';
  if (!release && env.EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Unsupported image event');
  }
  if (release && !env.RELEASE_TAG?.startsWith(prefix)) {
    throw new Error('Invalid projection release tag');
  }
  const version = release ? env.RELEASE_TAG.slice(prefix.length) : env.IMAGE_VERSION;
  const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
  if (typeof version !== 'string' || version.length > 128 || version.trim() !== version || !versionPattern.test(version)) {
    throw new Error('Invalid image version');
  }
  const repository = env.GITHUB_REPOSITORY?.toLowerCase();
  if (!repository || repository.trim() !== repository || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/u.test(repository)) {
    throw new Error('Invalid image repository');
  }
  if (!/^[a-f0-9]{40}$/u.test(env.SOURCE_SHA ?? '') || env.SOURCE_SHA.length !== 40) {
    throw new Error('Invalid source commit');
  }
  return { image: `ghcr.io/${repository}-projection-runtime`, version, sha: env.SOURCE_SHA, short_sha: env.SOURCE_SHA.slice(0, 12) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metadata = imageMetadata(process.env);
  const { GITHUB_OUTPUT: output } = process.env;
  if (!output) throw new Error('Missing GitHub output file');
  appendFileSync(
    output,
    Object.entries(metadata)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  );
}
