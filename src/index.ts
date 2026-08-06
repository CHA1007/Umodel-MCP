#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultOutputDir, findUmodelExes, resolveOutputDir, session } from "./session.js";
import { commonArgs, formatResult, runUmodel } from "./umodel.js";
import { listTree } from "./tree.js";
import { detectPakEncryption, extractEntry, listPakFiles, parsePakIndex } from "./pak.js";

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
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
    return text(`会话已更新：\n${JSON.stringify(session, null, 2)}`);
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
        "未找到 umodel 可执行文件。请让用户从 https://www.gildor.org/en/projects/umodel 下载 UE Viewer，" +
          "解压后提供 umodel_64.exe 的完整路径。",
      );
    }
    if (json) return text(JSON.stringify({ candidates }, null, 2));
    let msg =
      `找到 ${candidates.length} 个候选 umodel 可执行文件（按修改时间倒序）：\n` +
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
          msg += `\n\n已验证并记住: ${top.path}\n${r.stdout.trim()}`;
          if (candidates.length > 1) {
            msg +=
              `\n\n注意：机器上存在 ${candidates.length} 个 umodel 候选，当前记住的只是最新一个，处于未确认状态。` +
              `不同 umodel 版本支持的游戏不同，请把候选列表展示给用户，询问目标游戏应使用哪个版本，` +
              `然后用 umodel_session_set { umodelExe } 确认；否则面向游戏的工具会拒绝执行。`;
          }
          return text(msg);
        }
        return errorText(msg + `\n\n验证失败（${top.path}），退出码: ${r.exitCode}\n${r.stderr.trim()}`);
      } catch (e) {
        return errorText(msg + `\n\n验证失败（${top.path}）: ${e}`);
      }
    } else {
      msg += "\n\n确认候选后调用 umodel_session_set 记住，或带 verify=true 重新调用以自动验证。";
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
    `检测到加密 pak，但未提供 AES key：${[...bad].join(", ")}。\n` +
    `此时直接调用 umodel 会弹出“输入 AES key”的 GUI 弹窗并卡住，已阻止执行。\n` +
    `请先向用户询问 AES key，然后用 umodel_session_set { aesKeys: ["0x..."] } 记住或传入 aesKeys 参数；` +
    `若 umodel 不支持该游戏，可改用 pak_list/pak_extract（配合 pakAesKey）。`
  );
}

