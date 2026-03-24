export type IdentityFactory = () => string;

function defaultUuidIdentityFactory(): string {
  const cryptoObject = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }

  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}-${random}`;
}

let identityFactory: IdentityFactory = defaultUuidIdentityFactory;

export function createIdentity(): string {
  return identityFactory();
}

export function setIdentityFactory(factory: IdentityFactory): void {
  if (typeof factory !== 'function') {
    throw new Error('Identity factory must be a function');
  }
  identityFactory = factory;
}

export function resetIdentityFactory(): void {
  identityFactory = defaultUuidIdentityFactory;
}
