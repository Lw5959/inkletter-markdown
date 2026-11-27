mod javascript;
pub mod market;

use crate::store::{Store, err};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
};
#[cfg(not(target_os = "android"))]
use std::{fs::File, io::Read};
use tauri::State;
use wasmi::{
    Config, Engine, ExternType, Linker, Module, Store as VmStore, StoreLimits, StoreLimitsBuilder,
    ValType,
};

const FILE: &str = "plugins.json";
const WASM_API_VERSION: u32 = 1;
const JS_API_VERSION: u32 = 2;
const DOCUMENT_TOOLS_API_VERSION: u32 = 3;
const MCP_CONFIG_API_VERSION: u32 = 4;
const MAX_PACKAGE: usize = 2 * 1024 * 1024;
const MAX_TEXT: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct Plugins(Mutex<()>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    api_version: u32,
    id: String,
    name: String,
    version: String,
    commands: Vec<Command>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wasm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    javascript: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Command {
    id: String,
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<CommandScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workflow: Option<CommandWorkflow>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CommandScope {
    Selection,
    Document,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CommandWorkflow {
    Files,
    Images,
    Mcp,
}

#[derive(Deserialize, Serialize)]
struct Installed {
    package: Package,
    revision: u64,
    enabled: bool,
}

#[derive(Default, Deserialize, Serialize)]
struct Registry {
    sequence: u64,
    entries: BTreeMap<String, Installed>,
}

#[derive(Serialize)]
pub struct PluginView {
    id: String,
    name: String,
    version: String,
    commands: Vec<Command>,
    enabled: bool,
}

impl Registry {
    fn view(&self) -> Vec<PluginView> {
        self.entries
            .values()
            .map(|entry| PluginView {
                id: entry.package.id.clone(),
                name: entry.package.name.clone(),
                version: entry.package.version.clone(),
                commands: entry.package.commands.clone(),
                enabled: entry.enabled,
            })
            .collect()
    }
}

fn identifier(value: &str, plugin: bool) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'_' || (plugin && matches!(byte, b'.' | b'-'))
        })
}

fn label(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 120 && !value.chars().any(char::is_control)
}

enum Program<'a> {
    Wasm(&'a str),
    JavaScript(&'a str),
}

fn supports_api(version: u32) -> bool {
    matches!(
        version,
        WASM_API_VERSION | JS_API_VERSION | DOCUMENT_TOOLS_API_VERSION
    ) || (version == MCP_CONFIG_API_VERSION && cfg!(not(target_os = "android")))
}

fn program(package: &Package) -> Result<Program<'_>, String> {
    if !supports_api(package.api_version) {
        return Err("当前平台不支持此插件接口".into());
    }
    let mut commands = BTreeSet::new();
    if !identifier(&package.id, true)
        || !label(&package.name)
        || !label(&package.version)
        || package.commands.is_empty()
        || package.commands.len() > 32
        || package.commands.iter().any(|command| {
            !identifier(&command.id, false)
                || !label(&command.label)
                || !commands.insert(&command.id)
        })
    {
        return Err("插件清单包含无效的身份或命令".into());
    }
    if package.commands.iter().any(|command| {
        let required = match command.workflow {
            Some(CommandWorkflow::Mcp) => MCP_CONFIG_API_VERSION,
            Some(CommandWorkflow::Files | CommandWorkflow::Images) => DOCUMENT_TOOLS_API_VERSION,
            None => WASM_API_VERSION,
        };
        package.api_version < required
    }) {
        return Err("插件工作流与接口版本不匹配".into());
    }
    match (
        package.api_version,
        package.wasm.as_deref(),
        package.javascript.as_deref(),
    ) {
        (
            WASM_API_VERSION | DOCUMENT_TOOLS_API_VERSION | MCP_CONFIG_API_VERSION,
            Some(wasm),
            None,
        ) if !wasm.is_empty() => Ok(Program::Wasm(wasm)),
        (
            JS_API_VERSION | DOCUMENT_TOOLS_API_VERSION | MCP_CONFIG_API_VERSION,
            None,
            Some(script),
        ) if !script.trim().is_empty() => Ok(Program::JavaScript(script)),
        _ => Err("插件清单须提供与接口版本匹配的单个 wasm 或 javascript 模块".into()),
    }
}

