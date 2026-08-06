import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Session } from "./session.js";

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  command: string;
}

const MAX_OUTPUT = 64 * 1024;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n...（已截断 ${s.length - MAX_OUTPUT} 字符）`;
}

export function runUmodel(
  exe: string | undefined,
  args: string[],
  timeoutMs?: number,
): Promise<RunResult> {
  if (!exe) {
    throw new Error(
      "umodel 可执行文件路径未知。请先向用户询问 umodel_64.exe 的路径并用 umodel_session_set 记住；" +
        "用户不清楚时再用 umodel_find_exe 自动搜索。",
    );
  }
  if (!fs.existsSync(exe)) {
    throw new Error(
      `umodel 可执行文件不存在: ${exe}。请让用户确认正确路径（umodel_session_set 更新），或用 umodel_find_exe 自动搜索。`,
    );
  }
  const timeout = timeoutMs ?? 300_000;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(exe, args, { windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut,
        command: `"${exe}" ${args.map(quoteArg).join(" ")}`,
      });
    });
  });
}

function quoteArg(a: string): string {
  return /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

export function commonArgs(
  opts: { gamePath?: string; gameTag?: string; aesKeys?: string[] },
  s: Session,
): string[] {
  const args: string[] = [];
  if (opts.gamePath && fs.existsSync(opts.gamePath)) s.gamePath = opts.gamePath;
  if (opts.gameTag) s.gameTag = opts.gameTag;
  if (opts.aesKeys?.length) s.aesKeys = opts.aesKeys;
  const p = opts.gamePath ?? s.gamePath;
  if (p) args.push(`-path=${p}`);
  const tag = opts.gameTag ?? s.gameTag;
  if (tag) args.push(`-game=${tag}`);
  for (const k of opts.aesKeys ?? s.aesKeys ?? []) args.push(`-aes=${k}`);
  return args;
}

export function formatResult(r: RunResult): string {
  const parts: string[] = [];
  parts.push(`$ ${r.command}`);
  parts.push(`退出码: ${r.exitCode}${r.timedOut ? "（超时）" : ""}`);
  if (r.timedOut) {
    parts.push(
      "提示：超时通常是 umodel 弹出了对话框在等待人工操作（输入 AES key 或选择引擎版本）。" +
        "请确认是否缺少 aesKeys / gameTag，补全后重试；不要反复盲目重试。",
    );
  }
  if (r.stdout.trim()) parts.push(`--- 标准输出 ---\n${r.stdout}`);
  if (r.stderr.trim()) parts.push(`--- 标准错误 ---\n${r.stderr}`);
  return parts.join("\n");
}
