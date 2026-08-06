# Umodel-MCP

面向 [umodel（UE Viewer）](https://www.gildor.org/en/projects/umodel) 的 MCP 服务器，
让 Pi / 任意 MCP 客户端可以通过自然语言完成 Unreal Engine 游戏资源的**列表、解包、导出**操作。

## 设计理念

**没有配置文件**。所有设置由 agent 在会话中确认：

1. **先问用户**：umodel 可执行文件路径、游戏/pak 目录，必须来自用户；
   agent 不应自行猜测或搜索。
2. **兜底自查**：用户不知道路径或给错时，才用 `umodel_find_exe` 自动搜索常见位置。
3. **会话记忆**：确认后的值通过 `umodel_session_set` 存入服务器内存，
   本次会话内后续工具调用自动复用；不写任何文件，进程重启即清空。
4. **导出目录**：默认写到 `~/Downloads/umodel-export`（pak 提取写到其下 `pak/` 子目录），
   无需用户提供。

## 功能（13 个工具）

| 工具 | 对应 umodel 命令 | 说明 |
|------|------------------|------|
| `umodel_session_get` | — | 查看当前内存会话设置 |
| `umodel_session_set` | — | 记住会话设置（仅内存，不落盘） |
| `umodel_find_exe` | — | 自动搜索 umodel 可执行文件（仅当用户不知道路径时兜底） |
| `umodel_version` | `-version` | 验证可执行文件（可传 `exe` 测试并记住新路径） |
| `umodel_game_list` | `-gamelist` / `-taglist` | 查看支持的游戏及 `-game=` 标签 |
| `umodel_list_packages` | — | 递归扫描目录中的 `.pak/.upk/.uasset/.ut2` 等包文件 |
| `umodel_list_objects` | `-list` | 列出包内对象（支持过滤与分页） |
| `umodel_package_info` | `-pkginfo` | 查看包信息（name/export 表） |
| `umodel_export` | `-export` | 导出网格/贴图/动画/声音（psk、gltf、png、dds…） |
| `umodel_save` | `-save` | 原样拷出原始包文件（.upk + .uexp/.ubulk） |
| `umodel_list_output` | — | 查看导出结果目录树（含文件大小） |
| `pak_list` | — | 直接解析 .pak 索引（不经 umodel），支持 AES 加密索引，搜索资产路径 |
| `pak_extract` | — | 从 .pak 中提取原始 .uasset/.uexp 文件（含加密 pak） |

## 安装与构建

```bash
npm install
npm run build
```

## 在 Pi 中注册

`~/.config/mcp/mcp.json`（或项目 `.mcp.json`）：

```json
{
  "mcpServers": {
    "umodel": {
      "command": "node",
      "args": ["C:/Users/Administrator/Documents/Project/Umodel-MCP/dist/index.js"]
    }
  }
}
```

无需任何配置文件或环境变量。改完配置后在 Pi 中执行 `/reload`（或重启 Pi）。

## 典型会话流程

```text
用户："帮我解包 XX 游戏的资源"
agent：询问 umodel_64.exe 路径和游戏目录
agent：umodel_session_set { umodelExe: "...", gamePath: "..." }
agent：umodel_version            # 验证 exe 可用
agent：umodel_list_packages      # 扫描包文件，向用户确认要解什么
agent：umodel_export / pak_extract ...
```

用户不知道 umodel 装在哪时：

```text
umodel_find_exe { verify: true }   # 搜索 Downloads/Desktop/Program Files/PATH，验证并记住最新的一个
umodel_find_exe { dirs: ["D:/Tools"], verify: true }   # 用户隐约记得在某目录，可指定深搜
```

## 常用示例

```text
umodel_list_packages { directory: "D:/Game/Content/Paks" }
umodel_game_list     { tags: true }                 # 查看可用 -game= 标签
umodel_list_objects  { package: "pakchunk0.pak", gameTag: "ue4.27", aesKeys: ["0x..."] }
umodel_export        { package: "pakchunk0", textureFormat: "png", sounds: true }
umodel_save          { package: "*", out: "C:/raw" } # 原样解包
umodel_list_output   {}                              # 查看导出结果（默认输出目录）

# pak_* 工作流：先搜索再提取，提取出的散文件可再交给 umodel_export 转换
pak_list     { filters: ["SKM_PC2"] }
pak_extract  { filters: ["SKM_PC2"] }
```

## 说明

- 命令行参数以 UEViewer 官方源码（`UmodelTool/Main.cpp`）为准。
- 加密 pak 需要提供 AES key：umodel 工具用 `aesKeys` 参数或会话字段，
  `pak_*` 工具用 `pakAesKey` 会话字段（十六进制，`0x` 前缀可选）。
- 导出结果默认写入 `~/Downloads/umodel-export`，工具返回中会包含实际执行的
  完整命令行，便于排查。
- 列表/导出类工具均支持 `json: true` 参数，返回结构化 JSON 供程序消费；
  `umodel_list_objects` 另支持 `filter`（行级子串过滤）与 `skip`/`limit`（分页），
  适合在超大包里定位对象。

## 加密 pak 支持（pak_list / pak_extract）

umodel 读不了的 pak（如索引被加密、或 umodel 尚未适配的游戏）可以用
`pak_list` / `pak_extract` 直接解析 UE4 pak 索引：

1. 游戏/pak 目录来自会话 `gamePath`（或单次调用传 `pakDir`）。
2. 索引加密的游戏还需 `umodel_session_set { pakAesKey: "0x..." }`。
3. `pakAesMode` 选择解密方式：
   - `standard`：标准 AES-256-ECB（默认）。
   - `bitflip`：部分游戏（如洛克王国：世界）的自定义变体，
     对密钥做字节序翻转、对密文块做位翻转后再走 AES。
   也可在单次调用时用 `aesMode` 参数临时覆盖。
4. `pak_list` 按子串过滤搜索包内资产路径；`pak_extract` 提取原始
   `.uasset/.uexp`，支持 None/Zlib/Gzip 压缩与条目级加密。
5. 提取出的散文件可把目录指给 `umodel_export` 继续转换为 gltf/png 等格式。

出于安全考虑，AES 密钥不做任何持久化，只存在于会话内存中。
