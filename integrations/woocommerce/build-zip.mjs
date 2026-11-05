// Packs the WooCommerce plugin into apps/client-portal/public/downloads/qcs-ghana-shipping.zip (runs before the portal builds).
// A tiny "stored" (uncompressed) zip writer: no extra dependency; WordPress installs these fine.
import fs from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";

const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(here, "qcs-ghana-shipping");
const out = path.join(here, "../../apps/client-portal/public/downloads/qcs-ghana-shipping.zip");

const files = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p); else files.push(p);
  }
})(src);

const local = [], central = [];
let offset = 0;
const dosTime = 0, dosDate = (2026 - 1980) << 9 | 11 << 5 | 5;   // fixed date: same files → same zip
for (const f of files) {
  const name = Buffer.from("qcs-ghana-shipping/" + path.relative(src, f).split(path.sep).join("/"));
  const data = fs.readFileSync(f);
  const crc = crc32(data) >>> 0;
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
  h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
  local.push(h, name, data);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
  c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(name.length, 28); c.writeUInt32LE(0, 30); c.writeUInt32LE(0, 34); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
  central.push(c, name);
  offset += 30 + name.length + data.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([...local, cd, end]));
console.log(`WooCommerce plugin: ${files.length} files → ${path.relative(process.cwd(), out)}`);
