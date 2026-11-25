#![cfg(target_os = "android")]

mod ai;
mod android;
mod document_bytes;
// Android 只编译与桌面共用的客户端。
#[path = "mcp/client.rs"]
mod mcp;
mod plugins;
mod store;

#[tauri::mobile_entry_point]
pub fn run() {
    android::run();
}
