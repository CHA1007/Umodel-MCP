# Umodel-MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/CHA1007/Umodel-MCP/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-CHA1007%2FUmodel--MCP-black?logo=github)](https://github.com/CHA1007/Umodel-MCP)

**English** | [简体中文](README.zh-CN.md)

An MCP server for [umodel](https://www.gildor.org/en/projects/umodel) that lets any MCP client
**list, extract, and export** Unreal Engine game assets through natural language.

## Features

- **Zero-dependency extraction**: `pak_list` / `pak_extract` are pure TypeScript implementations
  that parse the .pak index directly and extract raw `.uasset/.uexp` files — no umodel download required
- **Encrypted pak support**: AES-256 index/entry encryption, including the standard mode and the
  bitflip variant; keys are held in session memory only
- **Full export pipeline**: meshes, textures, animations, and sounds are exported to gltf, psk,
  png, dds, and other formats (requires the umodel executable)

## Requirements

- Node.js 18 or later
- Any MCP-capable client (Hermes, Claude Code, Cursor, PI, Codex, etc.)
- Only needed for export/conversion: [umodel](https://www.gildor.org/en/projects/umodel)

## Installation

### Standard config

```json
{
  "mcpServers": {
    "umodel": {
      "command": "npx",
      "args": ["-y", "umodel-mcp"]
    }
  }
}
```

You can also just tell your agent: "Install and register umodel-mcp, reload the MCP connection, and verify it works."

<details>
<summary>Claude Code / Codex (one-line CLI)</summary>

```bash
claude mcp add umodel npx -- -y umodel-mcp
```

```bash
codex mcp add umodel npx "-y" "umodel-mcp"
```

</details>

<details>
<summary>Run from source</summary>

```bash
git clone git@github.com:CHA1007/Umodel-MCP.git
cd Umodel-MCP
npm install
npm run build
```

Then register it in your MCP client config:

```json
{
  "mcpServers": {
    "umodel": {
      "command": "node",
      "args": ["<absolute path to this repo>/dist/index.js"]
    }
  }
}
```

</details>

## Tools

| Tool | umodel command | Description |
|------|----------------|-------------|
| `umodel_session_get` | — | Show the current in-memory session settings |
| `umodel_session_set` | — | Remember session settings (in memory only, nothing written to disk) |
| `umodel_find_exe` | — | Auto-search for the umodel executable (fallback only, when the user does not know the path) |
| `umodel_version` | `-version` | Verify the executable (pass `exe` to test and remember a new path) |
| `umodel_game_list` | `-gamelist` / `-taglist` | List supported games and their `-game=` tags |
| `umodel_list_packages` | — | Recursively scan a directory for `.pak/.upk/.uasset/.ut2` package files |
| `umodel_list_objects` | `-list` | List objects in a package (filtering and pagination supported) |
| `umodel_package_info` | `-pkginfo` | Show package info (name/export tables) |
| `umodel_export` | `-export` | Export meshes/textures/animations/sounds (psk, gltf, png, dds…) |
| `umodel_save` | `-save` | Copy raw package files out as-is (.upk + .uexp/.ubulk) |
| `umodel_list_output` | — | Show the exported directory tree (with file sizes) |
| `pak_list` | — | Parse the .pak index directly (no umodel), AES-encrypted indexes supported, search asset paths |
| `pak_extract` | — | Extract raw .uasset/.uexp files from a .pak (encrypted paks supported) |

Command-line arguments follow the official UEViewer source (`UmodelTool/Main.cpp`);
each tool's parameters can be inspected via its schema in your MCP client.

## Disclaimer

- This project is intended only for unpacking, viewing, and exporting game assets that
  **the user legally owns**, for learning, research, backup, and other lawful purposes
- Please comply with the user agreement of the game in question and the laws and regulations
  of your jurisdiction; the author assumes no responsibility for any copyright or agreement
  disputes or damages arising from the use of this project

## License

[MIT](LICENSE) © CHA1007
