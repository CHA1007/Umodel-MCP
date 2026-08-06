import { spawn } from "node:child_process";
import fs from "node:fs";
import { UmodelConfig } from "./config.js";

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
  return s.slice(0, MAX_OUTPUT) + `\n... [truncated ${s.length - MAX_OUTPUT} chars]`;
}

export function runUmodel(
  cfg: UmodelConfig,
  args: string[],
  timeoutMs?: number,
): Promise<RunResult> {
  const exe = cfg.umodelExe;
  if (!exe) {
    throw new Error(
      "umodel executable is not configured. Set umodelExe in umodel-mcp.json or the UMODEL_EXE environment variable.",
    );
  }
  if (!fs.existsSync(exe)) {
    throw new Error(`umodel executable not found: ${exe}`);
  }
  const fullArgs = [...args, ...(cfg.defaultArgs ?? [])];
  const timeout = timeoutMs ?? cfg.timeoutMs ?? 300_000;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(exe, fullArgs, { windowsHide: true });
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
        command: `"${exe}" ${fullArgs.map(quoteArg).join(" ")}`,
      });
    });
  });
}

function quoteArg(a: string): string {
  return /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

export function commonArgs(opts: {
  gamePath?: string;
  gameTag?: string;
  aesKeys?: string[];
}, cfg: UmodelConfig): string[] {
  const args: string[] = [];
  const path_ = opts.gamePath ?? cfg.gamePath;
  if (path_) args.push(`-path=${path_}`);
  const tag = opts.gameTag ?? cfg.gameTag;
  if (tag) args.push(`-game=${tag}`);
  const keys = opts.aesKeys ?? cfg.aesKeys ?? [];
  for (const k of keys) args.push(`-aes=${k}`);
  return args;
}

export function formatResult(r: RunResult): string {
  const parts: string[] = [];
  parts.push(`$ ${r.command}`);
  parts.push(`exit code: ${r.exitCode}${r.timedOut ? " (TIMED OUT)" : ""}`);
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr}`);
  return parts.join("\n");
}