fn compile_wasm(package: &Package, wasm: &str) -> Result<(Engine, Module), String> {
    let mut config = Config::default();
    config.consume_fuel(true);
    let engine = Engine::new(&config);
    let wasm = STANDARD
        .decode(wasm)
        .map_err(|_| "插件的 WebAssembly 编码无效")?;
    let module =
        Module::new(&engine, wasm).map_err(|error| format!("无法加载 WebAssembly：{error}"))?;
    // 空链接器只允许模块内部运算，插件没有文件、网络与系统接口。
    if module.imports().next().is_some() {
        return Err("墨笺插件只能使用独立编译的 WebAssembly 模块".into());
    }
    let func = |name: &str, params: &[ValType], result: ValType| matches!(module.get_export(name), Some(ExternType::Func(ty)) if ty.params() == params && ty.results() == [result]);
    if !matches!(module.get_export("memory"), Some(ExternType::Memory(_)))
        || !func("alloc", &[ValType::I32], ValType::I32)
        || package
            .commands
            .iter()
            .any(|command| !func(&command.id, &[ValType::I32, ValType::I32], ValType::I64))
    {
        return Err("插件缺少声明的命令、分配函数或 WebAssembly 内存".into());
    }
    Ok((engine, module))
}

fn execute(package: &Package, command: &str, text: String) -> Result<String, String> {
    match program(package)? {
        Program::Wasm(wasm) => execute_wasm(package, wasm, command, text),
        Program::JavaScript(script) => javascript::execute(script, command, &text),
    }
}

fn execute_wasm(
    package: &Package,
    wasm: &str,
    command: &str,
    text: String,
) -> Result<String, String> {
    let (engine, module) = compile_wasm(package, wasm)?;
    let limits = StoreLimitsBuilder::new()
        .memory_size(32 * 1024 * 1024)
        .table_elements(1024)
        .memories(1)
        .tables(1)
        .instances(1)
        .build();
    let mut vm = VmStore::new(&engine, limits);
    vm.limiter(|limits: &mut StoreLimits| limits);
    vm.set_fuel(100_000_000).map_err(err)?;
    let result = (|| {
        let instance = Linker::new(&engine).instantiate_and_start(&mut vm, &module)?;
        let memory = instance
            .get_memory(&vm, "memory")
            .expect("已验证插件内存导出");
        let alloc = instance.get_typed_func::<i32, i32>(&vm, "alloc")?;
        let transform = instance.get_typed_func::<(i32, i32), i64>(&vm, command)?;
        let len = text.len() as i32;
        let ptr = alloc.call(&mut vm, len)?;
        memory.write(&mut vm, ptr as u32 as usize, text.as_bytes())?;
        transform
            .call(&mut vm, (ptr, len))
            .map(|packed| (memory, packed as u64))
    })()
    .map_err(|error| format!("插件执行失败：{error}"))?;
    let (memory, packed) = result;
    let offset = (packed >> 32) as usize;
    let length = packed as u32 as usize;
    if length > MAX_TEXT {
        return Err("插件结果超过 4 MiB".into());
    }
    let bytes = memory
        .data(&vm)
        .get(offset..offset.saturating_add(length))
        .ok_or("插件返回无效的文本位置")?;
    String::from_utf8(bytes.to_vec()).map_err(|_| "插件返回的内容不是 UTF-8 文本".into())
}

fn validate(package: &Package) -> Result<(), String> {
    match program(package)? {
        Program::Wasm(wasm) => compile_wasm(package, wasm).map(|_| ()),
        Program::JavaScript(script) => javascript::validate(script, &package.commands),
    }
}

#[tauri::command]
pub fn plugin_list(
    store: State<'_, Store>,
    plugins: State<'_, Plugins>,
) -> Result<Vec<PluginView>, String> {
    list(&store, &plugins)
}

fn list(store: &Store, plugins: &Plugins) -> Result<Vec<PluginView>, String> {
    let _lock = plugins.0.lock().map_err(err)?;
    Ok(store.read::<Registry>(FILE)?.view())
}

fn read_package(bytes: &[u8]) -> Result<Package, String> {
    if bytes.len() > MAX_PACKAGE {
        return Err("插件包超过 2 MiB".into());
    }
    serde_json::from_slice(bytes).map_err(|error| format!("无法读取插件清单：{error}"))
}

