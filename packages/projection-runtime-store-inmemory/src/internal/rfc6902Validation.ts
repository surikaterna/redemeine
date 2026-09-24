import type { ProjectionStoreRfc6902Operation } from '@redemeine/projection-runtime-core';

const decodePathSegment = (segment: string): string => {
  if (/~(?![01])/u.test(segment)) {
    throw new Error(`Invalid RFC6902 JSON Pointer escape sequence in segment "${segment}".`);
  }
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
};

const validatePath = (path: string): void => {
  if (path === '') return;
  if (!path.startsWith('/')) {
    throw new Error(`Invalid RFC6902 JSON Pointer path "${path}".`);
  }
  path.slice(1).split('/').map(decodePathSegment);
};

export const validatePatchOperationStructure = (operation: ProjectionStoreRfc6902Operation): void => {
  validatePath(operation.path);
  if ((operation.op === 'move' || operation.op === 'copy') && !operation.from) {
    throw new Error(`RFC6902 ${operation.op} operation requires "from".`);
  }
  if (operation.from) validatePath(operation.from);
};
