import { isCanonicalProjectionUuid } from './sourceCommit';

declare const projectionUuidBase64UrlBrand: unique symbol;
export type ProjectionUuidBase64Url22 = string & {
  readonly [projectionUuidBase64UrlBrand]: true;
};

const BASE64URL_22_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isProjectionUuidBase64Url22(value: unknown): value is ProjectionUuidBase64Url22 {
  return typeof value === 'string'
    && BASE64URL_22_PATTERN.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function projectionUuidToBase64Url22(uuid: string): ProjectionUuidBase64Url22 {
  if (!isCanonicalProjectionUuid(uuid)) throw new TypeError('Expected a canonical lowercase UUID.');
  const bytes = Buffer.from(uuid.replaceAll('-', ''), 'hex');
  return bytes.toString('base64url') as ProjectionUuidBase64Url22;
}

export function projectionBase64Url22ToUuid(encoded: string): string {
  if (!isProjectionUuidBase64Url22(encoded)) throw new TypeError('Expected an unpadded base64url UUID.');
  const hex = Buffer.from(encoded, 'base64url').toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
