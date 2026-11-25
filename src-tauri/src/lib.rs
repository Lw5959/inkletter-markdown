#![cfg(target_os = "android")]

mod android;
mod document_bytes;
mod store;

#[tauri::mobile_entry_point]
pub fn run() {
    android::run();
}
