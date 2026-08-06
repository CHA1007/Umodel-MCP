import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const PAK_MAGIC = 0x5a6f12e1;
const TAIL_SIZE = 0xcd;

export type PakAesMode = "standard" | "bitflip";

function requireKey(keyHex?: string): Buffer {
  if (!keyHex) {
    throw new Error(
      "pakAesKey is not configured. Set it via umodel_config_set or in umodel-mcp.json (hex, 0x prefix optional).",
    );
  }
  return Buffer.from(keyHex.replace(/^0x/, ""), "hex");
}

export interface PakEntry {
  pak: string;
  path: string;
  offset: number;
  size: number;
  compressedSize: number;
  method: string;
  encrypted: boolean;
  blocks: { start: number; end: number }[];
}

export interface PakIndex {
  pak: string;
  version: number;
  mountPoint: string;
  compressionMethods: string[];
  entries: PakEntry[];
}

function byteReverse(key: Buffer): Buffer {
  const k = Buffer.from(key);
  for (let i = 0; i < 15; i++) {
    const t = k[i];
    k[i] = k[30 - i];
    k[30 - i] = t;
  }
  return k;
}

function bitReverse(data: Buffer): Buffer {
  const d = Buffer.from(data);
  for (let i = 0; i < Math.min(16, d.length); i++) {
    let x = d[i];
    x = ((x >> 1) & 0x55) | ((x << 1) & 0xaa);
    x = ((x >> 2) & 0x33) | ((x << 2) & 0xcc);
    x = (((x >> 4) | (x << 4)) & 0xff) >>> 0;
    d[i] = x;
  }
  return d;
}

function aesDecrypt(data: Buffer, key: Buffer, mode: PakAesMode): Buffer {
  const k = mode === "bitflip" ? byteReverse(key) : key;
  const decipher = crypto.createDecipheriv("aes-256-ecb", k, null);
  decipher.setAutoPadding(false);
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 16) {
    const block = data.subarray(i, i + 16);
    parts.push(decipher.update(mode === "bitflip" ? bitReverse(block) : block));
  }
  return Buffer.concat(parts);
}

class Reader {
  pos = 0;
  constructor(public data: Buffer) {}
  u8(): number {
    return this.data[this.pos++];
  }
  u32(): number {
    const v = this.data.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.data.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64(): number {
    const v = Number(this.data.readBigUInt64LE(this.pos));
    this.pos += 8;
    return v;
  }
  skip(n: number): void {
    this.pos += n;
  }
  bytes(n: number): Buffer {
    const b = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  fstring(): string {
    const slen = this.i32();
    if (slen === 0) return "";
    if (slen < 0) {
      const n = -slen;
      const s = this.data.subarray(this.pos, this.pos + (n - 1) * 2).toString("utf16le");
      this.pos += n * 2;
      return s;
    }
    const s = this.data.subarray(this.pos, this.pos + slen - 1).toString("utf8");
    this.pos += slen;
    return s;
  }
}

function readAt(fd: number, offset: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = fs.readSync(fd, buf, read, size - read, offset + read);
    if (n <= 0) break;
    read += n;
  }
  return buf.subarray(0, read);
}

function decodeEntry(blob: Buffer, offset: number, methods: string[]): Omit<PakEntry, "pak" | "path"> | null {
  const r = new Reader(blob);
  r.pos = offset;
  const bitfield = r.u32();
  let compressionBlockSize = (bitfield & 0x3f) === 0x3f ? r.u32() : (bitfield & 0x3f) << 11;
  const methodIndex = (bitfield >> 23) & 0x3f;
  const method = methods[methodIndex] ?? "None";
  const offset32 = (bitfield & (1 << 31)) !== 0;
  const usize32 = (bitfield & (1 << 30)) !== 0;
  const entryOffset = offset32 ? r.u32() : r.u64();
  const uncompressedSize = usize32 ? r.u32() : r.u64();
  let compressedSize: number;
  if (methodIndex !== 0) {
    const size32 = (bitfield & (1 << 29)) !== 0;
    compressedSize = size32 ? r.u32() : r.u64();
  } else {
    compressedSize = uncompressedSize;
  }
  const encrypted = (bitfield & (1 << 22)) !== 0;
  const blocksCount = (bitfield >> 6) & 0xffff;
  if (blocksCount === 1) compressionBlockSize = uncompressedSize;
  let structSize = 8 * 3 + 4 * 2 + 1 + 20;
  if (methodIndex !== 0) structSize += 4 + blocksCount * 16;
  const blocks: { start: number; end: number }[] = [];
  const dataStart = entryOffset + structSize;
  if (blocksCount === 1 && !encrypted) {
    blocks.push({ start: dataStart, end: dataStart + compressedSize });
  } else if (blocksCount > 0) {
    let cur = dataStart;
    const align = encrypted ? 16 : 1;
    for (let i = 0; i < blocksCount; i++) {
      const len = r.u32();
      blocks.push({ start: cur, end: cur + len });
      cur += Math.ceil(len / align) * align;
    }
  }
  return {
    offset: entryOffset,
    size: uncompressedSize,
    compressedSize,
    method,
    encrypted,
    blocks,
  };
}

export function parsePakIndex(pakPath: string, keyHex?: string, mode: PakAesMode = "standard"): PakIndex | null {
  const fd = fs.openSync(pakPath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < TAIL_SIZE) return null;
    const tail = readAt(fd, stat.size - TAIL_SIZE, TAIL_SIZE);
    const encryptedIndex = tail[0];
    const magic = tail.readUInt32LE(1);
    const version = tail.readUInt32LE(5);
    if (magic !== PAK_MAGIC) return null;
    const indexOffset = Number(tail.readBigUInt64LE(9));
    const indexSize = Number(tail.readBigUInt64LE(17));
    const compressionMethods: string[] = ["None"];
    for (let i = 0; i < 5; i++) {
      const name = tail.subarray(45 + i * 32, 45 + i * 32 + 32);
      const zero = name.indexOf(0);
      const s = name.subarray(0, zero === -1 ? name.length : zero).toString("latin1");
      compressionMethods.push(s || "None");
    }

    const decrypt = (buf: Buffer) => (encryptedIndex ? aesDecrypt(buf, requireKey(keyHex), mode) : buf);
    const primary = new Reader(decrypt(readAt(fd, indexOffset, indexSize)));
    const mountPoint = primary.fstring();
    const fileCount = primary.i32();
    primary.skip(8);
    const hasPathHash = primary.i32();
    if (!hasPathHash) return null;
    primary.skip(36);
    const hasDirIndex = primary.i32();
    if (!hasDirIndex) return null;
    const dirIndexOffset = primary.u64();
    const dirIndexSize = primary.u64();
    primary.skip(20);
    const entriesSize = primary.i32();
    const entriesBlob = primary.bytes(entriesSize);
    const nonEncodedCount = primary.i32();
    if (nonEncodedCount !== 0) return null;

    const dir = new Reader(decrypt(readAt(fd, dirIndexOffset, dirIndexSize)));
    const entries: PakEntry[] = [];
    const dirCount = dir.i32();
    for (let d = 0; d < dirCount; d++) {
      const dirName = dir.fstring();
      const n = dir.i32();
      for (let i = 0; i < n; i++) {
        const fileName = dir.fstring();
        const entryOff = dir.i32();
        if (entryOff === -2147483648 || entryOff < 0) continue;
        const decoded = decodeEntry(entriesBlob, entryOff, compressionMethods);
        if (!decoded) continue;
        const full = (dirName ? dirName : "") + fileName;
        entries.push({ pak: path.basename(pakPath), path: full.replace(/\\/g, "/"), ...decoded });
      }
    }
    void fileCount;
    return { pak: path.basename(pakPath), version, mountPoint, compressionMethods, entries };
  } finally {
    fs.closeSync(fd);
  }
}

