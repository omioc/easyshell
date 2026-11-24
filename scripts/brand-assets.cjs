/**
 * Derives the brand assets from the master logo.
 *
 * The master file (`logo.png` in the repo root) is a 1254x1254 RGB image with a
 * solid black canvas: the rounded tile sits on black, with a black glyph cut out
 * of the tile. This script flood-fills the canvas from the border to transparent
 * (leaving the enclosed glyph opaque), crops to the tile, resamples with
 * premultiplied-alpha bilinear filtering and writes:
 *
 *   src/renderer/src/assets/brand/logo.png   512x512   UI mark (titlebar, welcome page)
 *   src/renderer/public/favicon.png    128x128   window/tab icon
 *   build/icon.png                    1024x1024 electron-builder app icon (ico/icns/png)
 *
 * Run with `npm run brand:assets`. No dependencies: PNG decode, resize and encode
 * are done here on top of node:zlib.
 */const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

/* ---------------------------------------------------------------- PNG codec */

function decodePng(buffer) {
  let offset = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.slice(offset + 4, offset + 8).toString('ascii');
    const data = buffer.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]; pos += 1;
    const line = raw.slice(pos, pos + stride); pos += stride;
    const prev = y > 0 ? pixels.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const out = pixels.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([length, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ image helpers */

function toRgba(source, alphaOut) {
  const { width, height, channels, pixels } = source;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = pixels[i * channels];
    rgba[i * 4 + 1] = pixels[i * channels + 1];
    rgba[i * 4 + 2] = pixels[i * channels + 2];
    rgba[i * 4 + 3] = alphaOut[i];
  }
  return rgba;
}

function resampleBilinear(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const sy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < dw; x += 1) {
      const sx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = Math.min(1, Math.max(0, sx - x0));
      let r = 0, g = 0, b = 0, a = 0;
      for (const [px, py, w] of [
        [x0, y0, (1 - wx) * (1 - wy)],
        [x1, y0, wx * (1 - wy)],
        [x0, y1, (1 - wx) * wy],
        [x1, y1, wx * wy],
      ]) {
        if (w === 0) continue;
        const si = (py * sw + px) * 4;
        const pa = (src[si + 3] / 255) * w;
        r += src[si] * pa;
        g += src[si + 1] * pa;
        b += src[si + 2] * pa;
        a += pa;
      }
      const di = (y * dw + x) * 4;
      if (a > 0) {
        out[di] = Math.round(r / a);
        out[di + 1] = Math.round(g / a);
        out[di + 2] = Math.round(b / a);
        out[di + 3] = Math.round(a * 255);
      }
    }
  }
  return out;
}

function padTo(rgba, sw, sh, size, padRatio) {
  const inner = Math.round(size * (1 - padRatio * 2));
  const scale = Math.min(inner / sw, inner / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const scaled = resampleBilinear(rgba, sw, sh, dw, dh);
  const canvas = Buffer.alloc(size * size * 4);
  const ox = Math.round((size - dw) / 2);
  const oy = Math.round((size - dh) / 2);
  for (let y = 0; y < dh; y += 1) {
    scaled.copy(canvas, ((oy + y) * size + ox) * 4, y * dw * 4, (y + 1) * dw * 4);
  }
  return canvas;
}

/* ----------------------------------------------------------------- pipeline */

const input = process.argv[2] ?? 'logo.png';
const source = decodePng(fs.readFileSync(input));
const { width, height, channels, pixels } = source;
const total = width * height;
const alpha = new Uint8Array(total).fill(255);

const dark = (index) => pixels[index * channels] <= 10 && pixels[index * channels + 1] <= 10 && pixels[index * channels + 2] <= 10;

// Flood fill the canvas background from the border, so the black glyph inside
// the tile stays opaque while the black margin around the tile disappears.
const stack = [];
const seen = new Uint8Array(total);
const push = (x, y) => {
  const index = y * width + x;
  if (seen[index]) return;
  seen[index] = 1;
  if (!dark(index)) return;
  alpha[index] = 0;
  stack.push(index);
};
for (let x = 0; x < width; x += 1) { push(x, 0); push(x, height - 1); }
for (let y = 0; y < height; y += 1) { push(0, y); push(width - 1, y); }
while (stack.length > 0) {
  const index = stack.pop();
  const x = index % width;
  const y = (index - x) / width;
  if (x > 0) push(x - 1, y);
  if (x < width - 1) push(x + 1, y);
  if (y > 0) push(x, y - 1);
  if (y < height - 1) push(x, y + 1);
}

// bbox of what is still visible
let minX = width, minY = height, maxX = -1, maxY = -1;
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    if (alpha[y * width + x] === 0) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}

const cw = maxX - minX + 1;
const ch = maxY - minY + 1;
const rgbaFull = toRgba(source, alpha);
const cropped = Buffer.alloc(cw * ch * 4);
for (let y = 0; y < ch; y += 1) {
  rgbaFull.copy(cropped, y * cw * 4, ((minY + y) * width + minX) * 4, ((minY + y) * width + minX + cw) * 4);
}

const outputs = [
  { file: 'src/renderer/src/assets/brand/logo.png', size: 512, pad: 0.05 },
  { file: 'build/icon.png', size: 1024, pad: 0.1 },
  { file: 'src/renderer/public/favicon.png', size: 128, pad: 0.06 },
];

let transparent = 0;
for (let i = 0; i < total; i += 1) if (alpha[i] === 0) transparent += 1;

for (const output of outputs) {
  fs.mkdirSync(path.dirname(output.file), { recursive: true });
  const png = encodePng(output.size, output.size, padTo(cropped, cw, ch, output.size, output.pad));
  fs.writeFileSync(output.file, png);
  console.log(`${output.file}: ${output.size}x${output.size}, ${(png.length / 1024).toFixed(1)} KB`);
}

console.log(`source ${width}x${height}, background keyed out ${((transparent / total) * 100).toFixed(1)}%, tile ${cw}x${ch} at (${minX},${minY})`);