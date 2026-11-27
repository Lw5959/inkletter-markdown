use crate::store::{canonical, err, file_name};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use uuid::Uuid;

pub const OPEN_EVENT: &str = "yeyu:document-open";
const PANEL_URL: &str = "about:blank";
const PANEL_CLOSED_EVENT: &str = "yeyu:panel-closed";

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
    started: bool,
    launch_paths: Vec<PathBuf>,
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

fn panel_spec(fragment: &str) -> Option<(&str, bool, u16, u16)> {
    let mut parts = fragment.split('/');
    let modal = match parts.next()? {
        "yeyu-modal" => true,
        "yeyu-tool" => false,
        _ => return None,
    };
    let label = parts.next()?;
    Uuid::try_parse(label.strip_prefix("panel-")?).ok()?;
    let width = parts.next()?.parse().ok()?;
    let height = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=4096).contains(&width) || !(1..=4096).contains(&height) {
        return None;
    }
    Some((label, modal, width, height))
}

fn position_panel(
    window: &WebviewWindow,
    owner: &WebviewWindow,
    monitor: &Monitor,
) -> tauri::Result<()> {
    let anchor = owner.outer_position()?;
    let parent = owner.outer_size()?;
    let panel = window.outer_size()?;
    let area = monitor.work_area();
    // 按两个窗口的外框对齐，同时给菜单栏、任务栏和 Dock 留出系统保留区域。
    let align = |anchor: i32, parent: u32, panel: u32, start: i32, available: u32| {
        (anchor + (parent as i32 - panel as i32) / 2)
            .clamp(start, start + available.saturating_sub(panel) as i32)
    };
    let position = PhysicalPosition::new(
        align(
            anchor.x,
            parent.width,
            panel.width,
            area.position.x,
            area.size.width,
        ),
        align(
            anchor.y,
            parent.height,
            panel.height,
            area.position.y,
            area.size.height,
        ),
    );
    // AppKit 在不同缩放比例的显示器之间使用同一套逻辑坐标。
    #[cfg(target_os = "macos")]
    let position = position.to_logical::<f64>(monitor.scale_factor());
    window.set_position(position)
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
            .on_new_window(move |mut url, features| {
                use tauri::webview::NewWindowResponse;
                let Some((label, modal, width, height)) = url.fragment().and_then(panel_spec)
                else {
                    return NewWindowResponse::Deny;
                };
                let label = label.to_owned();
                // 在 opener 的初始空白页挂载组件。片段只传窗口标识和尺寸，避免触发二次导航。
                url.set_fragment(None);
                if url.as_str() != PANEL_URL {
                    return NewWindowResponse::Deny;
                }
                let Some(parent) = handle.get_webview_window(&owner) else {
                    return NewWindowResponse::Deny;
                };
                let monitor = parent.current_monitor().ok().flatten();
                let mut builder =
                    WebviewWindowBuilder::new(&handle, label, WebviewUrl::External(url))
                        .window_features(features)
                        .inner_size(f64::from(width), f64::from(height))
                        .title("墨笺")
                        .visible(false)
                        .focused(false)
                        .skip_taskbar(true)
                        .on_navigation(|url| url.as_str() == PANEL_URL)
                        .on_new_window(|_, _| NewWindowResponse::Deny)
                        .on_document_title_changed(|window, title| {
                            let _ = window.set_title(&title);
                        });
                if modal {
                    // 需要阻止文档输入的窗口保留原生父子关系，独立工具仅登记文档归属。
                    let Ok(attached) = builder.parent(&parent) else {
                        return NewWindowResponse::Deny;
                    };
                    builder = attached;
                }
                if let Some(monitor) = &monitor {
                    let start = monitor
                        .work_area()
                        .position
                        .to_logical::<f64>(monitor.scale_factor());
                    builder = builder.position(start.x, start.y).prevent_overflow();
                }
                let Ok(window) = builder.build() else {
                    return NewWindowResponse::Deny;
                };
                if let Ok(mut registry) = handle.state::<Windows>().0.lock() {
                    registry
                        .children
                        .insert(window.label().into(), owner.clone());
                }
                if let Some(monitor) = &monitor {
                    let _ = position_panel(&window, &parent, monitor);
                }
                let _ = window.show();
                let _ = window.set_focus();
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

pub fn startup(app: &AppHandle, data: &Path, mut paths: Vec<PathBuf>) -> Result<(), String> {
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
    {
        let windows = app.state::<Windows>();
        let mut registry = windows.0.lock().map_err(err)?;
        registry.started = true;
        paths.append(&mut registry.launch_paths);
    }
    open_paths(app, paths, None, Some("main"))
}

pub fn open_external_paths(app: &AppHandle, mut paths: Vec<PathBuf>) -> Result<(), String> {
    {
        let windows = app.state::<Windows>();
        let mut registry = windows.0.lock().map_err(err)?;
        if !registry.started {
            // Finder 冷启动可能先给出文件，再触发 Tauri 的窗口初始化。
            registry.launch_paths.append(&mut paths);
            return Ok(());
        }
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
    let (owner, children, continue_quit) = {
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
        let owner = registry.children.remove(label);
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
        (owner, children, advance)
    };
    if let Some(owner) = owner {
        let _ = app.emit_to(owner, PANEL_CLOSED_EVENT, label);
    }
    for child in children {
        if let Some(window) = app.get_webview_window(&child) {
            let _ = window.destroy();
        }
    }
    if continue_quit {
        request_quit(app);
    }
}

fn owned_panel(window: &WebviewWindow, label: &str) -> Result<Option<WebviewWindow>, String> {
    let windows = window.state::<Windows>();
    let registry = windows.0.lock().map_err(err)?;
    match registry.children.get(label) {
        Some(owner) if owner == window.label() => Ok(window.get_webview_window(label)),
        Some(_) => Err("工具窗口属于另一份文档".into()),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn desktop_panel_close(window: WebviewWindow, label: String) -> Result<(), String> {
    if let Some(panel) = owned_panel(&window, &label)? {
        // WebView 关闭页面后，系统窗口仍可能存在。需要销毁对应的原生窗口。
        panel.destroy().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_panel_resize(
    window: WebviewWindow,
    label: String,
    height: u16,
) -> Result<(), String> {
    if !(1..=4096).contains(&height) {
        return Err("窗口高度超出范围".into());
    }
    let Some(panel) = owned_panel(&window, &label)? else {
        return Ok(());
    };
    let scale = panel.scale_factor().map_err(err)?;
    let content = panel.inner_size().map_err(err)?;
    let mut height = f64::from(height);
    let monitor = panel.current_monitor().map_err(err)?;
    if let Some(monitor) = &monitor {
        let titlebar = panel
            .outer_size()
            .map_err(err)?
            .height
            .saturating_sub(content.height);
        let available = monitor.work_area().size.height.saturating_sub(titlebar);
        height = height.min((f64::from(available) / scale).max(1.));
    }
    panel
        .set_size(LogicalSize::new(f64::from(content.width) / scale, height))
        .map_err(err)?;
    // 更新说明扩展时仍以文档窗口为参照，将外框限制在当前显示器内。
    if let Some(monitor) = &monitor {
        let _ = position_panel(&panel, &window, monitor);
    }
    Ok(())
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
