use crate::{ai::safe_endpoint, files, store::{Store, canonical, err}, workspace};
use rmcp::{
    ClientLifecycleMode, ClientServiceExt, ErrorData, Json, RoleClient, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolRequestParams, GetPromptRequestParams, Implementation, JsonObject, ProtocolVersion, ReadResourceRequestParams, ServerCapabilities, ServerConfig},
    schemars::{self, JsonSchema},
    service::RunningService,
    tool, tool_handler, tool_router,
    transport::{StreamableHttpClientTransport, TokioChildProcess, stdio},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, fs, path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::State;
use tokio::sync::Mutex;

const AUTHORIZED: &str = "mcp/authorized.json";
type Session = RunningService<RoleClient, ()>;

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Session>>);

#[derive(Clone, Deserialize, Serialize)]
pub struct Server {
    id: String,
    name: String,
    transport: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    url: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct Item {
    kind: String,
    name: String,
    title: Option<String>,
    description: Option<String>,
    schema: Option<Value>,
}

#[tauri::command]
pub async fn mcp_connect(server: Server, sessions: State<'_, Sessions>) -> Result<Vec<Item>, String> {
    let id = server.id;
    let establish = async {
        let session = match server.transport.as_str() {
            "stdio" => {
                let program = server.command.as_deref().filter(|arg| !arg.trim().is_empty()).ok_or("缺少本地服务器命令")?;
                let mut command = tokio::process::Command::new(program);
                command.args(server.args.unwrap_or_default()).kill_on_drop(true);
                #[cfg(target_os = "windows")]
                command.creation_flags(0x0800_0000);
                ().serve(TokioChildProcess::new(command).map_err(err)?).await.map_err(err)?
            }
            "http" => {
                let url = safe_endpoint(server.url.as_deref().ok_or("缺少服务器地址")?)?;
                let transport = StreamableHttpClientTransport::from_uri(url.as_str());
                ().serve_with_lifecycle(transport, ClientLifecycleMode::Auto { preferred_versions: vec![
                    ProtocolVersion::V_2026_07_28, ProtocolVersion::V_2025_11_25, ProtocolVersion::V_2025_06_18,
                ], legacy_version: Some(ProtocolVersion::V_2025_11_25)}).await.map_err(err)?
            }
            _ => return Err("不支持的 MCP 传输".into()),
        };
        let mut items = Vec::new();
        let info = session.peer_info().ok_or("服务器未返回 MCP 能力")?;
        if info.capabilities.tools.is_some() {
            for tool in session.list_all_tools().await.map_err(err)? {
                items.push(Item { kind: "tool".into(), name: tool.name.into_owned(),
                    title: tool.title, description: tool.description.map(|text| text.into_owned()),
                    schema: Some(serde_json::to_value(&*tool.input_schema).map_err(err)?), });
            }
        }
        if info.capabilities.resources.is_some() {
            for resource in session.list_all_resources().await.map_err(err)? {
                items.push(Item { kind: "resource".into(), name: resource.uri.clone(),
                    title: Some(resource.title.clone().unwrap_or_else(|| resource.name.clone())),
                    description: resource.description.clone(), schema: None, });
            }
        }
        if info.capabilities.prompts.is_some() {
            for prompt in session.list_all_prompts().await.map_err(err)? {
                items.push(Item { kind: "prompt".into(), name: prompt.name,
                    title: prompt.title, description: prompt.description,
                    schema: serde_json::to_value(prompt.arguments).ok(), });
            }
        }
        Ok::<_, String>((session, items))
    };
    let (session, items) = tokio::time::timeout(Duration::from_secs(20), establish)
        .await.map_err(|_| "连接或发现 MCP 能力超时")??;
    sessions.0.lock().await.insert(id, session);
    Ok(items)
}

#[tauri::command]
pub async fn mcp_disconnect(id: String, sessions: State<'_, Sessions>) -> Result<(), String> {
    let session = sessions.0.lock().await.remove(&id);
    if let Some(session) = session {
        let _ = tokio::time::timeout(Duration::from_secs(3), session.cancel()).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_connected(sessions: State<'_, Sessions>) -> Result<Vec<String>, String> {
    let mut sessions = sessions.0.lock().await;
    sessions.retain(|_, session| !session.is_closed());
    Ok(sessions.keys().cloned().collect())
}

#[tauri::command]
pub async fn mcp_call(id: String, item: Item, args: JsonObject, sessions: State<'_, Sessions>) -> Result<Value, String> {
    let peer = sessions.0.lock().await.get(&id).filter(|session| !session.is_closed())
        .map(|session| session.peer().clone()).ok_or("MCP 服务器未连接")?;
    tokio::time::timeout(Duration::from_secs(60), async {
        match item.kind.as_str() {
            "tool" => serde_json::to_value(peer.call_tool(CallToolRequestParams::new(item.name).with_arguments(args)).await.map_err(err)?).map_err(err),
            "resource" => serde_json::to_value(peer.read_resource(ReadResourceRequestParams::new(item.name)).await.map_err(err)?).map_err(err),
            "prompt" => serde_json::to_value(peer.get_prompt(GetPromptRequestParams::new(item.name).with_arguments(args)).await.map_err(err)?).map_err(err),
            _ => Err("不支持的 MCP 调用".into()),
        }
    }).await.map_err(|_| "MCP 调用超时")?
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    path: PathBuf,
    text: String,
    anchor: usize,
    head: usize,
    updated: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub workspace: PathBuf,
    pub path: PathBuf,
    pub version: String,
    pub from: usize,
    pub to: usize,
    pub replacement: String,
    pub summary: String,
    pub created: u64,
}

#[derive(Serialize)]
pub struct Local {
    allowed: bool,
    command: String,
}

fn timestamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn authorized(store: &Store, root: &Path) -> Result<bool, String> {
    Ok(store.read::<Vec<PathBuf>>(AUTHORIZED)?.iter().any(|path| path == root))
}

fn selection_file(root: &Path) -> String {
    format!("mcp/selection-{}.json", blake3::hash(root.as_os_str().as_encoded_bytes()).to_hex())
}

fn command_for(root: &Path, store: &Store) -> Result<String, String> {
    // 以 MCP 客户端可直接粘贴的 JSON 配置携带独立参数，路径含空格时也无需转义 shell。
    serde_json::to_string_pretty(&json!({
        "mcpServers": {"yeyu": {
            "command": std::env::current_exe().map_err(err)?,
            "args": ["--mcp", "--workspace", &root.to_string_lossy(), "--state-dir", &store.0.to_string_lossy()],
        }},
    })).map_err(err)
}

#[tauri::command]
pub async fn mcp_local(root: PathBuf, allow: Option<bool>, store: State<'_, Store>) -> Result<Local, String> {
    let root = canonical(&root).map_err(err)?;
    if !root.is_dir() {
        return Err("请选择一个工作区文件夹".into());
    }
    let mut allowed: Vec<PathBuf> = store.read(AUTHORIZED)?;
    if let Some(value) = allow {
        allowed.retain(|path| path != &root);
        if value { allowed.push(root.clone()); }
        store.write(AUTHORIZED, &allowed)?;
        if !value {
            store.remove(&selection_file(&root))?;
        }
    }
    let allowed = allowed.contains(&root);
    Ok(Local { allowed, command: if allowed { command_for(&root, &store)? } else { String::new() } })
}

#[tauri::command]
pub async fn mcp_selection(root: PathBuf, selection: Option<Selection>, store: State<'_, Store>) -> Result<(), String> {
    let root = canonical(&root).map_err(err)?;
    if !authorized(&store, &root)? {
        return Ok(());
    }
    let name = selection_file(&root);
    if let Some(mut selection) = selection {
        selection.path = workspace::inside(&root, &selection.path)?;
        selection.updated = Some(timestamp());
        return store.write(&name, &selection);
    }
    store.remove(&name)
}

#[tauri::command]
pub async fn mcp_proposals(root: PathBuf, store: State<'_, Store>) -> Result<Vec<Proposal>, String> {
    let root = canonical(&root).map_err(err)?;
    let folder = store.0.join("mcp/proposals");
    let mut proposals = Vec::new();
    if authorized(&store, &root)? && folder.is_dir() {
        for entry in fs::read_dir(folder).map_err(err)?.flatten() {
            if entry.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            if let Ok(proposal) = store.read::<Option<Proposal>>(&format!("mcp/proposals/{}", entry.file_name().to_string_lossy())) {
                if let Some(proposal) = proposal.filter(|item| item.workspace == root) {
                    proposals.push(proposal);
                }
            }
        }
        proposals.sort_by_key(|proposal| proposal.created);
    }
    Ok(proposals)
}

#[tauri::command]
pub async fn mcp_resolve(id: String, store: State<'_, Store>) -> Result<(), String> {
    let uuid = uuid::Uuid::parse_str(&id).map_err(err)?;
    store.remove(&format!("mcp/proposals/{uuid}.json"))
}

#[derive(Clone)]
struct WorkspaceServer {
    root: PathBuf,
    store: Store,
    tool_router: ToolRouter<Self>,
}

#[derive(Deserialize, JsonSchema)]
struct Search {
    query: String,
    regex: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct Read {
    #[schemars(description = "Markdown path relative to the authorized workspace, or its absolute equivalent")]
    path: PathBuf,
}

#[derive(Deserialize, JsonSchema)]
struct Suggest {
    path: PathBuf,
    #[schemars(description = "Version returned by read_document")]
    version: String,
    #[schemars(description = "Start UTF-16 offset, including line endings and excluding BOM")]
    from: usize,
    #[schemars(description = "End UTF-16 offset, exclusive")]
    to: usize,
    replacement: String,
    summary: String,
}

fn mcp_error(message: impl Into<String>) -> ErrorData {
    ErrorData::invalid_params(message.into(), None)
}

fn offset_boundary(text: &str, offset: usize) -> bool {
    let mut position = 0;
    for character in text.chars() {
        if position >= offset { break; }
        position += character.len_utf16();
    }
    position == offset
}

#[tool_router]
impl WorkspaceServer {
    fn require_access(&self) -> Result<(), ErrorData> {
        if authorized(&self.store, &self.root).map_err(mcp_error)? {
            Ok(())
        } else {
            Err(mcp_error("请在页屿的 MCP 侧栏授权此工作区"))
        }
    }

    fn document_path(&self, path: &Path) -> Result<PathBuf, ErrorData> {
        self.require_access()?;
        let path = workspace::inside(&self.root, path).map_err(mcp_error)?;
        if path.is_file() && workspace::markdown(&path) {
            Ok(path)
        } else {
            Err(mcp_error("只能读取工作区内的 Markdown 或文本文件"))
        }
    }

    #[tool(description = "Search text across Markdown documents in the user-authorized workspace")]
    fn search_documents(&self, Parameters(args): Parameters<Search>) -> Result<Json<Value>, ErrorData> {
        self.require_access()?;
        Ok(Json(json!(workspace::search(&self.root, &args.query, args.regex.unwrap_or(false), false).map_err(mcp_error)?)))
    }

    #[tool(description = "Read a Markdown document and its version for a later proposal")]
    fn read_document(&self, Parameters(args): Parameters<Read>) -> Result<Json<Value>, ErrorData> {
        let path = self.document_path(&args.path)?;
        Ok(Json(json!(files::read(&path).map_err(mcp_error)?)))
    }

    #[tool(description = "Read the active selection in Yeyu while its authorized workspace is open")]
    fn current_selection(&self) -> Result<Json<Value>, ErrorData> {
        self.require_access()?;
        let selection = self.store.read::<Option<Selection>>(&selection_file(&self.root)).map_err(mcp_error)?
            .filter(|selection| timestamp().saturating_sub(selection.updated.unwrap_or(0)) < 15);
        Ok(Json(json!(selection)))
    }

    #[tool(description = "Submit a Markdown edit for review in Yeyu. The document remains intact until the user applies the proposal.")]
    fn suggest_edit(&self, Parameters(args): Parameters<Suggest>) -> Result<Json<Value>, ErrorData> {
        let path = self.document_path(&args.path)?;
        let file = files::read(&path).map_err(mcp_error)?;
        if file.version != args.version {
            return Err(mcp_error("文档已更新，请重新读取后再提交建议"));
        }
        if args.from > args.to || !offset_boundary(&file.text, args.from) || !offset_boundary(&file.text, args.to) {
            return Err(mcp_error("建议范围不是有效的 UTF-16 文本边界"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let proposal = Proposal {
            id: id.clone(), workspace: self.root.clone(), path, version: file.version,
            from: args.from, to: args.to, replacement: args.replacement, summary: args.summary, created: timestamp(),
        };
        self.store.write(&format!("mcp/proposals/{id}.json"), &proposal).map_err(mcp_error)?;
        Ok(Json(json!({ "id": id, "status": "awaiting_review" })))
    }
}

#[tool_handler]
impl ServerHandler for WorkspaceServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("yeyu", env!("CARGO_PKG_VERSION")))
            .with_instructions("Workspace-scoped Markdown reading, search, and user-reviewed edit suggestions.")
    }
}

pub async fn serve(root: PathBuf, state_dir: PathBuf) -> Result<(), String> {
    let root = canonical(&root).map_err(err)?;
    let server = WorkspaceServer { root, store: Store(state_dir), tool_router: WorkspaceServer::tool_router() };
    server.require_access().map_err(err)?;
    let service = server.serve(stdio()).await.map_err(err)?;
    service.waiting().await.map_err(err)?;
    Ok(())
}