fn newer_than(version: &Version, current: &str) -> bool {
    Version::parse(current).is_ok_and(|installed| version.cmp_precedence(&installed).is_gt())
}

fn install(
    store: &Store,
    plugins: &Plugins,
    package: Package,
    market_version: Option<&Version>,
) -> Result<Vec<PluginView>, String> {
    validate(&package)?;
    let _lock = plugins.0.lock().map_err(err)?;
    let mut registry: Registry = store.read(FILE)?;
    let existing = registry.entries.get(&package.id);
    // 市场下载期间可能已经从另一入口安装，提交前按实际已安装版本重新判断。
    if let Some(version) = market_version
        && let Some(entry) = existing
        && !newer_than(version, &entry.package.version)
    {
        return Err("已经安装相同、更新或无法比较的版本，请刷新市场".into());
    }
    let enabled = existing.is_some_and(|entry| entry.enabled);
    registry.sequence = registry.sequence.wrapping_add(1);
    registry.entries.insert(
        package.id.clone(),
        Installed {
            package,
            enabled,
            revision: registry.sequence,
        },
    );
    store.write(FILE, &registry)?;
    Ok(registry.view())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn plugin_install(
    path: String,
    store: State<'_, Store>,
    plugins: State<'_, Plugins>,
) -> Result<Vec<PluginView>, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(err)?
        .take((MAX_PACKAGE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    install(&store, &plugins, read_package(&bytes)?, None)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn plugin_install_content(
    text: String,
    store: State<'_, Store>,
    plugins: State<'_, Plugins>,
) -> Result<Vec<PluginView>, String> {
    // 前端从 SAF 读出内容，原生层复用插件包校验和安装流程。
    install(&store, &plugins, read_package(text.as_bytes())?, None)
}

#[tauri::command]
pub fn plugin_set_enabled(
    id: String,
    enabled: bool,
    store: State<'_, Store>,
    plugins: State<'_, Plugins>,
) -> Result<Vec<PluginView>, String> {
    let _lock = plugins.0.lock().map_err(err)?;
    let mut registry: Registry = store.read(FILE)?;
    let entry = registry.entries.get_mut(&id).ok_or("插件已卸载")?;
    if entry.enabled != enabled {
        registry.sequence = registry.sequence.wrapping_add(1);
        entry.enabled = enabled;
        entry.revision = registry.sequence;
        store.write(FILE, &registry)?;
    }
    Ok(registry.view())
}

#[tauri::command]
pub fn plugin_remove(
    id: String,
    store: State<'_, Store>,
    plugins: State<'_, Plugins>,
) -> Result<Vec<PluginView>, String> {
    let _lock = plugins.0.lock().map_err(err)?;
    let mut registry: Registry = store.read(FILE)?;
    if registry.entries.remove(&id).is_some() {
        store.write(FILE, &registry)?;
    }
    Ok(registry.view())
}

#[tauri::command]
pub async fn plugin_run(
    id: String,
    command: String,
    text: String,
    store: State<'_, Store>,
    plugins: State<'_, Plugins>,
) -> Result<String, String> {
    if text.len() > MAX_TEXT {
        return Err("文字超过 4 MiB，请选择较小范围".into());
    }
    let entry = {
        let _lock = plugins.0.lock().map_err(err)?;
        let mut registry: Registry = store.read(FILE)?;
        registry
            .entries
            .remove(&id)
            .filter(|entry| entry.enabled)
            .ok_or("插件已停用或卸载")?
    };
    if !entry.package.commands.iter().any(|item| item.id == command) {
        return Err("插件未提供此命令".into());
    }
    let revision = entry.revision;
    let result =
        tauri::async_runtime::spawn_blocking(move || execute(&entry.package, &command, text))
            .await
            .map_err(err)??;
    let _lock = plugins.0.lock().map_err(err)?;
    let registry: Registry = store.read(FILE)?;
    // 若运行期间插件被替换或停用，旧结果不能进入文档审阅。
    if !registry
        .entries
        .get(&id)
        .is_some_and(|entry| entry.enabled && entry.revision == revision)
    {
        return Err("插件已停用或更新，请重新运行命令".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_plugin_transforms_text_without_rewriting_line_endings() {
        let manifest = include_str!("../../examples/plugins/trim-lines.yeyu-plugin.json");
        let mut package: Package = serde_json::from_str(manifest).unwrap();
        let output = execute(&package, "trim_lines", "首行  \r\n二行\t\r末尾  ".into()).unwrap();
        assert_eq!(output, "首行\r\n二行\r末尾");
        package.commands[0].id = "missing".into();
        assert!(validate(&package).is_err());
    }

    #[test]
    fn rust_plugin_formats_a_document_on_a_worker_stack() {
        let result = std::thread::Builder::new()
            .stack_size(1024 * 1024)
            .spawn(|| {
                let package = read_package(include_bytes!(
                    "../../examples/plugins/trim-lines.yeyu-plugin.json"
                ))?;
                let text = "段落保留原有换行  \r\n".repeat(128);
                execute(&package, "trim_lines", text)
            })
            .unwrap()
            .join()
            .unwrap()
            .unwrap();
        assert_eq!(result, "段落保留原有换行\r\n".repeat(128));
    }

    #[test]
    fn spreadsheet_cells_round_trip_through_the_bundled_javascript_module() {
        let package = read_package(include_bytes!(
            "../../examples/plugins/spreadsheet-tools.yeyu-plugin.json"
        ))
        .unwrap();
        let csv = "名称,备注,数字\r\n页屿,\"空格 | 与, \"\"引号\"\"\r\n和换行\",\r\n";
        let table = execute(&package, "csv_to_markdown", csv.into()).unwrap();
        assert!(table.contains("| --- | --- | --- |\r\n"));
        assert!(table.contains("空格 \\| 与, \"引号\"&#13;&#10;和换行 |  |"));
        assert_eq!(execute(&package, "markdown_to_csv", table).unwrap(), csv);
        let tsv = "名称\t备注\r\n页屿\t\"含\t制表符\"";
        assert_eq!(
            execute(&package, "tsv_to_markdown", tsv.into()).unwrap(),
            "| 名称 | 备注 |\r\n| --- | --- |\r\n| 页屿 | 含&#9;制表符 |"
        );
        let invalid = "a,b\na,\"没有结束";
        assert_eq!(
            execute(&package, "csv_to_markdown", invalid.into()).unwrap(),
            invalid
        );
    }

    #[test]
    fn task_list_preserves_markdown_structure_and_line_endings() {
        let package = read_package(include_bytes!(
            "../../examples/plugins/task-list.yeyu-plugin.json"
        ))
        .unwrap();
        let input = "写样稿\r\n- 看差异\r  2. [X] 通过\n# 标题\n```md\n- [ ] 假任务\n```\n";
        let made = execute(&package, "make_tasks", input.into()).unwrap();
        assert_eq!(
            made,
            "- [ ] 写样稿\r\n- [ ] 看差异\r  2. [X] 通过\n# 标题\n```md\n- [ ] 假任务\n```\n"
        );
        let completed = execute(&package, "complete_tasks", made).unwrap();
        assert_eq!(
            completed,
            "- [x] 写样稿\r\n- [x] 看差异\r  2. [x] 通过\n# 标题\n```md\n- [ ] 假任务\n```\n"
        );
        let reset = execute(&package, "reset_tasks", completed).unwrap();
        assert!(reset.starts_with("- [ ] 写样稿\r\n- [ ] 看差异\r  2. [ ] 通过\n"));
    }

    #[test]
    fn headings_leave_yaml_code_and_level_boundaries_alone() {
        let package = read_package(include_bytes!(
            "../../examples/plugins/heading-levels.yeyu-plugin.json"
        ))
        .unwrap();
        let untouched =
            "---\r\n# YAML comment\r\n---\r\n```md\r\n## code\r\n```\r\n    ## indented\r\n";
        let headings = "# 一级\r\n  ### 三级 ###\r中文正文\n###### 六级";
        let raised = execute(&package, "raise_headings", format!("{untouched}{headings}")).unwrap();
        assert_eq!(
            raised,
            format!("{untouched}# 一级\r\n  ## 三级 ###\r中文正文\n##### 六级")
        );
        let lowered =
            execute(&package, "lower_headings", format!("{untouched}{headings}")).unwrap();
        assert_eq!(
            lowered,
            format!("{untouched}## 一级\r\n  #### 三级 ###\r中文正文\n###### 六级")
        );
    }
}
