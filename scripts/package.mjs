import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_FILES } from './release-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const files = RELEASE_FILES;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
// Fixed ZIP timestamps make identical sources produce identical archives.
const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
const entries = [];
const directory = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file, 'utf8');
  const raw = await readFile(path.join(root, file));
  const compressed = deflateRawSync(raw, { level: 9 });
  const crc = crc32(raw);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(name.length, 26);
  entries.push(header, name, compressed);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(0x800, 8);
  record.writeUInt16LE(8, 10);
  record.writeUInt16LE(dosDate, 14);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(compressed.length, 20);
  record.writeUInt32LE(raw.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE(offset, 42);
  directory.push(record, name);
  offset += header.length + name.length + compressed.length;
}
const central = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...entries, central, end]);
const filename = `invert-colors-${manifest.version}.zip`;
const out = path.join(root, 'dist');
await mkdir(out, { recursive: true });
await writeFile(path.join(out, filename), zip);
const hash = createHash('sha256').update(zip).digest('hex');
await writeFile(path.join(out, `${filename}.sha256`), `${hash}  ${filename}\n`);
console.log(`${path.join(out, filename)} (${zip.length} bytes, ${files.length} files)`);
console.log(`SHA-256 ${hash}`);
