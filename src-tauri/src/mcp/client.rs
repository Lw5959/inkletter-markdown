use crate::{ai::configured_endpoint, store::err};
#[cfg(target_os = "android")]
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{
    ClientLifecycleMode, ClientServiceExt, RoleClient,
    model::{
        CallToolRequestParams, GetPromptRequestParams, JsonObject, ProtocolVersion,
        ReadResourceRequestParams,
    },
    service::RunningService,
    transport::StreamableHttpClientTransport,
};
#[cfg(not(target_os = "android"))]
use rmcp::{ServiceExt, transport::TokioChildProcess};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, time::Duration};
use tauri::State;
use tokio::sync::Mutex;

type Session = RunningService<RoleClient, ()>;

#[cfg_attr(not(target_os = "android"), derive(Default))]
pub struct Sessions {
    active: Mutex<HashMap<String, Session>>,
    #[cfg(target_os = "android")]
    http: reqwest::Client,
}

#[cfg(target_os = "android")]
impl Sessions {
    pub(crate) fn new(http: reqwest::Client) -> Self {
        Self {
            active: Mutex::default(),
            http,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Server {
    id: String,
    name: String,
    transport: String,
    #[cfg(not(target_os = "android"))]
    command: Option<String>,
    #[cfg(not(target_os = "android"))]
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
pub async fn mcp_connect(
    server: Server,
    sessions: State<'_, Sessions>,
) -> Result<Vec<Item>, String> {
    let id = server.id;
    let establish = async {
        let session = match server.transport.as_str() {
            #[cfg(not(target_os = "android"))]
            "stdio" => {
                let program = server
                    .command
                    .as_deref()
                    .filter(|arg| !arg.trim().is_empty())
                    .ok_or("缺少本地服务器命令")?;
                let mut command = tokio::process::Command::new(program);
                command
                    .args(server.args.unwrap_or_default())
                    .kill_on_drop(true);
                #[cfg(target_os = "windows")]
                command.creation_flags(0x0800_0000);
                ().serve(TokioChildProcess::new(command).map_err(err)?)
                    .await
                    .map_err(err)?
            }
            "http" => {
                let url = configured_endpoint(server.url.as_deref().ok_or("缺少服务器地址")?)?;
                // Android 复用带公开根证书的 HTTP 客户端，保持模型、市场和 MCP 的验证规则一致。
                #[cfg(target_os = "android")]
                let transport = StreamableHttpClientTransport::with_client(
                    sessions.http.clone(),
                    StreamableHttpClientTransportConfig::with_uri(url.as_str()),
                );
                #[cfg(not(target_os = "android"))]
                let transport = StreamableHttpClientTransport::from_uri(url.as_str());
                ().serve_with_lifecycle(
                    transport,
                    ClientLifecycleMode::Auto {
                        preferred_versions: vec![
                            ProtocolVersion::V_2026_07_28,
                            ProtocolVersion::V_2025_11_25,
                            ProtocolVersion::V_2025_06_18,
                        ],
                        legacy_version: Some(ProtocolVersion::V_2025_11_25),
                    },
                )
                .await
                .map_err(err)?
            }
            #[cfg(target_os = "android")]
            "stdio" => return Err("Android 的 MCP 客户端支持 Streamable HTTP".into()),
            _ => return Err("不支持的 MCP 传输".into()),
        };
        let mut items = Vec::new();
        let info = session.peer_info().ok_or("服务器未返回 MCP 能力")?;
        if info.capabilities.tools.is_some() {
            for tool in session.list_all_tools().await.map_err(err)? {
                items.push(Item {
                    kind: "tool".into(),
                    name: tool.name.into_owned(),
                    title: tool.title,
                    description: tool.description.map(|text| text.into_owned()),
                    schema: Some(serde_json::to_value(&*tool.input_schema).map_err(err)?),
                });
            }
        }
        if info.capabilities.resources.is_some() {
            for resource in session.list_all_resources().await.map_err(err)? {
                items.push(Item {
                    kind: "resource".into(),
                    name: resource.uri.clone(),
                    title: Some(
                        resource
                            .title
                            .clone()
                            .unwrap_or_else(|| resource.name.clone()),
                    ),
                    description: resource.description.clone(),
                    schema: None,
                });
            }
        }
        if info.capabilities.prompts.is_some() {
            for prompt in session.list_all_prompts().await.map_err(err)? {
                items.push(Item {
                    kind: "prompt".into(),
                    name: prompt.name,
                    title: prompt.title,
                    description: prompt.description,
                    schema: serde_json::to_value(prompt.arguments).ok(),
                });
            }
        }
        Ok::<_, String>((session, items))
    };
    let (session, items) = tokio::time::timeout(Duration::from_secs(20), establish)
        .await
        .map_err(|_| "连接或发现 MCP 能力超时")??;
    sessions.active.lock().await.insert(id, session);
    Ok(items)
}

#[tauri::command]
pub async fn mcp_disconnect(id: String, sessions: State<'_, Sessions>) -> Result<(), String> {
    let session = sessions.active.lock().await.remove(&id);
    if let Some(session) = session {
        let _ = tokio::time::timeout(Duration::from_secs(3), session.cancel()).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_connected(sessions: State<'_, Sessions>) -> Result<Vec<String>, String> {
    let mut sessions = sessions.active.lock().await;
    sessions.retain(|_, session| !session.is_closed());
    Ok(sessions.keys().cloned().collect())
}

#[tauri::command]
pub async fn mcp_call(
    id: String,
    item: Item,
    args: JsonObject,
    sessions: State<'_, Sessions>,
) -> Result<Value, String> {
    let peer = sessions
        .active
        .lock()
        .await
        .get(&id)
        .filter(|session| !session.is_closed())
        .map(|session| session.peer().clone())
        .ok_or("MCP 服务器未连接")?;
    tokio::time::timeout(Duration::from_secs(60), async {
        match item.kind.as_str() {
            "tool" => serde_json::to_value(
                peer.call_tool(CallToolRequestParams::new(item.name).with_arguments(args))
                    .await
                    .map_err(err)?,
            )
            .map_err(err),
            "resource" => serde_json::to_value(
                peer.read_resource(ReadResourceRequestParams::new(item.name))
                    .await
                    .map_err(err)?,
            )
            .map_err(err),
            "prompt" => serde_json::to_value(
                peer.get_prompt(GetPromptRequestParams::new(item.name).with_arguments(args))
                    .await
                    .map_err(err)?,
            )
            .map_err(err),
            _ => Err("不支持的 MCP 调用".into()),
        }
    })
    .await
    .map_err(|_| "MCP 调用超时")?
}