function preflightExe(): string | null {
  if (!session.umodelExe || session.umodelExeConfirmed) return null;
  return (
    `当前 umodel 可执行文件 ${session.umodelExe} 是自动发现/验证的，未经用户确认。` +
    `不同 umodel 构建/版本支持的游戏不同，用错版本会导致解析失败或导出错误，已阻止执行。\n` +
    `请调用 umodel_find_exe 获取候选列表并展示给用户，询问目标游戏应使用哪个 umodel 版本，` +
    `然后用 umodel_session_set { umodelExe } 记住用户确认的路径。`
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
        index = parsePakIndex(p, session.pakAesKey, session.pakAesMode ?? "standard");
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
        `检测到 cooked（无版本号）UE 包，但未设置 gameTag：直接调用 umodel 会弹出“Unreal engine 4 version”GUI 弹窗并卡住，已阻止执行。\n` +
        `请按以下顺序处理：\n` +
        `1. 调用 umodel_game_list { tags: true } 查看该游戏是否有官方支持标签（例如 Roco Kingdom: World → gameTag=roco）；\n` +
        `2. 若支持，传入 gameTag 参数或用 umodel_session_set { gameTag } 记住；\n` +
        `3. 若不支持，向用户询问游戏所用的 Unreal Engine 版本，使用对应标签（如 ue4.27）。`
      );
    }
  }
  return null;
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
        `\n\n已记住可执行文件: ${exe}（未确认状态）。` +
        `若该路径是用户提供的，请调用 umodel_session_set { umodelExe } 确认后再执行面向游戏的工具。`;
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
    const dir = directory ?? session.gamePath;
    if (!dir) return errorText("未提供目录且会话中也没有 gamePath。请先向用户询问游戏/pak 目录。");
    if (!fs.existsSync(dir)) return errorText(`目录不存在: ${dir}`);
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

    if (found.length === 0) return errorText(`在 ${dir} 下未找到任何包文件`);
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
      `在 ${dir} 下找到 ${found.length}${found.length >= cap ? "+" : ""} 个包文件：\n` +
      found.join("\n");
    if (encrypted.length > 0) {
      msg +=
        `\n\n⚠ 加密 pak（需要 AES key，否则 umodel 会弹窗卡死）：\n` +
        encrypted.map((e) => `${e.pak} (索引${e.index ? "" : "未"}加密, 条目${e.entries ? "" : "未"}加密)`).join("\n");
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
    const aesErr = preflightAes(pkg, rest.gamePath, rest.aesKeys);
    if (aesErr) return errorText(aesErr);
    const tagErr = preflightGameTag(pkg, rest.gamePath, rest.gameTag);
    if (tagErr) return errorText(tagErr);
    const exeErr = preflightExe();
    if (exeErr) return errorText(exeErr);
    const args = ["-list", ...commonArgs(rest, session), pkg];
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
      let msg = `$ ${r.command}\n退出码: ${r.exitCode}${r.timedOut ? "（超时）" : ""}`;
      msg += `\n匹配 ${total} 行，本次返回 ${lines.length} 行：\n${lines.join("\n")}`;
      if (r.stderr.trim()) msg += `\n--- 标准错误 ---\n${r.stderr}`;
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
    const aesErr = preflightAes(pkg, rest.gamePath, rest.aesKeys);
    if (aesErr) return errorText(aesErr);
    const tagErr = preflightGameTag(pkg, rest.gamePath, rest.gameTag);
    if (tagErr) return errorText(tagErr);
    const exeErr = preflightExe();
    if (exeErr) return errorText(exeErr);
    const args = ["-pkginfo", ...commonArgs(rest, session), pkg];
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
    const aesErr = preflightAes(pkg, opts.gamePath, opts.aesKeys);
    if (aesErr) return errorText(aesErr);
    const tagErr = preflightGameTag(pkg, opts.gamePath, opts.gameTag);
    if (tagErr) return errorText(tagErr);
    const exeErr = preflightExe();
    if (exeErr) return errorText(exeErr);
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
    args.push(...commonArgs(opts, session));
    for (const o of opts.objects ?? []) args.push(`-obj=${o}`);
    args.push(pkg);
    if (opts.object) args.push(opts.object);
    if (opts.className) args.push(opts.className);
    const r = await runUmodel(session.umodelExe, args, timeoutMs);
    const ok = r.exitCode === 0;
    if (json) return respond(JSON.stringify({ ...r, out }, null, 2), ok);
    let msg = formatResult(r);
    if (ok && out) {
      msg += `\n\n文件已导出到: ${out}`;
      msg += `\n\n--- 输出结构 ---\n${listTree(out, { maxEntries: 100 })}`;
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
    const aesErr = preflightAes(pkg, opts.gamePath, opts.aesKeys);
    if (aesErr) return errorText(aesErr);
    const tagErr = preflightGameTag(pkg, opts.gamePath, opts.gameTag);
    if (tagErr) return errorText(tagErr);
    const exeErr = preflightExe();
    if (exeErr) return errorText(exeErr);
    const out = opts.out ?? resolveOutputDir();
    const args = ["-save", `-out=${out}`, ...commonArgs(opts, session), pkg];
    const r = await runUmodel(session.umodelExe, args, timeoutMs);
    const ok = r.exitCode === 0;
    if (json) return respond(JSON.stringify({ ...r, out }, null, 2), ok);
    let msg = formatResult(r);
    if (ok) {
      msg += `\n\n包文件已保存到: ${out}`;
      msg += `\n\n--- 输出结构 ---\n${listTree(out, { maxEntries: 100 })}`;
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
    const dir = pakDir ?? session.gamePath;
    const key = aesKey ?? session.pakAesKey;
    const mode = aesMode ?? session.pakAesMode ?? "standard";
    if (!dir) return errorText("未提供 pak 目录且会话中也没有 gamePath。请先向用户询问游戏/pak 目录。");
    const paks = listPakFiles(dir, pakFilter);
    if (paks.length === 0) return errorText(`在 ${dir} 中未找到 .pak 文件`);
    const cap = limit ?? 200;
    const matches: { pak: string; path: string; size: number }[] = [];
    const errors: string[] = [];
    let scanned = 0;
    for (const p of paks) {
      if (matches.length >= cap) break;
      let index;
      try {
        index = parsePakIndex(p, key, mode);
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
      return respond(
        JSON.stringify(
          { directory: dir, scanned, totalPaks: paks.length, filters, truncated: matches.length >= cap, matches, errors },
          null,
          2,
        ),
        matches.length > 0,
      );
    if (matches.length === 0) {
      let msg = `扫描了 ${dir} 中 ${scanned}/${paks.length} 个 pak，未找到匹配 [${filters.join(", ")}] 的条目`;
      if (errors.length) msg += `\n\n错误（前 10 条）:\n${errors.slice(0, 10).join("\n")}`;
      return errorText(msg);
    }
    let msg =
      `扫描了 ${dir} 中 ${scanned}/${paks.length} 个 pak\n匹配 [${filters.join(", ")}] 的条目：\n` +
      matches.map((m) => `${m.pak} :: ${m.path}  (${m.size} bytes)`).join("\n") +
      (matches.length >= cap ? "\n...（已截断）" : "");
    if (errors.length) msg += `\n\n错误:\n${errors.slice(0, 10).join("\n")}`;
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
    const dir = pakDir ?? session.gamePath;
    const outDir = out ?? path.join(resolveOutputDir(), "pak");
    const key = aesKey ?? session.pakAesKey;
    const mode = aesMode ?? session.pakAesMode ?? "standard";
    if (!dir) return errorText("未提供 pak 目录且会话中也没有 gamePath。请先向用户询问游戏/pak 目录。");
    const paks = listPakFiles(dir, pakFilter);
    if (paks.length === 0) return errorText(`在 ${dir} 中未找到 .pak 文件`);
    const cap = maxFiles ?? 200;
    const extracted: { path: string; size: number }[] = [];
    const warnings: string[] = [];
    for (const p of paks) {
      if (extracted.length >= cap) break;
      let index;
      try {
        index = parsePakIndex(p, key, mode);
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
          extractEntry(p, e, outDir, key, mode);
          extracted.push({ path: e.path, size: e.size });
        } catch (err) {
          warnings.push(`${e.path}: ${err}`);
        }
      }
    }
    if (json)
      return respond(
        JSON.stringify({ outDir, filters, truncated: extracted.length >= cap, extracted, warnings }, null, 2),
        extracted.length > 0,
      );
    let msg: string;
    if (extracted.length === 0) {
      msg = `未提取到任何匹配 [${filters.join(", ")}] 的文件。`;
      if (warnings.length) msg += `\n\n警告:\n` + warnings.slice(0, 20).join("\n");
      return errorText(msg);
    }
    msg =
      `已提取 ${extracted.length} 个文件到 ${outDir}：\n` +
      extracted.map((e) => `${e.path}  (${e.size} bytes)`).join("\n");
    msg += `\n\n--- 输出结构 ---\n${listTree(outDir, { maxEntries: 100 })}`;
    if (warnings.length) msg += `\n\n警告:\n` + warnings.slice(0, 20).join("\n");
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
    if (!fs.existsSync(dir)) return errorText(`目录不存在: ${dir}`);
    return text(listTree(dir, { maxDepth, maxEntries }));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
