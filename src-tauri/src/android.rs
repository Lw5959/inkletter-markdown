use crate::{
    ai,
    document_bytes::{decode, encode, hash},
    mcp, plugins,
    store::{Store, err},
    updates::package::{self, Downloads},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::fd::FromRawFd,
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, State, Wry, plugin::PluginHandle};

const SESSION: &str = "android-session.json";
const MAX_BYTES: u64 = 32 * 1024 * 1024;

struct Documents {
    plugin: PluginHandle<Wry>,
    saving: Mutex<()>,
}

#[derive(Deserialize)]
struct Picked {
    uri: Option<String>,
    #[serde(default)]
    uris: Vec<String>,
}

#[derive(Deserialize)]
struct Descriptor {
    fd: i32,
    name: String,
    writable: bool,
}

#[derive(Serialize)]
struct Document {
    uri: String,
    name: String,
    text: String,
    bom: bool,
    version: String,
    writable: bool,
}

#[derive(Serialize)]
struct WriteError {
    kind: &'static str,
    message: String,
}

impl WriteError {
    fn io(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "io",
            message: err(error),
        }
    }
}

impl Documents {
    fn descriptor(&self, uri: &str, write: bool) -> Result<(File, Descriptor), String> {
        if !uri.starts_with("content://") {
            return Err("请选择 Android 文件选择器里的文档".into());
        }
        let result: Descriptor = self
            .plugin
            .run_mobile_plugin("descriptor", json!({ "uri": uri, "write": write }))
            .map_err(err)?;
        // 原生侧 detachFd 后由 Rust 独占该描述符，File 离开作用域时关闭它。
        let file = unsafe { File::from_raw_fd(result.fd) };
        Ok((file, result))
    }
}

fn read_bytes(file: &mut File) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Android 版最多打开 32 MiB 的文档".into());
    }
    Ok(bytes)
}

fn snapshot(uri: String, info: Descriptor, bytes: Vec<u8>) -> Result<Document, String> {
    let version = hash(&bytes);
    let (text, bom) = decode(bytes)?;
    Ok(Document {
        uri,
        name: info.name,
        text,
        bom,
        version,
        writable: info.writable,
    })
}

#[tauri::command]
async fn android_pick(
    name: Option<String>,
    mime: Option<String>,
    documents: State<'_, Documents>,
) -> Result<Option<String>, String> {
    let result: Picked = documents
        .plugin
        .run_mobile_plugin("pickDocument", json!({ "name": name, "mime": mime }))
        .map_err(err)?;
    Ok(result.uri)
}

#[tauri::command]
async fn android_pick_many(documents: State<'_, Documents>) -> Result<Vec<String>, String> {
    let result: Picked = documents
        .plugin
        .run_mobile_plugin("pickDocument", json!({ "multiple": true }))
        .map_err(err)?;
    Ok(result.uris)
}

#[tauri::command]
async fn android_pick_workspace(documents: State<'_, Documents>) -> Result<Option<String>, String> {
    let result: Picked = documents
        .plugin
        .run_mobile_plugin("pickWorkspace", ())
        .map_err(err)?;
    Ok(result.uri)
}

#[tauri::command]
async fn android_workspace(uri: String, documents: State<'_, Documents>) -> Result<Value, String> {
    documents
        .plugin
        .run_mobile_plugin("workspace", json!({ "uri": uri }))
        .map_err(err)
}

#[tauri::command]
async fn android_print(
    name: String,
    html: String,
    documents: State<'_, Documents>,
) -> Result<(), String> {
    documents
        .plugin
        .run_mobile_plugin("printHtml", json!({ "name": name, "html": html }))
        .map_err(err)
}

#[tauri::command]
async fn android_read(uri: String, documents: State<'_, Documents>) -> Result<Document, String> {
    let (mut file, info) = documents.descriptor(&uri, false)?;
    snapshot(uri, info, read_bytes(&mut file)?)
}

#[tauri::command]
async fn android_ai_attachment(
    uri: String,
    documents: State<'_, Documents>,
) -> Result<ai::attachments::Attachment, String> {
    let (file, info) = documents.descriptor(&uri, false)?;
    tauri::async_runtime::spawn_blocking(move || ai::attachments::read(info.name, file))
        .await
        .map_err(err)?
}

fn replace_bytes(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    file.write_all(bytes)?;
    file.set_len(bytes.len() as u64)?;
    file.sync_all()
}

