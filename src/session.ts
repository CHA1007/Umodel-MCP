import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PakAesMode } from "./pak.js";

export interface Session {
  umodelExe?: string;
  umodelExeConfirmed?: boolean;
  gamePath?: string;
  gameTag?: string;
  aesKeys?: string[];
  outputDir?: string;
  pakAesKey?: string;
  pakAesMode?: PakAesMode;
}

export const session: Session = {};

export function defaultOutputDir(): string {
  return path.join(os.homedir(), "Downloads", "umodel-export");
}

export function resolveOutputDir(): string {
  return session.outputDir ?? defaultOutputDir();
}

export function applyOverrides(opts: { gamePath?: string; gameTag?: string; aesKeys?: string[] }): string[] {
  const remembered: string[] = [];
  if (opts.gamePath && fs.existsSync(opts.gamePath)) {
    session.gamePath = opts.gamePath;
    remembered.push("gamePath");
  }
  if (opts.gameTag) {
    session.gameTag = opts.gameTag;
    remembered.push("gameTag");
  }
  if (opts.aesKeys?.length) {
    session.aesKeys = opts.aesKeys;
    remembered.push("aesKeys");
  }
  return remembered;
}

export function rememberDirectory(dir?: string): boolean {
  if (dir && fs.existsSync(dir)) {
    session.gamePath = dir;
    return true;
  }
  return false;
}

const EXE_PATTERN = /^umodel.*\.exe$/i;
const DIR_HINT = /umodel|ue.?viewer/i;

export interface FoundExe {
  path: string;
  size: number;
  mtime: string;
}

export function findUmodelExes(extraRoots?: string[]): FoundExe[] {
  const found = new Map<string, FoundExe>();
  const budget = { visits: 4000 };

  const add = (full: string) => {
    if (found.has(full)) return;
    try {
      const st = fs.statSync(full);
      found.set(full, { path: full, size: st.size, mtime: st.mtime.toISOString() });
    } catch {
      return;
    }
  };

  const walk = (root: string, maxDepth: number, hinted: boolean) => {
    const rec = (dir: string, depth: number, deep: boolean) => {
      if (budget.visits-- <= 0 || depth > maxDepth || found.size >= 30) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (budget.visits <= 0 || found.size >= 30) return;
        const full = path.join(dir, e.name);
        if (e.isFile()) {
          if (EXE_PATTERN.test(e.name)) add(full);
        } else if (e.isDirectory()) {
          const childHinted = DIR_HINT.test(e.name);
          if (deep || childHinted) rec(full, depth + 1, deep || childHinted);
        }
      }
    };
    rec(root, 0, hinted);
  };

  for (const r of extraRoots ?? []) walk(r, 5, true);

  const home = os.homedir();
  const defaultRoots = [
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    "C:/Program Files",
    "C:/Program Files (x86)",
  ].filter((r): r is string => !!r);
  for (const r of defaultRoots) walk(r, 2, false);

  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && EXE_PATTERN.test(e.name)) add(path.join(dir, e.name));
    }
  }

  return [...found.values()].sort((a, b) => b.mtime.localeCompare(a.mtime));
}
