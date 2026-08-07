import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatSize, listTree } from "./tree.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umodel-mcp-tree-test-"));
}

test("formatSize 人类可读单位换算", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatSize(3 * 1024 * 1024 * 1024), "3.0 GB");
});

test("listTree 渲染目录结构与大小汇总", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "12345");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "b.bin"), Buffer.alloc(1024));
  const out = listTree(dir);
  assert.ok(out.includes("a.txt  (5 B)"));
  assert.ok(out.includes("sub/"));
  assert.ok(out.includes("b.bin  (1.0 KB)"));
  assert.ok(out.includes("(1.0 KB)"));
});

test("listTree 超预算时截断", () => {
  const dir = tmpDir();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
  const out = listTree(dir, { maxEntries: 2 });
  assert.ok(out.includes("...(truncated)"));
});

test("listTree 对不存在目录给出提示", () => {
  assert.ok(listTree(path.join(os.tmpdir(), "definitely-missing-dir")).includes("does not exist"));
});
