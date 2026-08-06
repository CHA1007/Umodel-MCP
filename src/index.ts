#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findConfigFile, loadConfig, saveConfig } from "./config.js";
import { commonArgs, formatResult, runUmodel } from "./umodel.js";
import { listTree } from "./tree.js";
import { extractEntry, listPakFiles, parsePakIndex } from "./pak.js";

const server = new McpServer({
  name: "umodel-mcp",
  version: "0.1.0",
});

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const jsonFlag = z.boolean().optional().describe("Return machine-readable JSON instead of formatted text.");

function filterLines(stdout: string, filter?: string, skip?: number, limit?: number) {
  const all = stdout.split(/\r?\n/);
  const f = filter?.toLowerCase();
  const matched = f ? all.filter((l) => l.toLowerCase().includes(f)) : all;
  const start = skip ?? 0;
  const cap = limit ?? Math.max(matched.length - start, 0);
  return { total: matched.length, lines: matched.slice(start, start + cap) };
}

const commonSchema = {
  gamePath: z.string().optional().describe("Game installation directory (-path=). Overrides config."),
  gameTag: z.string().optional().describe("Game tag override (-game=), e.g. ue4.27. See umodel_game_list."),
  aesKeys: z.array(z.string()).optional().describe("AES keys for encrypted pak files (-aes=). Overrides config."),
};

