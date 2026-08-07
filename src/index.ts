#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyOverrides, defaultOutputDir, findUmodelExes, rememberDirectory, resolveOutputDir, session } from "./session.js";
import { commonArgs, formatResult, runUmodel } from "./umodel.js";
import { formatSize, listTree } from "./tree.js";
import { detectPakEncryption, extractEntry, listPakFiles, parsePakIndex, SUPPORTED_COMPRESSION, type PakKey } from "./pak.js";

const server = new McpServer({
  name: "umodel-mcp",
  version: "0.2.0",
});

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function respond(s: string, ok: boolean) {
  return ok ? text(s) : errorText(s);
}

const jsonFlag = z.boolean().optional().describe("Return machine-readable JSON instead of formatted text.");

function filterLines(stdout: string, filter?: string, skip?: number, limit?: number) {
  const all = stdout.split(/\r?\n/);
  const f = filter?.toLowerCase();
  const matched = f ? all.filter((l) => l.toLowerCase().includes(f)) : all;
  const start = skip ?? 0;
  const cap = limit ?? Math.min(500, Math.max(matched.length - start, 0));
  return { total: matched.length, lines: matched.slice(start, start + cap) };
}

const commonSchema = {
  gamePath: z
    .string()
    .optional()
    .describe("Game installation directory (-path=). Overrides session. If unknown, ask the user first."),
  gameTag: z
    .string()
    .optional()
    .describe(
      "Game tag override (-game=), e.g. ue4.27 or an official tag like roco. " +
        "Cooked UE4/5 games REQUIRE a tag — without it umodel pops a blocking GUI dialog. See umodel_game_list.",
    ),
  aesKeys: z.array(z.string()).optional().describe("AES keys for encrypted pak files (-aes=). Overrides session."),
};

