import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import {
  detectPakEncryption,
  extractEntry,
  listPakFiles,
  normalizePakPath,
  parsePakIndex,
} from "./pak.js";

const PAK_MAGIC = 0x5a6f12e1;
const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}

function i32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
}

function u64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function fstring(s: string): Buffer {
  const body = Buffer.from(s + "\0", "utf8");
  return Buffer.concat([i32(body.length), body]);
}

function ecbEncrypt(data: Buffer, keyHex: string): Buffer {
  const padded = Buffer.alloc(Math.ceil(data.length / 16) * 16);
  data.copy(padded);
  const cipher = crypto.createCipheriv("aes-256-ecb", Buffer.from(keyHex, "hex"), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

interface Spec {
  dir: string;
  name: string;
  data: Buffer;
  compress?: boolean;
}

function buildPak(specs: Spec[], encryptIndexWith?: string): Buffer {
  const bodyChunks: Buffer[] = [];
  const recordChunks: Buffer[] = [];
  const layout: { spec: Spec; offset: number; recordOffset: number }[] = [];
  let pos = 0;
  let recPos = 0;
  for (const spec of specs) {
    const methodIndex = spec.compress ? 1 : 0;
    const payload = spec.compress ? zlib.deflateSync(spec.data) : spec.data;
    const structSize = methodIndex === 0 ? 53 : 73;
    const record = [u32(32 | (1 << 6) | (methodIndex << 23)), u64(pos), u64(spec.data.length)];
    if (methodIndex !== 0) record.push(u64(payload.length));
    const recBuf = Buffer.concat(record);
    bodyChunks.push(Buffer.alloc(structSize), payload);
    recordChunks.push(recBuf);
    layout.push({ spec, offset: pos, recordOffset: recPos });
    pos += structSize + payload.length;
    recPos += recBuf.length;
  }
  const entriesBlob = Buffer.concat(recordChunks);

  const dirs = new Map<string, number[]>();
  layout.forEach((_, idx) => {
    const dirName = layout[idx].spec.dir;
    if (!dirs.has(dirName)) dirs.set(dirName, []);
    dirs.get(dirName)!.push(idx);
  });

  const body = Buffer.concat(bodyChunks);
  const dirIndexOffset = body.length;
  const dirChunks: Buffer[] = [i32(dirs.size)];
  for (const [dirName, idxs] of dirs) {
    dirChunks.push(fstring(dirName), i32(idxs.length));
    for (const idx of idxs) {
      dirChunks.push(fstring(layout[idx].spec.name), i32(layout[idx].recordOffset));
    }
  }
  let dirIndex = Buffer.concat(dirChunks);
  if (encryptIndexWith) dirIndex = ecbEncrypt(dirIndex, encryptIndexWith);
  const primaryOffset = dirIndexOffset + dirIndex.length;

  let primary = Buffer.concat([
    fstring("../../../"),
    u32(11),
    u64(0),
    i32(1),
    Buffer.alloc(36),
    i32(1),
    u64(dirIndexOffset),
    u64(dirIndex.length),
    Buffer.alloc(20),
    i32(entriesBlob.length),
    entriesBlob,
    i32(0),
  ]);

  if (encryptIndexWith) primary = ecbEncrypt(primary, encryptIndexWith);

  const tail = Buffer.alloc(0xcd);
  tail[0] = encryptIndexWith ? 1 : 0;
  tail.writeUInt32LE(PAK_MAGIC, 1);
  tail.writeUInt32LE(11, 5);
  tail.writeBigUInt64LE(BigInt(primaryOffset), 9);
  tail.writeBigUInt64LE(BigInt(primary.length), 17);
  tail.write("Zlib", 45, "latin1");

  return Buffer.concat([body, dirIndex, primary, tail]);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umodel-mcp-test-"));
}

test("normalizePakPath 归一化资产路径", () => {
  assert.equal(normalizePakPath("Game\\Content\\Chars\\Hero.uasset"), "Chars/Hero.uasset");
  assert.equal(normalizePakPath("../Game/Content/X.uasset"), "X.uasset");
  assert.equal(normalizePakPath("Engine/Textures/T.uasset"), "Engine/Textures/T.uasset");
  assert.equal(normalizePakPath("Content/Foo.uasset"), "Foo.uasset");
});

test("parsePakIndex 解析明文 pak 索引", () => {
  const dir = tmpDir();
  const pakPath = path.join(dir, "pakchunk0.pak");
  const dataA = Buffer.from("hello asset");
  const dataB = Buffer.from("another one");
  fs.writeFileSync(
    pakPath,
    buildPak([
      { dir: "Game/Content/Chars/", name: "Hero.uasset", data: dataA },
      { dir: "Game/Content/Maps/", name: "Level1.umap", data: dataB },
    ]),
  );
  const index = parsePakIndex(pakPath);
  assert.ok(index);
  assert.equal(index.version, 11);
  assert.equal(index.entries.length, 2);
  const a = index.entries.find((e) => e.path === "Chars/Hero.uasset");
  assert.ok(a);
  assert.equal(a.size, dataA.length);
  assert.equal(a.method, "None");
  assert.equal(a.encrypted, false);
  assert.equal(a.pak, "pakchunk0.pak");
});

test("parsePakIndex 对非 pak 文件返回 null", () => {
  const dir = tmpDir();
  const p = path.join(dir, "fake.pak");
  fs.writeFileSync(p, Buffer.alloc(512));
  assert.equal(parsePakIndex(p), null);
  fs.writeFileSync(p, Buffer.alloc(10));
  assert.equal(parsePakIndex(p), null);
});

test("parsePakIndex 解析索引加密 pak（standard 模式）", () => {
  const dir = tmpDir();
  const pakPath = path.join(dir, "enc.pak");
  fs.writeFileSync(pakPath, buildPak([{ dir: "Game/Content/", name: "A.uasset", data: Buffer.from("secret") }], TEST_KEY));

  assert.throws(() => parsePakIndex(pakPath), /AES key/);
  assert.throws(() => parsePakIndex(pakPath, { mode: "standard" }), /AES key/);

  const index = parsePakIndex(pakPath, { keyHex: TEST_KEY, mode: "standard" });
  assert.ok(index);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].path, "A.uasset");

  const indexWithPrefix = parsePakIndex(pakPath, { keyHex: `0x${TEST_KEY}`, mode: "standard" });
  assert.ok(indexWithPrefix);
  assert.equal(indexWithPrefix.entries.length, 1);
});