server.registerTool(
  "umodel_config_get",
  {
    title: "Get umodel MCP configuration",
    description:
      "Show the resolved umodel MCP configuration (config file + environment overrides).",
    inputSchema: z.object({}),
  },
  async () => {
    const cfg = loadConfig();
    let exeOk = false;
    if (cfg.umodelExe && fs.existsSync(cfg.umodelExe)) exeOk = true;
    return text(
      JSON.stringify(
        { configFile: findConfigFile(), config: cfg, umodelExeExists: exeOk },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "umodel_config_set",
  {
    title: "Set umodel MCP configuration",
    description:
      "Persist umodel MCP settings to the config file (umodel-mcp.json). Pass empty string to clear a field.",
    inputSchema: z.object({
      umodelExe: z.string().optional().describe("Path to umodel.exe"),
      gamePath: z.string().optional().describe("Default game directory"),
      gameTag: z.string().optional().describe("Default game tag (-game=)"),
      aesKeys: z.array(z.string()).optional().describe("AES keys (-aes=)"),
      outputDir: z.string().optional().describe("Default export output directory (-out=)"),
      defaultArgs: z.array(z.string()).optional().describe("Extra args appended to every call"),
      timeoutMs: z.number().int().positive().optional().describe("Invocation timeout in ms"),
      pakDir: z.string().optional().describe("Default .pak directory for pak_list/pak_extract"),
      pakOutputDir: z.string().optional().describe("Default output directory for pak_extract"),
      pakAesKey: z.string().optional().describe("AES key (hex, 0x prefix optional) for encrypted pak index decryption"),
      pakAesMode: z
        .enum(["standard", "bitflip"])
        .optional()
        .describe("Pak AES mode: standard, or bitflip for games with custom bit-flipped AES"),
    }),
  },
  async (args) => {
    const { file, config } = saveConfig(args);
    return text(`Saved config to ${file}:\n${JSON.stringify(config, null, 2)}`);
  },
);

server.registerTool(
  "umodel_setup_check",
  {
    title: "Check umodel MCP setup",
    description:
      "Diagnose the current configuration and report what is missing or misconfigured, with suggested next steps. Run this first when other tools fail or on a fresh install.",
    inputSchema: z.object({}),
  },
  async () => {
    const cfg = loadConfig();
    const file = findConfigFile();
    const lines: string[] = [];
    const problems: string[] = [];
    const check = (label: string, ok: boolean, detail: string, hint?: string) => {
      lines.push(`${ok ? "[ok]     " : "[missing]"} ${label}: ${detail}`);
      if (!ok && hint) problems.push(hint);
    };
    check("config file", !!file, file ?? "not found", "Create umodel-mcp.json or call umodel_config_set.");
    const exeOk = !!cfg.umodelExe && fs.existsSync(cfg.umodelExe);
    check(
      "umodelExe",
      exeOk,
      cfg.umodelExe ?? "not set",
      "Set umodelExe to the path of umodel_64.exe via umodel_config_set.",
    );
    const gpOk = !!cfg.gamePath && fs.existsSync(cfg.gamePath);
    check("gamePath", gpOk, cfg.gamePath ?? "not set", "Set gamePath to the game's Content/Paks directory.");
    check("outputDir", !!cfg.outputDir, cfg.outputDir ?? "not set", "Set outputDir so exports land in a known folder.");
    check("gameTag", !!cfg.gameTag, cfg.gameTag ?? "not set (optional; see umodel_game_list)");
    const keyCount = (cfg.aesKeys ?? []).length;
    check("aesKeys", keyCount > 0, `${keyCount} key(s) (only needed for encrypted paks)`);
    const pakOk = !!cfg.pakDir && !!cfg.pakOutputDir;
    check(
      "pak setup",
      pakOk,
      cfg.pakDir
        ? `pakDir=${cfg.pakDir}, out=${cfg.pakOutputDir ?? "missing"}, key=${cfg.pakAesKey ? "set" : "none (ok for unencrypted paks)"}`
        : "not configured (only needed for pak_list/pak_extract)",
      "Set pakDir and pakOutputDir (plus pakAesKey for encrypted paks) via umodel_config_set.",
    );
    if (problems.length === 0) lines.push("\nAll checks passed.");
    else lines.push("\nNext steps:\n" + problems.map((p, i) => `${i + 1}. ${p}`).join("\n"));
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "umodel_version",
  {
    title: "umodel version",
    description: "Run 'umodel -version' to verify the executable works.",
    inputSchema: z.object({}),
  },
  async () => {
    const cfg = loadConfig();
    const r = await runUmodel(cfg, ["-version"]);
    return text(formatResult(r));
  },
);

server.registerTool(
  "umodel_game_list",
  {
    title: "List supported games",
    description:
      "List games supported by umodel. With tags=true shows the short tags usable with -game=/gameTag.",
    inputSchema: z.object({
      tags: z.boolean().optional().describe("true: show -taglist (short tags); false (default): -gamelist"),
    }),
  },
  async ({ tags }) => {
    const cfg = loadConfig();
    const r = await runUmodel(cfg, [tags ? "-taglist" : "-gamelist"]);
    return text(formatResult(r));
  },
);

const PACKAGE_EXTENSIONS = ["pak", "upk", "u", "ut2", "ut3", "uasset", "umap", "xxx", "ukx"];

server.registerTool(
  "umodel_list_packages",
  {
    title: "Find package files in a game directory",
    description:
      "Recursively scan a directory for Unreal package files (.pak/.upk/.uasset/.ut2/...) so you know what to pass to other tools.",
    inputSchema: z.object({
      directory: z.string().optional().describe("Directory to scan. Defaults to configured gamePath."),
      extensions: z
        .array(z.string())
        .optional()
        .describe(`Extensions to look for (without dot). Default: ${PACKAGE_EXTENSIONS.join(",")}`),
      limit: z.number().int().positive().optional().describe("Max number of files to return (default 500)"),
      json: jsonFlag,
    }),
  },
  async ({ directory, extensions, limit, json }) => {
    const cfg = loadConfig();
    const dir = directory ?? cfg.gamePath;
    if (!dir) return text("No directory given and no gamePath configured.");
    if (!fs.existsSync(dir)) return text(`Directory does not exist: ${dir}`);
    const exts = new Set((extensions ?? PACKAGE_EXTENSIONS).map((e) => e.toLowerCase().replace(/^\./, "")));
    const cap = limit ?? 500;
    const found: string[] = [];

    const walk = (d: string, depth: number) => {
      if (depth > 12 || found.length >= cap) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= cap) return;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).slice(1).toLowerCase();
          if (exts.has(ext)) found.push(full);
        }
      }
    };
    walk(dir, 0);

    if (found.length === 0) return text(`No package files found under ${dir}`);
    if (json)
      return text(JSON.stringify({ directory: dir, count: found.length, truncated: found.length >= cap, files: found }, null, 2));
    return text(
      `Found ${found.length}${found.length >= cap ? "+" : ""} package file(s) under ${dir}:\n` +
        found.join("\n"),
    );
  },
);