server.registerTool(
  "umodel_session_get",
  {
    title: "Show current session settings",
    description:
      "Show the in-memory session settings (umodel exe, game directory, output directory, AES keys). " +
      "No config file is used; settings live only for this server session.",
    inputSchema: z.object({}),
  },
  async () => {
    const exeOk = !!session.umodelExe && fs.existsSync(session.umodelExe);
    return text(
      JSON.stringify(
        {
          session,
          umodelExeExists: exeOk,
          resolvedOutputDir: resolveOutputDir(),
          defaultOutputDir: defaultOutputDir(),
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "umodel_session_set",
  {
    title: "Remember session settings",
    description:
      "Store settings in the in-memory session (nothing is written to disk). " +
      "NOTE: most values (gamePath/gameTag/aesKeys/pakAesKey/pakAesMode) are auto-remembered whenever you pass them to any tool, " +
      "so you rarely need this tool — use it only to set values ahead of time, clear them (empty string), " +
      "or configure pure settings: umodelExe (user-confirmed), outputDir, pakAesMode. " +
      "IMPORTANT: umodelExe and gamePath must come from the user — ask the user for the umodel executable path " +
      "and the game/pak directory before setting them; never guess. " +
      "Only fall back to umodel_find_exe when the user does not know the path or the given path is wrong. " +
      "Pass an empty string to clear a field. outputDir defaults to the Downloads folder when unset.",
    inputSchema: z.object({
      umodelExe: z
        .string()
        .optional()
        .describe(
          "Path to the umodel executable the USER confirmed as the right version for the target game (ask first). " +
            "Setting this marks the exe as confirmed; auto-discovery alone leaves it unconfirmed.",
        ),
      gamePath: z.string().optional().describe("Game / pak directory (ask the user first)"),
      gameTag: z.string().optional().describe("Default game tag (-game=)"),
      aesKeys: z.array(z.string()).optional().describe("AES keys (-aes=)"),
      outputDir: z.string().optional().describe("Export output directory (-out=). Default: Downloads/umodel-export"),
      pakAesKey: z.string().optional().describe("AES key (hex, 0x prefix optional) for pak index decryption"),
      pakAesMode: z
        .union([z.enum(["standard", "bitflip"]), z.literal("")])
        .optional()
        .describe("Pak AES mode: standard, or bitflip for games with custom bit-flipped AES. Pass \"\" to clear."),
    }),
  },
  async (args) => {
    const setStr = (key: keyof typeof session, v?: string) => {
      if (v === undefined) return;
      if (v === "") delete session[key];
      else session[key] = v as never;
    };
    setStr("umodelExe", args.umodelExe);
    if (args.umodelExe !== undefined) {
      if (args.umodelExe === "") delete session.umodelExeConfirmed;
      else session.umodelExeConfirmed = true;
    }
    setStr("gamePath", args.gamePath);
    setStr("gameTag", args.gameTag);
    setStr("outputDir", args.outputDir);
    setStr("pakAesKey", args.pakAesKey);
    if (args.pakAesMode !== undefined) {
      if (args.pakAesMode === "") delete session.pakAesMode;
      else session.pakAesMode = args.pakAesMode;
    }
    if (args.aesKeys !== undefined) session.aesKeys = args.aesKeys.filter(Boolean);
    return text(`Session updated:\n${JSON.stringify(session, null, 2)}`);
  },
);

server.registerTool(
  "umodel_find_exe",
  {
    title: "Auto-locate umodel executable",
    description:
      "Search common locations (Downloads/Desktop/Documents/Program Files/PATH...) for umodel executables " +
      "(umodel.exe, umodel_64.exe, or custom builds like umodel_acl_*.exe). " +
      "ONLY use this as a fallback when the user does not know the umodel path or provided an invalid one — " +
      "always ask the user for the path first. With verify=true the newest candidate is tested via -version and remembered. " +
      "IMPORTANT: different umodel builds/versions support different games (e.g. umodel_acl variants). " +
      "If more than one candidate is found the remembered exe stays UNCONFIRMED and per-game tools refuse to run " +
      "until you show the candidate list to the user, ask which version to use for the target game, " +
      "and confirm it via umodel_session_set { umodelExe }. Never pick a version yourself.",
    inputSchema: z.object({
      dirs: z
        .array(z.string())
        .optional()
        .describe("Extra directories to search deeply (e.g. a folder the user vaguely remembers)."),
      verify: z.boolean().optional().describe("Run -version on the newest candidate and remember it if it works."),
      json: jsonFlag,
    }),
  },
  async ({ dirs, verify, json }) => {
    const candidates = findUmodelExes(dirs);
    if (candidates.length === 0) {
      return errorText(
        "No umodel executable found. Ask the user to download UE Viewer from https://www.gildor.org/en/projects/umodel, " +
          "extract it, and provide the full path to umodel_64.exe.",
      );
    }
    if (json) return text(JSON.stringify({ candidates }, null, 2));
    let msg =
      `Found ${candidates.length} candidate umodel executable(s) (newest first):\n` +
      candidates
        .map((c) => `${c.path}  (${formatSize(c.size)}, ${c.mtime.slice(0, 10)})`)
        .join("\n");
    if (verify) {
      const top = candidates[0];
      try {
        const r = await runUmodel(top.path, ["-version"], 30_000);
        if (r.exitCode === 0) {
          session.umodelExe = top.path;
          session.umodelExeConfirmed = candidates.length === 1;
          msg += `\n\nVerified and remembered: ${top.path}\n${r.stdout.trim()}`;
          if (candidates.length > 1) {
            msg +=
              `\n\nNote: ${candidates.length} umodel candidates exist on this machine; the one remembered is just the newest and remains UNCONFIRMED. ` +
              `Different umodel versions support different games. Show the candidate list to the user, ask which version to use for the target game, ` +
              `then confirm it via umodel_session_set { umodelExe }; otherwise the per-game tools will refuse to run.`;
          }
          return text(msg);
        }
        return errorText(msg + `\n\nVerification failed (${top.path}), exit code: ${r.exitCode}\n${r.stderr.trim()}`);
      } catch (e) {
        return errorText(msg + `\n\nVerification failed (${top.path}): ${e}`);
      }
    } else {
      msg += "\n\nAfter confirming a candidate, call umodel_session_set to remember it, or call again with verify=true to auto-verify.";
    }
    return text(msg);
  },
);

function preflightAes(pkg: string | undefined, gamePath: string | undefined, keys?: string[]): string | null {
  if ((keys ?? session.aesKeys ?? []).length > 0) return null;
  const targets: string[] = [];
  const gp = gamePath ?? session.gamePath;
  if (gp && fs.existsSync(gp)) targets.push(gp);
  if (pkg && pkg.toLowerCase().endsWith(".pak") && fs.existsSync(pkg)) targets.push(pkg);
  const bad = new Set<string>();
  for (const t of targets) {
    let files: string[];
    try {
      files = fs.statSync(t).isDirectory() ? listPakFiles(t).slice(0, 16) : [t];
    } catch {
      continue;
    }
    for (const f of files) {
      const info = detectPakEncryption(f);
      if (info && (info.encryptedIndex || info.encryptedEntries)) bad.add(info.pak);
    }
  }
  if (bad.size === 0) return null;
  return (
    `Encrypted pak detected but no AES key provided: ${[...bad].join(", ")}.\n` +
    `Calling umodel now would pop up a blocking GUI dialog asking for the AES key, so the call was blocked.\n` +
    `Ask the user for the AES key first, then remember it via umodel_session_set { aesKeys: ["0x..."] } or pass the aesKeys argument; ` +
    `if umodel does not support this game, use pak_list/pak_extract instead (with pakAesKey).`
  );
}

function preflightExe(): string | null {
  if (!session.umodelExe || session.umodelExeConfirmed) return null;
  return (
    `The current umodel executable ${session.umodelExe} was auto-discovered/verified but not confirmed by the user. ` +
    `Different umodel builds/versions support different games; using the wrong one causes parse failures or broken exports, so the call was blocked.\n` +
    `Call umodel_find_exe to get the candidate list, show it to the user, ask which umodel version to use for the target game, ` +
    `then remember the user-confirmed path via umodel_session_set { umodelExe }.`
  );
}

function preflightGameTag(pkg: string | undefined, gamePath: string | undefined, tag?: string): string | null {
  if (tag ?? session.gameTag) return null;
  const targets: string[] = [];
  const gp = gamePath ?? session.gamePath;
  if (gp && fs.existsSync(gp)) targets.push(gp);
  if (pkg && pkg.toLowerCase().endsWith(".pak") && fs.existsSync(pkg)) targets.push(pkg);
  for (const t of targets) {
    let paks: string[];
    try {
      paks = fs.statSync(t).isDirectory() ? listPakFiles(t).slice(0, 4) : [t];
    } catch {
      continue;
    }
    for (const p of paks) {
      let index;
      try {
        index = parsePakIndex(p, { keyHex: session.pakAesKey, mode: session.pakAesMode ?? "standard" });
      } catch {
        continue;
      }
      if (!index) continue;
      const cooked = index.entries.some((e) => {
        const lp = e.path.toLowerCase();
        return lp.endsWith(".uasset") || lp.endsWith(".uexp");
      });
      if (!cooked) continue;
      return (
        `Cooked (no version info) UE packages detected but gameTag is not set: calling umodel directly would pop up a blocking "Unreal engine 4 version" GUI dialog, so the call was blocked.\n` +
        `Handle it in this order:\n` +
        `1. Call umodel_game_list { tags: true } to check whether the game has an official tag (e.g. Roco Kingdom: World -> gameTag=roco);\n` +
        `2. If so, pass the gameTag argument or remember it via umodel_session_set { gameTag };\n` +
        `3. If not, ask the user which Unreal Engine version the game uses and use the matching tag (e.g. ue4.27).`
      );
    }
  }
  return null;
}

function preflightUmodel(
  pkg: string,
  opts: { gamePath?: string; gameTag?: string; aesKeys?: string[] },
): ReturnType<typeof errorText> | null {
  applyOverrides(opts);
  const err = preflightAes(pkg, opts.gamePath, opts.aesKeys) ?? preflightGameTag(pkg, opts.gamePath, opts.gameTag) ?? preflightExe();
  return err ? errorText(err) : null;
}

function scanPakIndexes(
  paks: string[],
  key: PakKey,
  onIndex: (pakPath: string, index: NonNullable<ReturnType<typeof parsePakIndex>>) => boolean,
): { scanned: number; errors: string[] } {
  let scanned = 0;
  const errors: string[] = [];
  for (const p of paks) {
    let index;
    try {
      index = parsePakIndex(p, key);
    } catch (e) {
      errors.push(`${path.basename(p)}: ${e}`);
      continue;
    }
    if (!index) continue;
    scanned++;
    if (!onIndex(p, index)) break;
  }
  return { scanned, errors };
}

server.registerTool(
  "umodel_version",
  {
    title: "Verify umodel executable",
    description:
      "Run 'umodel -version' to verify the executable works. Pass exe to test a new path; " +
      "if it works it is remembered in the session.",
    inputSchema: z.object({
      exe: z.string().optional().describe("Executable path to test (and remember if it works). Defaults to session."),
    }),
  },
  async ({ exe }) => {
    const target = exe ?? session.umodelExe;
    const r = await runUmodel(target, ["-version"], 30_000);
    if (exe && r.exitCode === 0) {
      session.umodelExe = exe;
      session.umodelExeConfirmed = false;
    }
    let msg = formatResult(r);
    if (exe && r.exitCode === 0) {
      msg +=
        `\n\nRemembered executable: ${exe} (UNCONFIRMED). ` +
        `If this path came from the user, confirm it via umodel_session_set { umodelExe } before calling the per-game tools.`;
    }
    return respond(msg, r.exitCode === 0);
  },
);

server.registerTool(
  "umodel_game_list",
  {
    title: "List supported games",
    description:
      "List games supported by umodel. With tags=true shows the short tags usable with -game=/gameTag. " +
      "Check this BEFORE any list/export/save call: if the user's game appears (e.g. Roco Kingdom: World -> roco), " +
      "remember it via umodel_session_set { gameTag } so later calls don't pop the blocking engine-version GUI dialog.",
    inputSchema: z.object({
      tags: z.boolean().optional().describe("true: show -taglist (short tags); false (default): -gamelist"),
    }),
  },
  async ({ tags }) => {
    const r = await runUmodel(session.umodelExe, [tags ? "-taglist" : "-gamelist"]);
    return respond(formatResult(r), r.exitCode === 0);
  },
);

const PACKAGE_EXTENSIONS = ["pak", "upk", "u", "ut2", "ut3", "uasset", "umap", "xxx", "ukx"];

server.registerTool(
  "umodel_list_packages",
  {
    title: "Find package files in a game directory",
    description:
      "Recursively scan a directory for Unreal package files (.pak/.upk/.uasset/.ut2/...) so you know what to pass to other tools. " +
      "The directory should come from the user — ask which game directory to unpack before scanning.",
    inputSchema: z.object({
      directory: z.string().optional().describe("Directory to scan. Defaults to session gamePath."),
      extensions: z
        .array(z.string())
        .optional()
        .describe(`Extensions to look for (without dot). Default: ${PACKAGE_EXTENSIONS.join(",")}`),
      limit: z.number().int().positive().optional().describe("Max number of files to return (default 500)"),
      json: jsonFlag,
    }),
  },
  async ({ directory, extensions, limit, json }) => {
    rememberDirectory(directory);
    const dir = directory ?? session.gamePath;
    if (!dir) return errorText("No directory provided and no gamePath in session. Ask the user for the game/pak directory first.");
    if (!fs.existsSync(dir)) return errorText(`Directory does not exist: ${dir}`);
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

    if (found.length === 0) return errorText(`No package files found under ${dir}`);
    const encrypted: { pak: string; index: boolean; entries: boolean }[] = [];
    for (const f of found.filter((f) => f.toLowerCase().endsWith(".pak")).slice(0, 32)) {
      const info = detectPakEncryption(f);
      if (info && (info.encryptedIndex || info.encryptedEntries)) {
        encrypted.push({ pak: info.pak, index: info.encryptedIndex, entries: info.encryptedEntries });
      }
    }
    if (json)
      return text(
        JSON.stringify(
          { directory: dir, count: found.length, truncated: found.length >= cap, files: found, encryptedPaks: encrypted },
          null,
          2,
        ),
      );
    let msg =
      `Found ${found.length}${found.length >= cap ? "+" : ""} package file(s) under ${dir}:\n` +
      found.join("\n");
    if (encrypted.length > 0) {
      msg +=
        `\n\n⚠ Encrypted paks (AES key required, otherwise umodel pops a blocking dialog):\n` +
        encrypted.map((e) => `${e.pak} (index ${e.index ? "" : "not "}encrypted, entries ${e.entries ? "" : "not "}encrypted)`).join("\n");
    }
    return text(msg);
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
    const blocked = preflightUmodel(pkg, rest);
    if (blocked) return blocked;
    const args = ["-list", ...commonArgs(session), pkg];
    const r = await runUmodel(session.umodelExe, args);
    const ok = r.exitCode === 0;
    const paginated = filter !== undefined || skip !== undefined || limit !== undefined;
    if (json) {
      const { total, lines } = filterLines(r.stdout, filter, skip, limit);
      return respond(
        JSON.stringify(
          { command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, stderr: r.stderr, totalLines: total, lines },
          null,
          2,
        ),
        ok,
      );
    }
    if (paginated) {
      const { total, lines } = filterLines(r.stdout, filter, skip, limit);
      const msg =
        formatResult({ ...r, stdout: lines.join("\n") }) +
        `\n\n${total} line(s) matched, returning ${lines.length} in this page`;
      return respond(msg, ok);
    }
    return respond(formatResult(r), ok);
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
    const blocked = preflightUmodel(pkg, rest);
    if (blocked) return blocked;
    const args = ["-pkginfo", ...commonArgs(session), pkg];
    const r = await runUmodel(session.umodelExe, args);
    const ok = r.exitCode === 0;
    if (json) return respond(JSON.stringify(r, null, 2), ok);
    return respond(formatResult(r), ok);
  },
);

server.registerTool(
  "umodel_export",
  {
    title: "Export assets from a package",
    description:
      "Run 'umodel -export' to convert assets (meshes, textures, animations, sounds...) to standard formats (psk/gltf/tga/png/...). " +
      "Without object filters the whole package is exported. Output defaults to the Downloads folder. " +
      "IMPORTANT: cooked UE4/5 games need a gameTag, otherwise umodel pops a blocking engine-version GUI dialog. " +
      "ALWAYS call umodel_game_list { tags: true } FIRST and use the official tag if the game is listed (e.g. roco); " +
      "the server blocks the call and reminds you if gameTag is missing.",
    inputSchema: z.object({
      package: z.string().describe("Package name, wildcard, or full file path"),
      object: z.string().optional().describe("Single object name to export (positional <object>)"),
      className: z.string().optional().describe("Class of the object (positional <class>)"),
      objects: z.array(z.string()).optional().describe("Additional object filters (-obj=name, repeatable)"),
      out: z.string().optional().describe("Output directory (-out=). Defaults to session outputDir or Downloads/umodel-export."),
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
    const blocked = preflightUmodel(pkg, opts);
    if (blocked) return blocked;
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
    const out = opts.out ?? resolveOutputDir();
    args.push(`-out=${out}`);
    args.push(...commonArgs(session));
    for (const o of opts.objects ?? []) args.push(`-obj=${o}`);
    args.push(pkg);
    if (opts.object) args.push(opts.object);
    if (opts.className) args.push(opts.className);
    const r = await runUmodel(session.umodelExe, args, timeoutMs);
    const ok = r.exitCode === 0;
    if (json) return respond(JSON.stringify({ ...r, out }, null, 2), ok);
    let msg = formatResult(r);
    if (ok && out) {
      msg += `\n\nFiles exported to: ${out}`;
      msg += `\n\n--- Output tree ---\n${listTree(out, { maxEntries: 100 })}`;
    }
    return respond(msg, ok);
  },
);

server.registerTool(
  "umodel_save",
  {
    title: "Save raw packages",
    description:
      "Run 'umodel -save' to copy raw package files (.upk/.uasset + .uexp/.ubulk) out of a game directory, e.g. to unpack a cooked game without converting. " +
      "Output defaults to the Downloads folder.",
    inputSchema: z.object({
      package: z.string().describe("Package name, wildcard, or full file path"),
      out: z.string().optional().describe("Output directory (-out=). Defaults to session outputDir or Downloads/umodel-export."),
      timeoutMs: z.number().int().positive().optional(),
      json: jsonFlag,
      ...commonSchema,
    }),
  },
  async ({ package: pkg, timeoutMs, json, ...opts }) => {
    const blocked = preflightUmodel(pkg, opts);
    if (blocked) return blocked;
    const out = opts.out ?? resolveOutputDir();
    const args = ["-save", `-out=${out}`, ...commonArgs(session), pkg];
    const r = await runUmodel(session.umodelExe, args, timeoutMs);
    const ok = r.exitCode === 0;
    if (json) return respond(JSON.stringify({ ...r, out }, null, 2), ok);
    let msg = formatResult(r);
    if (ok) {
      msg += `\n\nPackage files saved to: ${out}`;
      msg += `\n\n--- Output tree ---\n${listTree(out, { maxEntries: 100 })}`;
    }
    return respond(msg, ok);
  },
);

server.registerTool(
  "pak_list",
  {
    title: "List files inside UE .pak archives",
    description:
      "Parse UE .pak index files (AES-encrypted indexes supported, including games using custom bit-flipped AES) and list asset paths matching the filters. " +
      "Works without umodel. Use this before pak_extract to locate assets (meshes/textures/animations). " +
      "The pak directory should come from the user — ask which game directory to unpack first.",
    inputSchema: z.object({
      filters: z.array(z.string()).min(1).describe("Case-insensitive substrings to match, e.g. ['SKM_PC2']"),
      pakDir: z.string().optional().describe("Pak directory. Defaults to session gamePath."),
      pakFilter: z.string().optional().describe("Only scan paks whose file name contains this substring"),
      aesKey: z
        .string()
        .optional()
        .describe("AES key (hex, 0x prefix optional) for pak index decryption. Overrides session pakAesKey."),
      aesMode: z
        .enum(["standard", "bitflip"])
        .optional()
        .describe("Index decryption mode. Overrides session pakAesMode (default standard)."),
      limit: z.number().int().positive().optional().describe("Max entries to return (default 200)"),
      json: jsonFlag,
    }),
  },
  async ({ filters, pakDir, pakFilter, aesKey, aesMode, limit, json }) => {
    rememberDirectory(pakDir);
    if (aesKey) session.pakAesKey = aesKey;
    if (aesMode) session.pakAesMode = aesMode;
    const dir = pakDir ?? session.gamePath;
    const key: PakKey = { keyHex: aesKey ?? session.pakAesKey, mode: aesMode ?? session.pakAesMode ?? "standard" };
    if (!dir) return errorText("No pak directory provided and no gamePath in session. Ask the user for the game/pak directory first.");
    const paks = listPakFiles(dir, pakFilter);
    if (paks.length === 0) return errorText(`No .pak files found in ${dir}`);
    const cap = limit ?? 200;
    const matches: { pak: string; path: string; size: number }[] = [];
    const { scanned, errors } = scanPakIndexes(paks, key, (_pakPath, index) => {
      for (const e of index.entries) {
        if (matches.length >= cap) return false;
        const lower = e.path.toLowerCase();
        if (filters.some((f) => lower.includes(f.toLowerCase()))) {
          matches.push({ pak: e.pak, path: e.path, size: e.size });
        }
      }
      return matches.length < cap;
    });
    if (json)
      return respond(
        JSON.stringify(
          { directory: dir, scanned, totalPaks: paks.length, filters, truncated: matches.length >= cap, matches, errors },
          null,
          2,
        ),
        matches.length > 0,
      );
    if (matches.length === 0) {
      let msg = `Scanned ${scanned}/${paks.length} pak(s) in ${dir}; no entries match [${filters.join(", ")}]`;
      if (errors.length) msg += `\n\nErrors (first 10):\n${errors.slice(0, 10).join("\n")}`;
      return errorText(msg);
    }
    let msg =
      `Scanned ${scanned}/${paks.length} pak(s) in ${dir}\nEntries matching [${filters.join(", ")}]:\n` +
      matches.map((m) => `${m.pak} :: ${m.path}  (${m.size} bytes)`).join("\n") +
      (matches.length >= cap ? "\n...(truncated)" : "");
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
      "Works without umodel. The extracted loose files can then be converted with umodel_export (point it at the output directory). " +
      "Output defaults to <outputDir>/pak under the Downloads folder.",
    inputSchema: z.object({
      filters: z.array(z.string()).min(1).describe("Case-insensitive substrings to match, e.g. ['SKM_PC2']"),
      pakDir: z.string().optional().describe("Pak directory. Defaults to session gamePath."),
      out: z.string().optional().describe("Output directory. Defaults to <session outputDir>/pak."),
      pakFilter: z.string().optional().describe("Only scan paks whose file name contains this substring"),
      aesKey: z
        .string()
        .optional()
        .describe("AES key (hex, 0x prefix optional) for pak index decryption. Overrides session pakAesKey."),
      aesMode: z
        .enum(["standard", "bitflip"])
        .optional()
        .describe("Decryption mode. Overrides session pakAesMode (default standard)."),
      maxFiles: z.number().int().positive().optional().describe("Max files to extract (default 200)"),
      json: jsonFlag,
    }),
  },
  async ({ filters, pakDir, out, pakFilter, aesKey, aesMode, maxFiles, json }) => {
    rememberDirectory(pakDir);
    if (aesKey) session.pakAesKey = aesKey;
    if (aesMode) session.pakAesMode = aesMode;
    const dir = pakDir ?? session.gamePath;
    const outDir = out ?? path.join(resolveOutputDir(), "pak");
    const key: PakKey = { keyHex: aesKey ?? session.pakAesKey, mode: aesMode ?? session.pakAesMode ?? "standard" };
    if (!dir) return errorText("No pak directory provided and no gamePath in session. Ask the user for the game/pak directory first.");
    const paks = listPakFiles(dir, pakFilter);
    if (paks.length === 0) return errorText(`No .pak files found in ${dir}`);
    const cap = maxFiles ?? 200;
    const extracted: { path: string; size: number }[] = [];
    const warnings: string[] = [];
    scanPakIndexes(paks, key, (pakPath, index) => {
      for (const e of index.entries) {
        if (extracted.length >= cap) return false;
        const lower = e.path.toLowerCase();
        if (!filters.some((f) => lower.includes(f.toLowerCase()))) continue;
        if (!SUPPORTED_COMPRESSION.has(e.method.toLowerCase())) {
          warnings.push(`${e.path}: unsupported compression (${e.method}), skipped`);
          continue;
        }
        try {
          extractEntry(pakPath, e, outDir, key);
          extracted.push({ path: e.path, size: e.size });
        } catch (err) {
          warnings.push(`${e.path}: ${err}`);
        }
      }
      return extracted.length < cap;
    });
    if (json)
      return respond(
        JSON.stringify({ outDir, filters, truncated: extracted.length >= cap, extracted, warnings }, null, 2),
        extracted.length > 0,
      );
    let msg: string;
    if (extracted.length === 0) {
      msg = `No files matching [${filters.join(", ")}] were extracted.`;
      if (warnings.length) msg += `\n\nWarnings:\n` + warnings.slice(0, 20).join("\n");
      return errorText(msg);
    }
    msg =
      `Extracted ${extracted.length} file(s) to ${outDir}:\n` +
      extracted.map((e) => `${e.path}  (${e.size} bytes)`).join("\n");
    msg += `\n\n--- Output tree ---\n${listTree(outDir, { maxEntries: 100 })}`;
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
      directory: z.string().optional().describe("Directory to inspect. Defaults to session outputDir."),
      maxDepth: z.number().int().positive().optional().describe("Max folder depth to expand (default 8)"),
      maxEntries: z.number().int().positive().optional().describe("Max entries to show (default 400)"),
    }),
  },
  async ({ directory, maxDepth, maxEntries }) => {
    const dir = directory ?? resolveOutputDir();
    if (!fs.existsSync(dir)) return errorText(`Directory does not exist: ${dir}`);
    return text(listTree(dir, { maxDepth, maxEntries }));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
