# MCP 使用说明

## 用页屿调用 MCP

从「视图 → 协作侧栏 → MCP 工具与连接」打开 MCP 面板并添加服务器。stdio 配置由命令和独立参数组成，点击连接后启动本地进程。Streamable HTTP 配置使用目标服务的 `/mcp` 地址。服务支持的工具、资源与提示词会显示在连接卡中。打开能力卡、填写参数、核对预览并勾选授权后执行。

局域网外的 URL 使用 HTTPS，本机 `127.0.0.1` 或 `localhost` 支持 HTTP。当前 HTTP 配置适用于无需额外用户凭据的端点。

## 用客户端访问页屿

打开要访问的文件夹，在 MCP 侧栏授权并复制生成的配置。Codex 的 TOML 格式可用以下模板，使用界面给出的真实路径替换占位值。

```toml
[mcp_servers.yeyu]
command = "/path/to/yeyu"
args = ["--mcp", "--workspace", "/path/to/notes", "--state-dir", "/path/to/yeyu-app-data"]
```

支持 JSON MCP 配置的客户端可以粘贴面板里的 `mcpServers.yeyu` 项。Windows 可以使用 `.exe` 完整路径。

| 工具 | 参数 | 结果 |
|---|---|---|
| `search_documents` | `query`，可选 `regex` | 工作区内 Markdown 的命中路径、行与摘要 |
| `read_document` | `path` | 磁盘上的正文、版本和 BOM 状态 |
| `current_selection` | 无 | 页屿当前文档的选中文字与 UTF-16 位置 |
| `suggest_edit` | `path`、`version`、`from`、`to`、`replacement`、`summary` | 建议编号与待审状态 |

修改区间使用 `read_document` 返回的 `text` 中的 UTF-16 偏移。位置包含换行，BOM 独立返回。例如完整替换开头三个字符时，可以使用 `from=0`、`to=3`。提交前应按当前版本核对原文。工作区撤销授权后，已启动的 stdio 服务也会拒绝新的工作区请求。

页屿的 MCP 侧栏显示待审条数。打开建议后选择差异块并应用，正文先进入普通编辑缓冲区。用保存写入磁盘，或在自动保存启用时等待写入。
