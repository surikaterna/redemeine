import { validateProjectionSourceCommit, type ProjectionSourceCommit } from '@redemeine/projection-runtime-core';

export function copyCommit(commit: ProjectionSourceCommit): ProjectionSourceCommit {
  const copy: unknown = JSON.parse(JSON.stringify(commit));
  const result = validateProjectionSourceCommit(copy);
  if (!result.valid) throw new Error('model:invalid_commit');
  return result.value;
}
