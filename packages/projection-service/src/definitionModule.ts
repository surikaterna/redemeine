import { types } from 'node:util';

export function moduleRegistrations(value: unknown): unknown {
  if (value === null || typeof value !== 'object') throw new Error('invalid_definition_module');
  const namespace = types.isModuleNamespaceObject(value);
  for (const key of Reflect.ownKeys(value)) {
    // Native ESM namespaces have this intrinsic symbol, not an authored export.
    if (namespace && key === Symbol.toStringTag) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (key !== 'registrations' || !descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('unsupported_definition_module_export');
  }
  const registration = Object.getOwnPropertyDescriptor(value, 'registrations');
  if (!registration || !Object.hasOwn(registration, 'value')) throw new Error('invalid_definition_module');
  return registration.value;
}