server.registerTool(
  "umodel_list_objects",
  {
    title: "List contents of a package",
    description: "Run 'umodel -list <package>' to list objects contained in a package.",
    inputSchema: z.object({
      package: z.string().describe("Package name (with or without extension), wildcard, or full file path"),
      filter: z.string().optional().describe("Case-insensitive substring filter applied to output lines."),
      skip: z.number().int().min(0).optional().describe("Number of (filtered) lines to skip (pagination)."),
      limit: z.number().int().positive().optional().describe("Max (filtered) lines to return (pagination)."),
      json: jsonFlag,
      ...commonSchema,
    }),
  },
  async ({ package: pkg, filter, skip, limit, json, ...rest }) => {
    const cfg = loadConfig();
    const args = ["-list", ...commonArgs(rest, cfg), pkg];
    const r = await runUmodel(cfg, args);
    const paginated = filter !== undefined || skip !== undefined || limit !== undefined;
    if (json) {
      const { total, lines } = filterLines(r.stdout, filter, skip, limit);
      return text(
        JSON.stringify(
          { command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, stderr: r.stderr, totalLines: total, lines },
          null,
          2,
        ),
      );
    }
    if (paginated) {
      const { total, lines } = filterLines(r.stdout, filter, skip, limit);
      let msg = `$ ${r.command}\nexit code: ${r.exitCode}${r.timedOut ? " (TIMED OUT)" : ""}`;
      msg += `\n${total} matching line(s), showing ${lines.length}:\n${lines.join("\n")}`;
      if (r.stderr.trim()) msg += `\n--- stderr ---\n${r.stderr}`;
      return text(msg);
    }
    return text(formatResult(r));
  },
);

server.registerTool(
  "umodel_package_info",
  {
    title: "Show package info",
    description: "Run 'umodel -pkginfo <package>' to display package summary (name table, export table).",
    inputSchema: z.object({
      package: z.string().describe("Package name, wildcard, or full file path"),
      json: jsonFlag,
      ...commonSchema,
    }),
  },
  async ({ package: pkg, json, ...rest }) => {
    const cfg = loadConfig();
    const args = ["-pkginfo", ...commonArgs(rest, cfg), pkg];
    const r = await runUmodel(cfg, args);
    if (json) return text(JSON.stringify(r, null, 2));
    return text(formatResult(r));
  },
);

server.registerTool(
  "umodel_export",
  {
    title: "Export assets from a package",
    description:
      "Run 'umodel -export' to convert assets (meshes, textures, animations, sounds...) to standard formats (psk/gltf/tga/png/...). " +
      "Without object filters the whole package is exported.",
    inputSchema: z.object({
      package: z.string().describe("Package name, wildcard, or full file path"),
      object: z.string().optional().describe("Single object name to export (positional <object>)"),
      className: z.string().optional().describe("Class of the object (positional <class>)"),
      objects: z.array(z.string()).optional().describe("Additional object filters (-obj=name, repeatable)"),
      out: z.string().optional().describe("Output directory (-out=). Defaults to configured outputDir or cwd."),
      meshFormat: z.enum(["psk", "md5", "gltf"]).optional().describe("Mesh export format (default psk)"),
      textureFormat: z.enum(["tga", "png", "dds"]).optional().describe("Texture format (default tga; dds keeps original compression)"),
      lods: z.boolean().optional().describe("Export all mesh LOD levels (-lods)"),
      uncook: z.boolean().optional().describe("Use original package names for output dirs (-uncook, UE3)"),
      groups: z.boolean().optional().describe("Use group names for directories instead of class names (-groups, UE1-3)"),
      scripts: z.boolean().optional().describe("Export UnrealScript as .uc (-uc)"),
      sounds: z.boolean().optional().describe("Allow sound export (-sounds)"),
      thirdParty: z.boolean().optional().describe("Allow 3rd-party asset export: ScaleForm/FaceFX (-3rdparty)"),
      noOverwrite: z.boolean().optional().describe("Do not overwrite existing files (-nooverwrite)"),
      timeoutMs: z.number().int().positive().optional().describe("Override invocation timeout (ms)"),
      json: jsonFlag,
      ...commonSchema,
    }),
  },
  async ({ package: pkg, timeoutMs, json, ...opts }) => {
    const cfg = loadConfig();
    const args: string[] = ["-export"];
    if (opts.meshFormat) args.push(`-${opts.meshFormat}`);
    if (opts.textureFormat === "png") args.push("-png");
    else if (opts.textureFormat === "dds") args.push("-dds");
    if (opts.lods) args.push("-lods");
    if (opts.uncook) args.push("-uncook");
    if (opts.groups) args.push("-groups");
    if (opts.scripts) args.push("-uc");
    if (opts.sounds) args.push("-sounds");
    if (opts.thirdParty) args.push("-3rdparty");
    if (opts.noOverwrite) args.push("-nooverwrite");
    const out = opts.out ?? cfg.outputDir;
    if (out) args.push(`-out=${out}`);
    args.push(...commonArgs(opts, cfg));
    for (const o of opts.objects ?? []) args.push(`-obj=${o}`);
    args.push(pkg);
    if (opts.object) args.push(opts.object);
    if (opts.className) args.push(opts.className);
    const r = await runUmodel(cfg, args, timeoutMs);
    if (json) return text(JSON.stringify({ ...r, out }, null, 2));
    let msg = formatResult(r);
    if (r.exitCode === 0 && out) {
      msg += `\n\nExported files were written under: ${out}`;
      msg += `\n\n--- output structure ---\n${listTree(out, { maxEntries: 100 })}`;
    }
    return text(msg);
  },
);

