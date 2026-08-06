# Umodel-MCP

面向 [umodel（UE Viewer）](https://www.gildor.org/en/projects/umodel) 的 MCP 服务器，
让任意 MCP 客户端可以通过自然语言完成 Unreal Engine 游戏资源的**列表、解包、导出**操作

其中 `pak_list` / `pak_extract` 为纯 TypeScript 实现，直接解析 .pak（支持 AES 加密，
含 bitflip 变体），**无需下载 umodel**；其余导出转换类工具需要 umodel 可执行文件

## 安装

**方式一：npx 手动注册** —— 在 MCP 客户端配置中直接写：

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

**方式二：从源码运行** —— 克隆本仓库后：

```bash
npm install
npm run build
```

然后在配置中注册：

```json
{
  "mcpServers": {
    "umodel": {
      "command": "node",
      "args": ["<本仓库绝对路径>/dist/index.js"]
    }
  }
}
```

要求 Node.js ≥ 18无需任何配置文件或环境变量，
改完配置后重启客户端或重新加载 MCP 连接即可

## 工具（13 个）

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

命令行参数以 UEViewer 官方源码（`UmodelTool/Main.cpp`）为准；
每个工具的具体参数可在 MCP 客户端中查看其 schema

## 免责声明

- 本项目仅用于解包、查看与导出**用户自己合法持有的**游戏资源，
  用于学习、研究、备份等合法用途
- 请遵守相关游戏的用户协议与所在地区的法律法规；
  因使用本项目产生的任何版权、协议纠纷或损失，作者概不负责
- AES 密钥等敏感信息仅保存在会话内存中，不会写入任何文件
