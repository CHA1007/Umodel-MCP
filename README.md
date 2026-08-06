# Umodel-MCP

面向 [umodel（UE Viewer）](https://www.gildor.org/en/projects/umodel) 的 MCP 服务器，
让 Pi / 任意 MCP 客户端可以通过自然语言完成 Unreal Engine 游戏资源的**列表、解包、导出**操作。

## 功能（9 个工具）

| 工具 | 对应 umodel 命令 | 说明 |
|------|------------------|------|
| `umodel_version` | `-version` | 验证可执行文件可用 |
| `umodel_config_get` / `umodel_config_set` | — | 读取/持久化配置 |
| `umodel_game_list` | `-gamelist` / `-taglist` | 查看支持的游戏及 `-game=` 标签 |
| `umodel_list_packages` | — | 递归扫描目录中的 `.pak/.upk/.uasset/.ut2` 等包文件 |
| `umodel_list_objects` | `-list` | 列出包内对象 |
| `umodel_package_info` | `-pkginfo` | 查看包信息（name/export 表） |
| `umodel_export` | `-export` | 导出网格/贴图/动画/声音（psk、gltf、png、dds…） |
| `umodel_save` | `-save` | 原样拷出原始包文件（.upk + .uexp/.ubulk） |

## 安装与构建

```bash
npm install
npm run build
```

## 配置

服务器按以下顺序查找配置文件（第一个存在的生效）：

1. 环境变量 `UMODEL_MCP_CONFIG` 指定的路径
2. 当前目录 `umodel-mcp.json`
3. `~/.umodel-mcp/config.json`

配置字段（均可被同名环境变量覆盖）：

```json
{
  "umodelExe": "C:/path/to/umodel_64.exe",
  "gamePath": "D:/Games/SomeGame/Content/Paks",
  "gameTag": "ue4.27",
  "aesKeys": ["0xAAAAAAAA..."],
  "outputDir": "C:/export",
  "defaultArgs": [],
  "timeoutMs": 300000
}
```

环境变量：`UMODEL_EXE`、`UMODEL_GAME_PATH`、`UMODEL_GAME_TAG`、
`UMODEL_AES_KEY`（逗号分隔多个）、`UMODEL_OUTPUT_DIR`、`UMODEL_TIMEOUT_MS`。

## 在 Pi 中注册

`~/.config/mcp/mcp.json`（或项目 `.mcp.json`）：

```json
{
  "mcpServers": {
    "umodel": {
      "command": "node",
      "args": ["C:/Users/Administrator/Documents/Project/Umodel-MCP/dist/index.js"],
      "env": {
        "UMODEL_MCP_CONFIG": "C:/Users/Administrator/Documents/Project/Umodel-MCP/umodel-mcp.json"
      }
    }
  }
}
```

改完配置后在 Pi 中执行 `/reload`（或重启 Pi）。之后即可直接说：

> “列出 D:/Games/XX/Content/Paks 里的包文件，然后把 pak0 里的所有贴图导出成 png。”

## 常用示例

```text
umodel_list_packages { directory: "D:/Game/Content/Paks" }
umodel_game_list     { tags: true }                 # 查看可用 -game= 标签
umodel_list_objects  { package: "pakchunk0.pak", gameTag: "ue4.27", aesKeys: ["0x..."] }
umodel_export        { package: "pakchunk0", textureFormat: "png", sounds: true, out: "C:/export" }
umodel_save          { package: "*", out: "C:/raw" } # 原样解包
```

## 说明

- 命令行参数以 UEViewer 官方源码（`UmodelTool/Main.cpp`）为准。
- 加密 pak 需要通过 `aesKeys`（或 umodel-mcp.json）提供 AES key。
- 导出结果默认写入 `outputDir`，工具返回中会包含实际执行的完整命令行，便于排查。
