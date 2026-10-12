export function checksum(header) {
  header.fill(32, 148, 156); const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0'), 148); header[154] = 0; header[155] = 32; return header;
}
export function tar(rows) {
  return Buffer.concat([...rows.flatMap((row) => {
    const bytes = row.bytes ?? Buffer.alloc(0); const header = Buffer.alloc(512);
    header.write(row.name); header.write((row.mode ?? 0o644).toString(8).padStart(7, '0'), 100);
    header.write((row.uid ?? 0).toString(8).padStart(7, '0'), 108); header.write((row.gid ?? 0).toString(8).padStart(7, '0'), 116);
    header.write(bytes.length.toString(8).padStart(11, '0'), 124); header.write(row.type ?? '0', 156);
    header.write('ustar', 257); header.write('00', 263); if (row.prefix) header.write(row.prefix, 345);
    checksum(header); return [header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)];
  }), Buffer.alloc(1024)]);
}
export function pax(pairs) {
  return Buffer.concat(pairs.map(([key, value]) => {
    const body = Buffer.from(`${key}=${value}\n`); let length = body.length + 2;
    while (Buffer.byteLength(`${length} `) + body.length !== length) length = Buffer.byteLength(`${length} `) + body.length;
    return Buffer.concat([Buffer.from(`${length} `), body]);
  }));
}
