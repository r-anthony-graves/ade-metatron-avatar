/* Emits icon.png: a gold Metatron ring on transparency, for the tray and taskbar.
   Hand-rolled PNG encoder so the build needs nothing but Node. */
const zlib = require('zlib'), fs = require('fs'), path = require('path');

const N = 64, px = Buffer.alloc(N * N * 4, 0);
function put(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= N || y >= N || a <= 0) return;
  const i = (y * N + x) * 4, prev = px[i + 3] / 255, add = a;
  const out = add + prev * (1 - add);
  px[i]     = Math.min(255, px[i]     * prev * (1 - add) / (out || 1) + r * add / (out || 1));
  px[i + 1] = Math.min(255, px[i + 1] * prev * (1 - add) / (out || 1) + g * add / (out || 1));
  px[i + 2] = Math.min(255, px[i + 2] * prev * (1 - add) / (out || 1) + b * add / (out || 1));
  px[i + 3] = Math.min(255, out * 255);
}
function disc(cx, cy, rad, soft, r, g, b, peak) {
  for (let y = Math.floor(cy - rad - soft); y <= cy + rad + soft; y++)
    for (let x = Math.floor(cx - rad - soft); x <= cx + rad + soft; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let a = d <= rad ? 1 : Math.max(0, 1 - (d - rad) / soft);
      if (a > 0) put(x, y, r, g, b, a * peak);
    }
}
function line(x0, y0, x1, y1, w, r, g, b, peak) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w, 1.1, r, g, b, peak);
  }
}
const C = N / 2, R = 21;
const pts = [];
for (let k = 0; k < 6; k++) {
  const a = -Math.PI / 2 + k * Math.PI / 3;
  pts.push([C + Math.cos(a) * R, C + Math.sin(a) * R]);
}
for (let k = 0; k < 6; k++) {                       // hexagon + the star inside it
  line(pts[k][0], pts[k][1], pts[(k + 1) % 6][0], pts[(k + 1) % 6][1], 0.9, 104, 192, 255, 0.85);
  line(pts[k][0], pts[k][1], pts[(k + 2) % 6][0], pts[(k + 2) % 6][1], 0.8, 255, 196, 94, 0.7);
  line(C, C, pts[k][0], pts[k][1], 0.8, 255, 196, 94, 0.8);
  disc(pts[k][0], pts[k][1], 1.6, 1.6, 255, 238, 190, 0.95);
}
disc(C, C, 3.4, 4.2, 255, 246, 220, 1);             // the core

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
let TBL = null;
function crc32(buf) {
  if (!TBL) { TBL = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c >>> 0; } }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
]);
const out = path.join(__dirname, '..', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote ' + out + ' (' + png.length + ' bytes, ' + N + 'x' + N + ')');
