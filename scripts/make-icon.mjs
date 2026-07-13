import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, "../public/app-icon.ico");
const size = 256;
const pixels = new Uint8ClampedArray(size * size * 4);

function blend(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const index = (y * size + x) * 4;
  const alpha = a / 255;
  const inv = 1 - alpha;
  pixels[index] = Math.round(r * alpha + pixels[index] * inv);
  pixels[index + 1] = Math.round(g * alpha + pixels[index + 1] * inv);
  pixels[index + 2] = Math.round(b * alpha + pixels[index + 2] * inv);
  pixels[index + 3] = Math.min(255, Math.round(a + pixels[index + 3] * inv));
}

function roundRectMask(x, y, w, h, radius, px, py) {
  const dx = px < x + radius ? x + radius - px : px > x + w - radius ? px - (x + w - radius) : 0;
  const dy = py < y + radius ? y + radius - py : py > y + h - radius ? py - (y + h - radius) : 0;
  return dx * dx + dy * dy <= radius * radius;
}

function fillRoundedRect(x, y, w, h, radius, colorFn) {
  for (let py = Math.floor(y); py < y + h; py++) {
    for (let px = Math.floor(x); px < x + w; px++) {
      if (!roundRectMask(x, y, w, h, radius, px, py)) continue;
      const color = colorFn(px, py);
      blend(px, py, color[0], color[1], color[2], color[3] ?? 255);
    }
  }
}

function strokeCircle(cx, cy, radius, width, r, g, b, a) {
  const max = Math.ceil(radius + width);
  for (let y = cy - max; y <= cy + max; y++) {
    for (let x = cx - max; x <= cx + max; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (Math.abs(dist - radius) <= width / 2) blend(x, y, r, g, b, a);
    }
  }
}

function fillCircle(cx, cy, radius, r, g, b, a) {
  const rr = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rr) blend(x, y, r, g, b, a);
    }
  }
}

function strokeLine(x1, y1, x2, y2, width, r, g, b, a) {
  const minX = Math.floor(Math.min(x1, x2) - width);
  const maxX = Math.ceil(Math.max(x1, x2) + width);
  const minY = Math.floor(Math.min(y1, y2) - width);
  const maxY = Math.ceil(Math.max(y1, y2) + width);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      if (Math.hypot(x - px, y - py) <= width / 2) blend(x, y, r, g, b, a);
    }
  }
}

fillRoundedRect(10, 10, 236, 236, 48, (x, y) => {
  const t = (x + y) / (size * 2);
  const r = Math.round(24 + 44 * t);
  const g = Math.round(169 + 42 * t);
  const b = Math.round(153 + 58 * t);
  return [r, g, b, 255];
});

fillCircle(198, 48, 58, 255, 255, 255, 28);
fillCircle(62, 210, 80, 0, 84, 80, 42);

strokeCircle(128, 126, 72, 4, 255, 255, 255, 78);
strokeCircle(128, 126, 48, 4, 255, 255, 255, 88);
strokeLine(128, 126, 190, 86, 6, 255, 255, 255, 120);
fillCircle(190, 86, 8, 255, 255, 255, 210);

fillRoundedRect(68, 92, 120, 100, 18, () => [255, 255, 255, 238]);
strokeCircle(128, 94, 31, 8, 255, 255, 255, 235);
fillRoundedRect(88, 86, 80, 36, 10, () => [24, 169, 153, 255]);
strokeCircle(128, 96, 32, 7, 255, 255, 255, 235);

strokeLine(88, 156, 108, 140, 9, 24, 169, 153, 255);
strokeLine(108, 140, 130, 154, 9, 24, 169, 153, 255);
strokeLine(130, 154, 166, 120, 9, 24, 169, 153, 255);
fillCircle(88, 156, 6, 24, 169, 153, 255);
fillCircle(108, 140, 6, 24, 169, 153, 255);
fillCircle(130, 154, 6, 24, 169, 153, 255);
fillCircle(166, 120, 6, 24, 169, 153, 255);

const xorHeight = size * 2;
const dibHeader = Buffer.alloc(40);
dibHeader.writeUInt32LE(40, 0);
dibHeader.writeInt32LE(size, 4);
dibHeader.writeInt32LE(xorHeight, 8);
dibHeader.writeUInt16LE(1, 12);
dibHeader.writeUInt16LE(32, 14);
dibHeader.writeUInt32LE(0, 16);
dibHeader.writeUInt32LE(size * size * 4, 20);

const bitmap = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const src = ((size - 1 - y) * size + x) * 4;
    const dst = (y * size + x) * 4;
    bitmap[dst] = pixels[src + 2];
    bitmap[dst + 1] = pixels[src + 1];
    bitmap[dst + 2] = pixels[src];
    bitmap[dst + 3] = pixels[src + 3];
  }
}

const andMask = Buffer.alloc((size / 8) * size);
const image = Buffer.concat([dibHeader, bitmap, andMask]);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);
entry.writeUInt8(0, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);

fs.writeFileSync(outPath, Buffer.concat([header, entry, image]));
console.log(outPath);
