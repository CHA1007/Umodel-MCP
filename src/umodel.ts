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
  return s.slice(0, MAX_OUTPUT) + `\n...(truncated ${s.length - MAX_OUTPUT} chars)`;
}

export function runUmodel(
  exe: string | undefined,
  args: string[],
  timeoutMs?: number,
): Promise<RunResult> {
  if (!exe) {
    throw new Error(
      "umodel executable path is unknown. Ask the user for the path to umodel_64.exe and remember it via umodel_session_set; " +
        "use umodel_find_exe to search automatically if the user does not know.",
    );
  }
  if (!fs.existsSync(exe)) {
    throw new Error(
      `umodel executable does not exist: ${exe}. Ask the user to confirm the correct path (update via umodel_session_set), or use umodel_find_exe to search automatically.`,
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

export function commonArgs(s: Session): string[] {
  const args: string[] = [];
  if (s.gamePath) args.push(`-path=${s.gamePath}`);
  if (s.gameTag) args.push(`-game=${s.gameTag}`);
  for (const k of s.aesKeys ?? []) args.push(`-aes=${k}`);
  return args;
}

export function formatResult(r: RunResult): string {
  const parts: string[] = [];
  parts.push(`$ ${r.command}`);
  parts.push(`Exit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`);
  if (r.timedOut) {
    parts.push(
      "Hint: a timeout usually means umodel popped up a dialog waiting for human input (AES key or engine version). " +
        "Check whether aesKeys / gameTag is missing and retry after fixing it; do not blindly retry.",
    );
  }
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr}`);
  return parts.join("\n");
}
