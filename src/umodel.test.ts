import assert from "node:assert/strict";
import { test } from "node:test";
import { commonArgs, formatResult, runUmodel } from "./umodel.js";

test("commonArgs 生成 umodel 命令行参数", () => {
  assert.deepEqual(commonArgs({}), []);
  assert.deepEqual(
    commonArgs({ gamePath: "C:/game", gameTag: "ue4.27", aesKeys: ["0xaa", "0xbb"] }),
    ["-path=C:/game", "-game=ue4.27", "-aes=0xaa", "-aes=0xbb"],
  );
});

test("formatResult 汇总命令输出并给出超时提示", () => {
  const base = {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    timedOut: false,
    command: '"umodel.exe" -version',
  };
  const normal = formatResult(base);
  assert.ok(normal.includes('"umodel.exe" -version'));
  assert.ok(normal.includes("Exit code: 0"));
  assert.ok(normal.includes("ok"));
  assert.ok(!normal.includes("dialog"));

  const timedOut = formatResult({ ...base, timedOut: true, exitCode: null });
  assert.ok(timedOut.includes("(timed out)"));
  assert.ok(timedOut.includes("dialog"));
});

test("runUmodel 在未提供或路径无效时抛出引导性错误", () => {
  assert.throws(() => runUmodel(undefined, ["-version"]), /umodel_session_set/);
  assert.throws(() => runUmodel("C:/missing/umodel.exe", ["-version"]), /does not exist/);
});

test("runUmodel 执行并捕获子进程输出", async () => {
  const r = await runUmodel(process.execPath, ["-e", "console.log(42)"], 15_000);
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout.trim(), "42");
});

test("runUmodel 超时后终止子进程", async () => {
  const r = await runUmodel(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], 500);
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
});
