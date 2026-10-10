/**
 * Icon generator.
 *
 * Writes the PWA icons and the Windows `build/icon.ico` from pure Node: a
 * hand-rolled PNG encoder plus an ICO container. No image library is added to
 * the project just to produce a few files, and the icons stay reproducible
 * (`npm run icons`).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Minimal PNG writer                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** @param {Uint8Array} rgba width*height*4 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // rgba
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Drawing                                                            */
/* ------------------------------------------------------------------ */

function hex(value) {
  const clean = value.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function canvas(size, background) {
  const rgba = new Uint8Array(size * size * 4);
  const [r, g, b] = hex(background);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Alpha-blended rounded rectangle. */
function roundRect(rgba, size, x, y, w, h, radius, color, alpha = 1) {
  const [r, g, b] = hex(color);
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(size, Math.ceil(x + w));
  const y1 = Math.min(size, Math.ceil(y + h));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const dx = Math.max(x + radius - px, px - (x + w - radius), 0);
      const dy = Math.max(y + radius - py, py - (y + h - radius), 0);
      const inside = dx === 0 && dy === 0 ? true : Math.hypot(dx, dy) <= radius;
      if (!inside) continue;
      const index = (py * size + px) * 4;
      rgba[index] = Math.round(rgba[index] * (1 - alpha) + r * alpha);
      rgba[index + 1] = Math.round(rgba[index + 1] * (1 - alpha) + g * alpha);
      rgba[index + 2] = Math.round(rgba[index + 2] * (1 - alpha) + b * alpha);
      rgba[index + 3] = 255;
    }
  }
}

/** The mark: two competitor blocks, a live score bar and the clock bar. */
function scoreboardMark(size, { safe = false } = {}) {
  const scale = size / 512;
  const rgba = canvas(size, '#0d1015');
  const pad = safe ? 512 * 0.16 * scale : 512 * 0.06 * scale;
  const inner = size - pad * 2;

  roundRect(rgba, size, pad, pad, inner, inner, 22 * scale * 4, '#2f7bf6', 1);
  roundRect(rgba, size, pad + 10 * scale * 4, pad + 10 * scale * 4, inner - 20 * scale * 4, inner - 20 * scale * 4, 18 * scale * 4, '#0d1015', 1);

  const barH = inner * 0.12;
  const gap = inner * 0.08;
  const left = pad + inner * 0.14;
  const width = inner * 0.72;
  // competitor A
  roundRect(rgba, size, left, pad + inner * 0.2, width, barH, barH / 2, '#e9edf3');
  // competitor B
  roundRect(rgba, size, left, pad + inner * 0.4, width * 0.68, barH, barH / 2, '#e9edf3');
  // live score bar
  roundRect(rgba, size, left, pad + inner * 0.62, width * 0.46, barH, barH / 2, '#2ecc71');
  // clock bar
  roundRect(rgba, size, left + width - inner * 0.22, pad + inner * 0.62, inner * 0.22, barH, barH / 2, '#f0b429');
  void gap;
  return rgba;
}

/* ------------------------------------------------------------------ */
/* ICO container (PNG payload, supported by Windows Vista and newer)   */
/* ------------------------------------------------------------------ */

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const directory = Buffer.alloc(entries.length * 16);
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.width >= 256 ? 0 : entry.width;
    directory[base + 1] = entry.height >= 256 ? 0 : entry.height;
    directory[base + 2] = 0;
    directory[base + 3] = 0;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

function write(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  process.stdout.write(`  ${path.replace(`${root}\\`, '').replace(`${root}/`, '')} (${buffer.length} bytes)\n`);
}

process.stdout.write('Generating icons\n');

for (const size of [192, 512]) {
  write(join(root, 'public', `icon-${size}.png`), encodePng(size, size, scoreboardMark(size)));
}
write(join(root, 'public', 'icon-maskable-512.png'), encodePng(512, 512, scoreboardMark(512, { safe: true })));

const icoSizes = [16, 32, 48, 64, 128, 256];
const entries = icoSizes.map((size) => ({
  width: size,
  height: size,
  png: encodePng(size, size, scoreboardMark(size)),
}));
write(join(root, 'build', 'icon.ico'), encodeIco(entries));
