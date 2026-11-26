use crate::store::{canonical, err, file_name};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use uuid::Uuid;

pub const OPEN_EVENT: &str = "yeyu:document-open";

#[derive(Clone, Serialize)]
pub struct OpenRequest {
    path: PathBuf,
    line: Option<usize>,
}

#[derive(Default)]
struct Document {
    path: Option<PathBuf>,
    pending: Option<OpenRequest>,
    dirty: bool,
    ready: bool,
}

#[derive(Default)]
struct Registry {
    documents: BTreeMap<String, Document>,
    children: BTreeMap<String, String>,
    last_focused: Option<String>,
    closing_for_quit: Option<String>,
}

#[derive(Default)]
pub struct Windows(Mutex<Registry>);

// 草稿按窗口单独落盘。旧版 recovery.json 仍由主窗口读取。
pub fn recovery_file(label: &str) -> String {
    if label == "main" {
        "recovery.json".into()
    } else {
        format!("recovery/{label}.json")
    }
}

fn document_label() -> String {
    format!("document-{}", Uuid::new_v4().simple())
}

fn recovery_labels(data: &Path) -> Vec<String> {
    let mut labels = Vec::new();
    if let Ok(entries) = fs::read_dir(data.join("recovery")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(label) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            if label
                .strip_prefix("document-")
                .is_some_and(|id| Uuid::try_parse(id).is_ok())
            {
                labels.push(label.into());
            }
        }
    }
    labels.sort_unstable();
    labels
}

fn create_editor(
    app: &AppHandle,
    label: &str,
    document: Document,
) -> Result<WebviewWindow, String> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or("缺少文档窗口配置")?;
    config.label = label.into();
    {
        let windows = app.state::<Windows>();
        let mut registry = windows.0.lock().map_err(err)?;
        let registered = registry.documents.entry(label.into()).or_insert(document);
        if let Some(path) = &registered.path {
            config.title = file_name(path);
        }
    }
    let owner = label.to_owned();
    let handle = app.clone();
    let panels = !cfg!(feature = "qa") || std::env::var_os("YEYU_QA_NATIVE_PANELS").is_some();
    let built = WebviewWindowBuilder::from_config(app, &config).and_then(|builder| {
        builder
            .initialization_script(format!("window.__YEYU_DESKTOP_WINDOWS__ = {panels};"))
            .on_new_window(move |url, features| {
                use tauri::webview::NewWindowResponse;
                // 只接收应用自身的空白子窗口。外部链接仍由系统默认浏览器处理。
                if url.as_str() != "about:blank" {
                    return NewWindowResponse::Deny;
                }
                let Some(parent) = handle.get_webview_window(&owner) else {
                    return NewWindowResponse::Deny;
                };
                let child = WebviewWindowBuilder::new(
                    &handle,
                    format!("panel-{}", Uuid::new_v4().simple()),
                    WebviewUrl::External(url),
                )
                .window_features(features)
                .parent(&parent)
                .and_then(|builder| {
                    builder
                        .title("页屿")
                        .center()
                        .skip_taskbar(true)
                        .on_navigation(|url| url.as_str() == "about:blank")
                        .on_new_window(|_, _| NewWindowResponse::Deny)
                        .on_document_title_changed(|window, title| {
                            let _ = window.set_title(&title);
                        })
                        .build()
                });
                let Ok(window) = child else {
                    return NewWindowResponse::Deny;
                };
                if let Ok(mut registry) = handle.state::<Windows>().0.lock() {
                    registry
                        .children
                        .insert(window.label().into(), owner.clone());
                }
                NewWindowResponse::Create { window }
            })
            .build()
    });
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            app.state::<Windows>()
                .0
                .lock()
                .map_err(err)?
                .documents
                .remove(label);
            return Err(err(error));
        }
    };
    #[cfg(target_os = "macos")]
    crate::titlebar::sync_webview_on_resize(&window);
    #[cfg(target_os = "linux")]
    if panels {
        use webkit2gtk::{SettingsExt, WebViewExt};
        // 恢复草稿等提示在加载时打开，也需要走受控的子窗口入口。
        window
            .with_webview(|native| {
                if let Some(settings) = native.inner().settings() {
                    settings.set_javascript_can_open_windows_automatically(true);
                }
            })
            .map_err(err)?;
    }
    Ok(window)
}

