const encoder = new TextEncoder();

function encodeSegment(value: string): Uint8Array {
  const encoded = encoder.encode(value);
  if (encoded.byteLength > 0xffff_ffff) throw new RangeError('Canonical identity segment exceeds uint32 length');
  const framed = new Uint8Array(4 + encoded.byteLength);
  new DataView(framed.buffer).setUint32(0, encoded.byteLength, false);
  framed.set(encoded, 4);
  return framed;
}

/** Encodes a domain and ordered string tuple as uint32-big-endian length-prefixed UTF-8 segments. */
export function encodeCanonicalIdentityPreimage(domain: string, parts: readonly string[]): Uint8Array {
  const segments = [encodeSegment(domain), ...parts.map(encodeSegment)];
  const byteLength = segments.reduce((total, segment) => total + segment.byteLength, 0);
  const preimage = new Uint8Array(byteLength);
  let offset = 0;
  for (const segment of segments) {
    preimage.set(segment, offset);
    offset += segment.byteLength;
  }
  return preimage;
}
