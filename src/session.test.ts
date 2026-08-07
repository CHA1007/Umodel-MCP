import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyOverrides,
  defaultOutputDir,
  findUmodelExes,
  rememberDirectory,
  resolveOutputDir,
  session,
} from "./session.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umodel-mcp-session-test-"));
}

test("defaultOutputDir 指向 Downloads/umodel-export", () => {
  assert.equal(defaultOutputDir(), path.join(os.homedir(), "Downloads", "umodel-export"));
});

test("resolveOutputDir 优先使用会话设置", () => {
  const dir = tmpDir();
  const saved = session.outputDir;
  try {
    delete session.outputDir;
    assert.equal(resolveOutputDir(), defaultOutputDir());
    session.outputDir = dir;
    assert.equal(resolveOutputDir(), dir);
  } finally {
    if (saved === undefined) delete session.outputDir;
    else session.outputDir = saved;
  }
});

test("applyOverrides 仅在目录存在时记住 gamePath", () => {
  const dir = tmpDir();
  const savedPath = session.gamePath;
  const savedTag = session.gameTag;
  const savedKeys = session.aesKeys;
  try {
    delete session.gamePath;
    assert.deepEqual(
      applyOverrides({ gamePath: path.join(dir, "missing"), gameTag: "ue4.27", aesKeys: ["0xabc"] }),
      ["gameTag", "aesKeys"],
    );
    assert.equal(session.gamePath, undefined);
    assert.equal(session.gameTag, "ue4.27");
    assert.deepEqual(session.aesKeys, ["0xabc"]);
    assert.deepEqual(applyOverrides({ gamePath: dir }), ["gamePath"]);
    assert.equal(session.gamePath, dir);
  } finally {
    if (savedPath === undefined) delete session.gamePath;
    else session.gamePath = savedPath;
    if (savedTag === undefined) delete session.gameTag;
    else session.gameTag = savedTag;
    if (savedKeys === undefined) delete session.aesKeys;
    else session.aesKeys = savedKeys;
  }
});

test("rememberDirectory 只记住存在的目录", () => {
  const dir = tmpDir();
  const saved = session.gamePath;
  try {
    delete session.gamePath;
    assert.equal(rememberDirectory(undefined), false);
    assert.equal(session.gamePath, undefined);
    assert.equal(rememberDirectory(path.join(dir, "missing")), false);
    assert.equal(session.gamePath, undefined);
    assert.equal(rememberDirectory(dir), true);
    assert.equal(session.gamePath, dir);
  } finally {
    if (saved === undefined) delete session.gamePath;
    else session.gamePath = saved;
  }
});

test("findUmodelExes 在指定目录中发现可执行文件", () => {
  const dir = tmpDir();
  const nested = path.join(dir, "tools");
  fs.mkdirSync(nested);
  const fake = path.join(nested, "umodel_fake.exe");
  fs.writeFileSync(fake, "x");
  fs.writeFileSync(path.join(dir, "notmatch.exe"), "x");
  const found = findUmodelExes([dir]);
  assert.ok(found.some((f) => f.path === fake));
  assert.ok(!found.some((f) => f.path === path.join(dir, "notmatch.exe")));
});
