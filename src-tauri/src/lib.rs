#![cfg(target_os = "android")]

mod ai;
mod android;
mod document_bytes;
mod plugins;
mod store;

#[tauri::mobile_entry_point]
pub fn run() {
    android::run();
}
