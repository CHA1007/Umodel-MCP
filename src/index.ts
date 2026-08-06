#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findConfigFile, loadConfig, saveConfig } from "./config.js";
import { commonArgs, formatResult, runUmodel } from "./umodel.js";
import { listTree } from "./tree.js";

const server = new McpServer({
  name: "umodel-mcp",
  version: "0.1.0",
});

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
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
    }),
  },
  async (args) => {
    const { file, config } = saveConfig(args);
    return text(`Saved config to ${file}:\n${JSON.stringify(config, null, 2)}`);
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
    }),
  },
  async ({ directory, extensions, limit }) => {
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
      ...commonSchema,
    }),
  },
  async ({ package: pkg, ...rest }) => {
    const cfg = loadConfig();
    const args = ["-list", ...commonArgs(rest, cfg), pkg];
    const r = await runUmodel(cfg, args);
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
      ...commonSchema,
    }),
  },
  async ({ package: pkg, ...rest }) => {
    const cfg = loadConfig();
    const args = ["-pkginfo", ...commonArgs(rest, cfg), pkg];
    const r = await runUmodel(cfg, args);
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
      ...commonSchema,
    }),
  },
  async ({ package: pkg, timeoutMs, ...opts }) => {
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
      ...commonSchema,
    }),
  },
  async ({ package: pkg, timeoutMs, ...opts }) => {
    const cfg = loadConfig();
    const out = opts.out ?? cfg.outputDir;
    if (!out) return text("No output directory given: pass 'out' or configure outputDir.");
    const args = ["-save", ...commonArgs(opts, cfg), pkg];
    const r = await runUmodel(cfg, args, timeoutMs);
    let msg = formatResult(r);
    if (r.exitCode === 0) {
      msg += `\n\nSaved packages under: ${out}`;
      msg += `\n\n--- output structure ---\n${listTree(out, { maxEntries: 100 })}`;
    }
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
