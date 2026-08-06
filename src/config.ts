import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface UmodelConfig {
  umodelExe?: string;
  gamePath?: string;
  gameTag?: string;
  aesKeys?: string[];
  outputDir?: string;
  defaultArgs?: string[];
  timeoutMs?: number;
  nrcPakDir?: string;
  nrcOutputDir?: string;
  nrcAesKey?: string;
}

function configCandidates(): string[] {
  const list: string[] = [];
  if (process.env.UMODEL_MCP_CONFIG) list.push(process.env.UMODEL_MCP_CONFIG);
  list.push(path.resolve(process.cwd(), "umodel-mcp.json"));
  list.push(path.join(os.homedir(), ".umodel-mcp", "config.json"));
  return list;
}

let cachedFile: string | null = null;

export function findConfigFile(): string | null {
  for (const f of configCandidates()) {
    if (fs.existsSync(f)) {
      cachedFile = f;
      return f;
    }
  }
  return null;
}

export function loadConfig(): UmodelConfig {
  let fileConfig: UmodelConfig = {};
  const file = findConfigFile();
  if (file) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(file, "utf8")) as UmodelConfig;
    } catch (e) {
      throw new Error(`Failed to parse config file ${file}: ${e}`);
    }
  }
  const cfg: UmodelConfig = { ...fileConfig };
  if (process.env.UMODEL_EXE) cfg.umodelExe = process.env.UMODEL_EXE;
  if (process.env.UMODEL_GAME_PATH) cfg.gamePath = process.env.UMODEL_GAME_PATH;
  if (process.env.UMODEL_GAME_TAG) cfg.gameTag = process.env.UMODEL_GAME_TAG;
  if (process.env.UMODEL_AES_KEY) {
    cfg.aesKeys = process.env.UMODEL_AES_KEY.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.UMODEL_OUTPUT_DIR) cfg.outputDir = process.env.UMODEL_OUTPUT_DIR;
  if (process.env.UMODEL_TIMEOUT_MS) cfg.timeoutMs = Number(process.env.UMODEL_TIMEOUT_MS);
  return cfg;
}

export function saveConfig(patch: UmodelConfig): { file: string; config: UmodelConfig } {
  const file =
    cachedFile ??
    process.env.UMODEL_MCP_CONFIG ??
    path.resolve(process.cwd(), "umodel-mcp.json");
  let current: UmodelConfig = {};
  if (fs.existsSync(file)) {
    current = JSON.parse(fs.readFileSync(file, "utf8")) as UmodelConfig;
  }
  const merged: UmodelConfig = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") {
      delete (merged as Record<string, unknown>)[k];
    } else {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
  cachedFile = file;
  return { file, config: merged };
}
