// Rebuild the original icon with Sharp; the extension itself has no dependencies.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../icons');
const svg = await readFile(path.join(destination, 'icon.svg'));
for (const size of [16, 32, 48, 128]) {
  await sharp(svg).resize(size, size).png().toFile(path.join(destination, `icon${size}.png`));
}
console.log('Generated 16, 32, 48, 128 px PNG icons from icons/icon.svg.');