pub fn startup(app: &AppHandle, data: &Path, paths: Vec<PathBuf>) -> Result<(), String> {
    #[derive(Deserialize)]
    struct DraftPath {
        path: Option<PathBuf>,
    }
    let store = app.state::<crate::store::Store>();
    let recovering = |label: &str| {
        let name = recovery_file(label);
        Document {
            path: store
                .read::<Option<DraftPath>>(&name)
                .ok()
                .flatten()
                .and_then(|draft| draft.path),
            dirty: data.join(&name).is_file(),
            ..Default::default()
        }
    };
    create_editor(app, "main", recovering("main"))?;
    for label in recovery_labels(data) {
        create_editor(app, &label, recovering(&label))?;
    }
    open_paths(app, paths, None, Some("main"))
}

pub fn argument_paths(args: impl IntoIterator<Item = PathBuf>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .filter(|path| crate::workspace::markdown(path) && path.is_file())
        .collect()
}

pub fn open_paths(
    app: &AppHandle,
    paths: Vec<PathBuf>,
    line: Option<usize>,
    reuse: Option<&str>,
) -> Result<(), String> {
    let mut failure = None;
    for path in paths {
        if let Err(error) = open_path(app, path, line, reuse) {
            failure = Some(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

fn open_path(
    app: &AppHandle,
    path: PathBuf,
    line: Option<usize>,
    reuse: Option<&str>,
) -> Result<(), String> {
    let path = canonical(&path).map_err(err)?;
    if !path.is_file() {
        return Err("请选择一个文档文件".into());
    }
    let request = OpenRequest {
        path: path.clone(),
        line,
    };
    let (label, create) = {
        let windows = app.state::<Windows>();
        let mut registry = windows.0.lock().map_err(err)?;
        if let Some((label, document)) = registry
            .documents
            .iter_mut()
            .find(|(_, doc)| doc.path.as_ref() == Some(&path))
        {
            if line.is_some() {
                document.pending = Some(request.clone());
            }
            (label.clone(), false)
        } else {
            let available =
                |doc: &Document| doc.path.is_none() && !doc.dirty && doc.pending.is_none();
            let label = reuse
                .filter(|label| registry.documents.get(*label).is_some_and(available))
                .or_else(|| {
                    registry
                        .documents
                        .get("main")
                        .filter(|doc| !doc.ready && available(doc))
                        .map(|_| "main")
                });
            let create = label.is_none();
            let label = label.map(str::to_owned).unwrap_or_else(document_label);
            // 先登记路径再创建窗口，两个来源同时打开同一文件时共享这次创建。
            let slot = registry.documents.entry(label.clone()).or_default();
            slot.path = Some(path);
            slot.pending = Some(request);
            (label, create)
        }
    };
    if create {
        create_editor(app, &label, Document::default())?;
    } else {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.unminimize();
            window.show().map_err(err)?;
            window.set_focus().map_err(err)?;
            let _ = window.emit_to(&label, OPEN_EVENT, ());
        }
    }
    Ok(())
}

pub fn on_window_event(label: &str, app: &AppHandle, event: &WindowEvent) {
    let windows = app.state::<Windows>();
    let (children, continue_quit) = {
        let Ok(mut registry) = windows.0.lock() else {
            return;
        };
        if matches!(event, WindowEvent::Focused(true)) {
            if registry.documents.contains_key(label) {
                registry.last_focused = Some(label.into());
            } else if let Some(parent) = registry.children.get(label) {
                registry.last_focused = Some(parent.clone());
            }
        }
        if !matches!(event, WindowEvent::Destroyed) {
            return;
        }
        registry.children.remove(label);
        registry.documents.remove(label);
        let advance = registry.closing_for_quit.as_deref() == Some(label);
        if advance {
            registry.closing_for_quit = None;
        }
        let children = registry
            .children
            .iter()
            .filter(|(_, owner)| *owner == label)
            .map(|(child, _)| child.clone())
            .collect::<Vec<_>>();
        (children, advance)
    };
    for child in children {
        if let Some(window) = app.get_webview_window(&child) {
            let _ = window.destroy();
        }
    }
    if continue_quit {
        request_quit(app);
    }
}

pub fn request_quit(app: &AppHandle) {
    let label = {
        let windows = app.state::<Windows>();
        let Ok(mut registry) = windows.0.lock() else {
            return;
        };
        if registry.closing_for_quit.is_some() {
            return;
        }
        // 先处理有编辑的窗口，任何一个选择继续编辑时立即停止退出流程。
        let next = registry
            .documents
            .iter()
            .max_by_key(|(label, doc)| (doc.dirty, registry.last_focused.as_ref() == Some(*label)))
            .map(|(label, _)| label.clone());
        registry.closing_for_quit = next.clone();
        next
    };
    if let Some(window) = label
        .as_deref()
        .and_then(|label| app.get_webview_window(label))
    {
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.close();
    }
}

#[tauri::command]
pub fn document_quit_cancel(windows: tauri::State<'_, Windows>) -> Result<(), String> {
    windows.0.lock().map_err(err)?.closing_for_quit = None;
    Ok(())
}

pub fn front_editor(app: &AppHandle) -> Option<WebviewWindow> {
    let (labels, last_focused) = {
        let windows = app.state::<Windows>();
        let registry = windows.0.lock().ok()?;
        (
            registry.documents.keys().cloned().collect::<Vec<_>>(),
            registry.last_focused.clone(),
        )
    };
    labels
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| {
            last_focused
                .as_ref()
                .and_then(|label| app.get_webview_window(label))
        })
        .or_else(|| {
            labels
                .iter()
                .find_map(|label| app.get_webview_window(label))
        })
}

#[tauri::command]
pub async fn document_windows_open(
    paths: Vec<PathBuf>,
    line: Option<usize>,
    reuse: bool,
    window: WebviewWindow,
) -> Result<(), String> {
    open_paths(
        window.app_handle(),
        paths,
        line,
        reuse.then_some(window.label()),
    )
}

#[tauri::command]
pub async fn document_window_new(app: AppHandle) -> Result<(), String> {
    create_editor(&app, &document_label(), Document::default()).map(|_| ())
}

#[tauri::command]
pub async fn document_window_request(
    window: WebviewWindow,
    windows: tauri::State<'_, Windows>,
) -> Result<Option<OpenRequest>, String> {
    let mut registry = windows.0.lock().map_err(err)?;
    let document = registry
        .documents
        .get_mut(window.label())
        .ok_or("缺少当前文档窗口")?;
    document.ready = true;
    Ok(document.pending.take())
}

#[tauri::command]
pub async fn document_window_state(
    window: WebviewWindow,
    windows: tauri::State<'_, Windows>,
    path: Option<PathBuf>,
    dirty: bool,
) -> Result<(), String> {
    {
        let mut registry = windows.0.lock().map_err(err)?;
        let document = registry
            .documents
            .get_mut(window.label())
            .ok_or("缺少当前文档窗口")?;
        if document.pending.is_none() {
            document.path = path.clone();
        }
        document.dirty = dirty;
    }
    let title = path
        .as_deref()
        .map(file_name)
        .unwrap_or_else(|| "未命名.md".into());
    window.set_title(&title).map_err(err)
}
