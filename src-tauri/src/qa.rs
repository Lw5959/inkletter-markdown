// 测试驱动只编译到独立的 QA 构建。发布安装包没有这些命令。
use crate::store::{Store, err};
use serde_json::Value;
use std::path::PathBuf;

pub fn directory() -> Option<PathBuf> {
    std::env::var_os("YEYU_QA_CASE").map(PathBuf::from)
}

#[tauri::command]
pub fn qa_config() -> Result<Value, String> {
    Store(directory().ok_or("未指定 QA 目录")?).read("case.json")
}

#[tauri::command]
pub fn qa_report(name: String, data: Value) -> Result<(), String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("无效的 QA 结果文件名".into());
    }
    Store(directory().ok_or("未指定 QA 目录")?).write(&format!("{name}.json"), &data)
}

#[tauri::command]
pub async fn qa_windows(app: tauri::AppHandle) -> Vec<Value> {
    use tauri::Manager;
    app.webview_windows()
        .into_values()
        .map(|window| {
            serde_json::json!({
                "label": window.label(), "title": window.title().unwrap_or_default()
            })
        })
        .collect()
}

#[tauri::command]
pub async fn qa_input(
    window: tauri::WebviewWindow,
    operation: String,
    character: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::action(window, operation, character).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, operation, character);
        Err("该输入驱动用于 macOS".into())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc2::{msg_send, runtime::AnyObject, sel};
    use objc2_foundation::{NSRange, NSString};
    use tokio::sync::oneshot;

    pub async fn action(
        window: tauri::WebviewWindow,
        operation: String,
        character: String,
    ) -> Result<(), String> {
        let (send, receive) = oneshot::channel();
        window.with_webview(move |native| {
            let run = || -> Result<(), String> {
                unsafe {
                    let view = native.inner().cast::<AnyObject>();
                    let window: *mut AnyObject = msg_send![view, window];
                    let responder: *mut AnyObject = msg_send![window, firstResponder];
                    if responder.is_null() { return Err("编辑器未取得键盘焦点".into()); }
                    let text = NSString::from_str(&character);
                    let replacement = NSRange::new(isize::MAX as usize, 0);
                    // 直接走 WebKit 的 Cocoa 文本输入客户端，保留系统当前输入源。
                    if operation == "mark" {
                        let supported: bool = msg_send![responder, respondsToSelector: sel!(setMarkedText:selectedRange:replacementRange:)];
                        if !supported { return Err("WebView 不支持标记文本".into()); }
                        let cursor = NSRange::new(character.encode_utf16().count(), 0);
                        let _: () = msg_send![responder, setMarkedText: &*text,
                            selectedRange: cursor, replacementRange: replacement];
                    } else if operation == "insert" {
                        let supported: bool = msg_send![responder, respondsToSelector: sel!(insertText:replacementRange:)];
                        if !supported { return Err("WebView 不支持提交文本".into()); }
                        let _: () = msg_send![responder, insertText: &*text, replacementRange: replacement];
                    } else {
                        return Err("无效的输入操作".into());
                    }
                }
                Ok(())
            };
            let _ = send.send(run());
        }).map_err(err)?;
        receive.await.map_err(err)?
    }
}