export function extractEntry(
  pakPath: string,
  entry: PakEntry,
  outDir: string,
  keyHex?: string,
  mode: PakAesMode = "standard",
): string {
  const fd = fs.openSync(pakPath, "r");
  try {
    let data: Buffer;
    if (entry.method === "None") {
      if (entry.encrypted) {
        const len = entry.size;
        const aligned = Math.ceil(len / 16) * 16;
        const start = entry.blocks.length ? entry.blocks[0].start : entry.offset;
        data = aesDecrypt(readAt(fd, start, aligned), requireKey(keyHex), mode).subarray(0, len);
      } else {
        data = readAt(fd, entry.blocks.length ? entry.blocks[0].start : entry.offset, entry.size);
      }
    } else {
      const parts: Buffer[] = [];
      for (const b of entry.blocks) {
        const len = b.end - b.start;
        let block: Buffer;
        if (entry.encrypted) {
          const aligned = Math.ceil(len / 16) * 16;
          block = aesDecrypt(readAt(fd, b.start, aligned), requireKey(keyHex), mode).subarray(0, len);
        } else {
          block = readAt(fd, b.start, len);
        }
        if (entry.method.toLowerCase() === "zlib") {
          try {
            parts.push(zlib.inflateSync(block));
          } catch {
            parts.push(zlib.inflateRawSync(block));
          }
        } else if (entry.method.toLowerCase() === "gzip") {
          parts.push(zlib.gunzipSync(block));
        } else {
          throw new Error(`unsupported compression method: ${entry.method}`);
        }
      }
      data = Buffer.concat(parts);
    }
    const root = path.resolve(outDir);
    const rel = entry.path.replace(/^([A-Za-z]:)?[\\/]+/, "");
    const outPath = path.resolve(root, rel);
    if (!outPath.startsWith(root + path.sep)) {
      throw new Error(`unsafe entry path escapes output directory: ${entry.path}`);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
    return outPath;
  } finally {
    fs.closeSync(fd);
  }
}

export interface PakEncryptionInfo {
  pak: string;
  encryptedIndex: boolean;
  encryptedEntries: boolean;
}

export function detectPakEncryption(pakPath: string): PakEncryptionInfo | null {
  let fd: number;
  try {
    fd = fs.openSync(pakPath, "r");
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < TAIL_SIZE) return null;
    const tail = readAt(fd, stat.size - TAIL_SIZE, TAIL_SIZE);
    if (tail.readUInt32LE(1) !== PAK_MAGIC) return null;
    const name = path.basename(pakPath);
    if (tail[0] !== 0) return { pak: name, encryptedIndex: true, encryptedEntries: true };
    const indexSize = Number(tail.readBigUInt64LE(17));
    if (indexSize > 0 && indexSize <= 256 * 1024 * 1024) {
      try {
        const idx = parsePakIndex(pakPath);
        if (idx) return { pak: name, encryptedIndex: false, encryptedEntries: idx.entries.some((e) => e.encrypted) };
      } catch {
        return null;
      }
    }
    return { pak: name, encryptedIndex: false, encryptedEntries: false };
  } finally {
    fs.closeSync(fd);
  }
}

export function listPakFiles(pakDir: string, pakFilter?: string): string[] {
  if (!fs.existsSync(pakDir)) return [];
  return fs
    .readdirSync(pakDir)
    .filter((f) => f.toLowerCase().endsWith(".pak"))
    .filter((f) => !pakFilter || f.toLowerCase().includes(pakFilter.toLowerCase()))
    .sort()
    .map((f) => path.join(pakDir, f));
}