server.registerTool(
  "umodel_save",
  {
    title: "Save raw packages",
    description:
      "Run 'umodel -save' to copy raw package files (.upk/.uasset + .uexp/.ubulk) out of a game directory, e.g. to unpack a cooked game without converting.",
    inputSchema: z.object({
      package: z.string().describe("Package name, wildcard, or full file path"),
      out: z.string().optional().describe("Output directory (-out=). Defaults to configured outputDir."),
      keepStructure: z
        .boolean()
        .optional()
        .describe("Keep directory structure (default true matches GUI default)"),
      timeoutMs: z.number().int().positive().optional(),
      json: jsonFlag,
      ...commonSchema,
    }),
  },
  async ({ package: pkg, timeoutMs, json, ...opts }) => {
    const cfg = loadConfig();
    const out = opts.out ?? cfg.outputDir;
    if (!out) return text("No output directory given: pass 'out' or configure outputDir.");
    const args = ["-save"];
    args.push(`-out=${out}`);
    args.push(...commonArgs(opts, cfg), pkg);
    const r = await runUmodel(cfg, args, timeoutMs);
    if (json) return text(JSON.stringify({ ...r, out }, null, 2));
    let msg = formatResult(r);
    if (r.exitCode === 0) {
      msg += `\n\nSaved packages under: ${out}`;
      msg += `\n\n--- output structure ---\n${listTree(out, { maxEntries: 100 })}`;
    }
    return text(msg);
  },
);

server.registerTool(
  "pak_list",
  {
    title: "List files inside UE .pak archives",
    description:
      "Parse UE .pak index files (AES-encrypted indexes supported, including games using custom bit-flipped AES) and list asset paths matching the filters. " +
      "Works without umodel. Use this before pak_extract to locate assets (meshes/textures/animations).",
    inputSchema: z.object({
      filters: z.array(z.string()).min(1).describe("Case-insensitive substrings to match, e.g. ['SKM_PC2']"),
      pakDir: z.string().optional().describe("Pak directory. Defaults to configured pakDir."),
      pakFilter: z.string().optional().describe("Only scan paks whose file name contains this substring"),
      aesMode: z
        .enum(["standard", "bitflip"])
        .optional()
        .describe("Index decryption mode. Overrides configured pakAesMode (default standard)."),
      limit: z.number().int().positive().optional().describe("Max entries to return (default 200)"),
      json: jsonFlag,
    }),
  },
  async ({ filters, pakDir, pakFilter, aesMode, limit, json }) => {
    const cfg = loadConfig();
    const dir = pakDir ?? cfg.pakDir;
    const mode = aesMode ?? cfg.pakAesMode ?? "standard";
    if (!dir) return text("No pak directory given: pass 'pakDir' or configure pakDir.");
    const paks = listPakFiles(dir, pakFilter);
    if (paks.length === 0) return text(`No .pak files found in ${dir}`);
    const cap = limit ?? 200;
    const matches: { pak: string; path: string; size: number }[] = [];
    const errors: string[] = [];
    let scanned = 0;
    for (const p of paks) {
      if (matches.length >= cap) break;
      let index;
      try {
        index = parsePakIndex(p, cfg.pakAesKey, mode);
      } catch (e) {
        errors.push(`${path.basename(p)}: ${e}`);
        continue;
      }
      if (!index) continue;
      scanned++;
      for (const e of index.entries) {
        if (matches.length >= cap) break;
        const lower = e.path.toLowerCase();
        if (filters.some((f) => lower.includes(f.toLowerCase()))) {
          matches.push({ pak: e.pak, path: e.path, size: e.size });
        }
      }
    }
    if (json)
      return text(
        JSON.stringify(
          { directory: dir, scanned, totalPaks: paks.length, filters, truncated: matches.length >= cap, matches, errors },
          null,
          2,
        ),
      );
    if (matches.length === 0) {
      let msg = `No matches for [${filters.join(", ")}] after scanning ${scanned}/${paks.length} paks in ${dir}`;
      if (errors.length) msg += `\n\nErrors (first 10):\n${errors.slice(0, 10).join("\n")}`;
      return text(msg);
    }
    let msg =
      `Scanned ${scanned}/${paks.length} paks in ${dir}\nMatches for [${filters.join(", ")}]:\n` +
      matches.map((m) => `${m.pak} :: ${m.path}  (${m.size} bytes)`).join("\n") +
      (matches.length >= cap ? "\n... (truncated)" : "");
    if (errors.length) msg += `\n\nErrors:\n${errors.slice(0, 10).join("\n")}`;
    return text(msg);
  },
);