test("extractEntry 提取未压缩条目", () => {
  const dir = tmpDir();
  const pakPath = path.join(dir, "pakchunk0.pak");
  const data = Buffer.from("raw asset payload");
  fs.writeFileSync(pakPath, buildPak([{ dir: "Game/Content/Chars/", name: "Hero.uasset", data }]));
  const index = parsePakIndex(pakPath);
  assert.ok(index);
  const outDir = path.join(dir, "out");
  const outPath = extractEntry(pakPath, index.entries[0], outDir);
  assert.equal(outPath, path.join(outDir, "Chars", "Hero.uasset"));
  assert.deepEqual(fs.readFileSync(outPath), data);
});

test("extractEntry 提取 zlib 压缩条目", () => {
  const dir = tmpDir();
  const pakPath = path.join(dir, "pakchunk0.pak");
  const data = Buffer.from("compressed payload ".repeat(50));
  fs.writeFileSync(pakPath, buildPak([{ dir: "Game/Content/", name: "Big.uexp", data, compress: true }]));
  const index = parsePakIndex(pakPath);
  assert.ok(index);
  assert.equal(index.entries[0].method, "Zlib");
  const outPath = extractEntry(pakPath, index.entries[0], path.join(dir, "out"));
  assert.deepEqual(fs.readFileSync(outPath), data);
});

test("detectPakEncryption 区分明文与索引加密 pak", () => {
  const dir = tmpDir();
  const plain = path.join(dir, "plain.pak");
  const enc = path.join(dir, "enc.pak");
  fs.writeFileSync(plain, buildPak([{ dir: "Game/Content/", name: "A.uasset", data: Buffer.from("x") }]));
  fs.writeFileSync(enc, buildPak([{ dir: "Game/Content/", name: "A.uasset", data: Buffer.from("x") }], TEST_KEY));

  const plainInfo = detectPakEncryption(plain);
  assert.deepEqual(plainInfo, { pak: "plain.pak", encryptedIndex: false, encryptedEntries: false });

  const encInfo = detectPakEncryption(enc);
  assert.deepEqual(encInfo, { pak: "enc.pak", encryptedIndex: true, encryptedEntries: true });

  assert.equal(detectPakEncryption(path.join(dir, "missing.pak")), null);
});

test("listPakFiles 过滤目录中的 pak 文件", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "pakchunk0.pak"), "x");
  fs.writeFileSync(path.join(dir, "pakchunk1-windows.pak"), "x");
  fs.writeFileSync(path.join(dir, "readme.txt"), "x");
  assert.deepEqual(
    listPakFiles(dir).map((p) => path.basename(p)),
    ["pakchunk0.pak", "pakchunk1-windows.pak"],
  );
  assert.deepEqual(listPakFiles(dir, "windows").map((p) => path.basename(p)), ["pakchunk1-windows.pak"]);
  assert.deepEqual(listPakFiles(path.join(dir, "missing")), []);
});