#[tauri::command]
async fn android_write(
    uri: String,
    text: String,
    bom: bool,
    expected: Option<String>,
    documents: State<'_, Documents>,
) -> Result<Document, WriteError> {
    let bytes = encode(&text, bom);
    if bytes.len() as u64 > MAX_BYTES {
        return Err(WriteError::io("Android 版最多保存 32 MiB 的文档"));
    }
    let _guard = documents.saving.lock().map_err(WriteError::io)?;
    let (mut file, info) = documents.descriptor(&uri, true).map_err(WriteError::io)?;
    // 文件提供方须支持定位。先比较版本，再用同一个描述符修改该文档。
    file.seek(SeekFrom::Start(0))
        .map_err(|_| WriteError::io("此文件位置不支持直接保存，请另存副本"))?;
    let previous = read_bytes(&mut file).map_err(WriteError::io)?;
    let matches = expected.map_or(previous.is_empty(), |version| version == hash(&previous));
    if !matches {
        return Err(WriteError {
            kind: "conflict",
            message: "文件已被其他应用修改".into(),
        });
    }
    if previous != bytes {
        if let Err(error) = replace_bytes(&mut file, &bytes) {
            // 外部文件提供方不能原子替换。在可写时恢复旧字节，编辑稿仍由应用内部保留。
            let restored = replace_bytes(&mut file, &previous).is_ok();
            return Err(WriteError::io(if restored {
                format!("保存失败，原文件内容已恢复：{error}")
            } else {
                format!("保存未完成，编辑稿已保留，请另存副本：{error}")
            }));
        }
    }
    Ok(Document {
        uri,
        name: info.name,
        version: hash(&bytes),
        text,
        bom,
        writable: info.writable,
    })
}

#[tauri::command]
async fn android_load_session(store: State<'_, Store>) -> Result<Value, String> {
    store.read(SESSION)
}

#[tauri::command]
async fn android_save_session(session: Value, store: State<'_, Store>) -> Result<(), String> {
    store.write(SESSION, &session)
}

#[tauri::command]
async fn android_insets(documents: State<'_, Documents>) -> Result<Value, String> {
    documents
        .plugin
        .run_mobile_plugin("insets", ())
        .map_err(err)
}

#[tauri::command]
async fn android_back_navigation(
    enabled: bool,
    animated: bool,
    documents: State<'_, Documents>,
) -> Result<(), String> {
    documents
        .plugin
        .run_mobile_plugin(
            "backNavigation",
            json!({ "enabled": enabled, "animated": animated }),
        )
        .map_err(err)
}

#[tauri::command]
async fn android_appearance(
    light: bool,
    color: String,
    documents: State<'_, Documents>,
) -> Result<(), String> {
    documents
        .plugin
        .run_mobile_plugin("appearance", json!({ "light": light, "color": color }))
        .map_err(err)
}

#[tauri::command]
async fn update_open_package(
    version: String,
    downloads: State<'_, Downloads>,
    documents: State<'_, Documents>,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Launch {
        status: String,
    }
    let path = package::verified_path(&downloads, &version).await?;
    let launch: Launch = documents
        .plugin
        .run_mobile_plugin("installUpdate", json!({ "path": path }))
        .map_err(err)?;
    Ok(launch.status)
}

#[tauri::command]
async fn visit_link(url: String, documents: State<'_, Documents>) -> Result<(), String> {
    let url = reqwest::Url::parse(&url).map_err(err)?;
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err("不支持此链接协议".into());
    }
    documents
        .plugin
        .run_mobile_plugin("visitLink", json!({ "url": url.as_str() }))
        .map_err(err)
}

pub fn run() {
    let documents = tauri::plugin::Builder::<Wry>::new("android-documents")
        .setup(|app, api| {
            let plugin = api.register_android_plugin("io.yeyu.markdown", "MarkdownDocuments")?;
            app.manage(Documents {
                plugin,
                saving: Mutex::new(()),
            });
            Ok(())
        })
        .build();
    tauri::Builder::default()
        .plugin(documents)
        .plugin(ai::config::android_credentials())
        .manage(Downloads::default())
        .manage(ai::Jobs::default())
        .manage(plugins::Plugins::default())
        .manage(plugins::market::Market::default())
        .setup(|app| {
            app.manage(Store(app.path().app_data_dir()?));
            // reqwest 的默认 Android 验证器需要额外 JVM 组件。显式启用公开 CA 根证书。
            let roots = webpki_root_certs::TLS_SERVER_ROOT_CERTS
                .iter()
                .map(|cert| reqwest::Certificate::from_der(cert.as_ref()))
                .collect::<Result<Vec<_>, _>>()?;
            let http = reqwest::Client::builder()
                .tls_certs_only(roots)
                .connect_timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .build()?;
            app.manage(mcp::Sessions::new(http.clone()));
            app.manage(http);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            android_pick,
            android_pick_many,
            android_pick_workspace,
            android_workspace,
            android_print,
            android_read,
            android_ai_attachment,
            android_write,
            android_load_session,
            android_save_session,
            android_insets,
            android_back_navigation,
            android_appearance,
            package::update_check_package,
            package::update_download_package,
            update_open_package,
            visit_link,
            ai::config::ai_settings,
            ai::config::ai_provider_save,
            ai::config::ai_provider_remove,
            ai::config::ai_model_select,
            ai::config::ai_model_metadata,
            ai::ai_list_models,
            ai::ai_stream,
            ai::agent::ai_agent_turn,
            ai::ai_conversations,
            ai::ai_cancel,
            plugins::plugin_list,
            plugins::plugin_install_content,
            plugins::plugin_set_enabled,
            plugins::plugin_remove,
            plugins::plugin_run,
            plugins::market::plugin_market_list,
            plugins::market::plugin_market_install,
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_connected,
            mcp::mcp_call,
        ])
        .run(tauri::generate_context!())
        .expect("无法启动页屿 Android");
}