server.registerTool(
  "pak_extract",
  {
    title: "Extract files from UE .pak archives",
    description:
      "Extract raw .uasset/.uexp files from UE .pak archives by parsing the index directly (AES-encrypted indexes supported, including custom bit-flipped AES). " +
      "Works without umodel. The extracted loose files can then be converted with umodel_export (point it at the output directory).",
    inputSchema: z.object({
      filters: z.array(z.string()).min(1).describe("Case-insensitive substrings to match, e.g. ['SKM_PC2']"),
      pakDir: z.string().optional().describe("Pak directory. Defaults to configured pakDir."),
      out: z.string().optional().describe("Output directory. Defaults to configured pakOutputDir."),
      pakFilter: z.string().optional().describe("Only scan paks whose file name contains this substring"),
      aesMode: z
        .enum(["standard", "bitflip"])
        .optional()
        .describe("Decryption mode. Overrides configured pakAesMode (default standard)."),
      maxFiles: z.number().int().positive().optional().describe("Max files to extract (default 200)"),
      json: jsonFlag,
    }),
  },
  async ({ filters, pakDir, out, pakFilter, aesMode, maxFiles, json }) => {
    const cfg = loadConfig();
    const dir = pakDir ?? cfg.pakDir;
    const outDir = out ?? cfg.pakOutputDir;
    const mode = aesMode ?? cfg.pakAesMode ?? "standard";
    if (!dir) return text("No pak directory given: pass 'pakDir' or configure pakDir.");
    if (!outDir) return text("No output directory given: pass 'out' or configure pakOutputDir.");
    const paks = listPakFiles(dir, pakFilter);
    if (paks.length === 0) return text(`No .pak files found in ${dir}`);
    const cap = maxFiles ?? 200;
    const extracted: { path: string; size: number }[] = [];
    const warnings: string[] = [];
    for (const p of paks) {
      if (extracted.length >= cap) break;
      let index;
      try {
        index = parsePakIndex(p, cfg.pakAesKey, mode);
      } catch (err) {
        warnings.push(`${path.basename(p)}: ${err}`);
        continue;
      }
      if (!index) continue;
      for (const e of index.entries) {
        if (extracted.length >= cap) break;
        const lower = e.path.toLowerCase();
        if (!filters.some((f) => lower.includes(f.toLowerCase()))) continue;
        const m = e.method.toLowerCase();
        if (m !== "none" && m !== "zlib" && m !== "gzip") {
          warnings.push(`${e.path}: unsupported compression (${e.method}), skipped`);
          continue;
        }
        try {
          extractEntry(p, e, outDir, cfg.pakAesKey, mode);
          extracted.push({ path: e.path, size: e.size });
        } catch (err) {
          warnings.push(`${e.path}: ${err}`);
        }
      }
    }
    if (json)
      return text(JSON.stringify({ outDir, filters, truncated: extracted.length >= cap, extracted, warnings }, null, 2));
    let msg: string;
    if (extracted.length === 0) {
      msg = `Nothing extracted for [${filters.join(", ")}].`;
    } else {
      msg =
        `Extracted ${extracted.length} file(s) to ${outDir}:\n` +
        extracted.map((e) => `${e.path}  (${e.size} bytes)`).join("\n");
      msg += `\n\n--- output structure ---\n${listTree(outDir, { maxEntries: 100 })}`;
    }
    if (warnings.length) msg += `\n\nWarnings:\n` + warnings.slice(0, 20).join("\n");
    return text(msg);
  },
);

server.registerTool(
  "umodel_list_output",
  {
    title: "Show exported files directory tree",
    description:
      "List the folder structure and files produced by umodel_export/umodel_save, with sizes. " +
      "Use this after an export to see what was unpacked.",
    inputSchema: z.object({
      directory: z.string().optional().describe("Directory to inspect. Defaults to configured outputDir."),
      maxDepth: z.number().int().positive().optional().describe("Max folder depth to expand (default 8)"),
      maxEntries: z.number().int().positive().optional().describe("Max entries to show (default 400)"),
    }),
  },
  async ({ directory, maxDepth, maxEntries }) => {
    const cfg = loadConfig();
    const dir = directory ?? cfg.outputDir;
    if (!dir) return text("No directory given: pass 'directory' or configure outputDir.");
    return text(listTree(dir, { maxDepth, maxEntries }));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
