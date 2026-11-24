# 页屿插件接口 v1

在「编辑 → 插件管理」安装并启用[清理行尾空白插件](../examples/plugins/trim-lines.yeyu-plugin.json)，选中文本后运行命令。结果会进入已有的差异审阅，应用后可撤销。选择「当前全文」可处理整份文档。

新安装的插件默认停用。再次安装同一个插件 ID 会更新命令和代码，沿用原有启用状态。安装、切换和卸载即时生效。卸载移除页屿的安装副本。

## 打包

插件包是 UTF-8 JSON，扩展名为 `.yeyu-plugin.json`。清单包含 `apiVersion`（目前为 `1`）、`id`、`name`、`version`、`commands` 和 `wasm`。每条命令有 `id` 和 `label`，ID 对应 Wasm 导出函数名。 `wasm` 为二进制模块的标准 Base64。

| 导出 | 用法 |
| --- | --- |
| `memory` | 保存 UTF-8 输入和输出的线性内存 |
| `alloc(length: i32) -> i32` | 返回可写入 `length` 字节的地址 |
| `<命令 ID>(ptr: i32, length: i32) -> i64` | 返回输出地址和长度，高 32 位为地址，低 32 位为 UTF-8 字节数 |

页屿用独立的 Wasmi 实例运行每条命令，只传入用户指定的选区或全文。模块必须无导入。每次运行的输入与输出各最多 4 MiB，线性内存最多 32 MiB，插件包最多 2 MiB。停用、卸载或替换后，运行中的旧结果会被丢弃。

用带 Wasm 后端的 Clang 和 `wasm-ld` 可从[示例源码](../examples/plugins/trim-lines.c)重建模块。将最终 `.wasm` 的 Base64 写入清单的 `wasm` 字段。

```sh
clang --target=wasm32-unknown-unknown -ffreestanding -fno-builtin -O2 \
  -c examples/plugins/trim-lines.c -o trim-lines.o
wasm-ld --no-entry --export-memory --export=alloc --export=trim_lines \
  --strip-all trim-lines.o -o trim-lines.wasm
```

[Wasmi 源码与许可证](https://github.com/wasmi-labs/wasmi)
