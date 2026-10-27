// ZIP32, store-only, UTF-8 names; no compression dependency or ZIP64 allocation.
export const ZIP_MAX_BYTES = 100_000_000;
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
export class StoreZip {
  private entries: { name: Uint8Array<ArrayBuffer>; bytes: Uint8Array<ArrayBuffer>; crc: number }[] = [];
  private names = new Set<string>();
  private size = 22;
  get remaining() { return ZIP_MAX_BYTES - this.size; }
  add(path: string, bytes: Uint8Array<ArrayBuffer>) {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") || /[\p{Cc}]/u.test(path) || this.names.has(path)) throw new Error("ZIP 文件路径无效或重名");
    const name = new TextEncoder().encode(path), size = bytes.length + 76 + 2 * name.length;
    if (name.length > 65535 || this.entries.length >= 65535 || size > this.remaining) throw new Error("导出超过 100 MB 或 ZIP 条目上限，请缩小导出范围");
    this.names.add(path); this.size += size; this.entries.push({ name, bytes, crc: crc32(bytes) });
  }
  blob() {
    const parts: BlobPart[] = [], central: BlobPart[] = []; let offset = 0, centralSize = 0;
    for (const entry of this.entries) {
      const local = new Uint8Array(30), l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(12, 33, true);
      l.setUint32(14, entry.crc, true); l.setUint32(18, entry.bytes.length, true); l.setUint32(22, entry.bytes.length, true); l.setUint16(26, entry.name.length, true);
      parts.push(local, entry.name, entry.bytes);
      const header = new Uint8Array(46), c = new DataView(header.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 33, true);
      c.setUint32(16, entry.crc, true); c.setUint32(20, entry.bytes.length, true); c.setUint32(24, entry.bytes.length, true); c.setUint16(28, entry.name.length, true); c.setUint32(42, offset, true);
      central.push(header, entry.name); centralSize += 46 + entry.name.length; offset += 30 + entry.name.length + entry.bytes.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.entries.length, true); e.setUint16(10, this.entries.length, true); e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }
}
