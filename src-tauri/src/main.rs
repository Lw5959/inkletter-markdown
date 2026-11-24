#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};

#[derive(Serialize)]
struct FileSnapshot {
    path: PathBuf,
    name: String,
    text: String,
    bom: bool,
    version: String,
}

fn version(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn snapshot(path: PathBuf, bytes: Vec<u8>) -> Result<FileSnapshot, String> {
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let file_version = version(&bytes);
    let text = String::from_utf8(bytes[if bom { 3 } else { 0 }..].to_vec())
        .map_err(|_| "文档不是 UTF-8 编码".to_owned())?;
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    Ok(FileSnapshot { path, name, text, bom, version: file_version })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| std::io::Error::other("缺少父目录"))?;
    let mut out = tempfile::NamedTempFile::new_in(parent)?;
    out.write_all(bytes)?;
    if let Ok(metadata) = fs::metadata(path) {
        out.as_file().set_permissions(metadata.permissions())?;
    }
    out.as_file().sync_all()?;
    out.persist(path)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[tauri::command]
fn open_document(path: PathBuf) -> Result<FileSnapshot, String> {
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    let bytes = fs::read(&resolved).map_err(|error| error.to_string())?;
    snapshot(resolved, bytes)
}

#[tauri::command]
fn save_document(path: PathBuf, text: String, bom: bool, expected: Option<String>, saves: tauri::State<Mutex<()>>) -> Result<FileSnapshot, String> {
    let _save = saves.lock().map_err(|error| error.to_string())?;
    let path = if path.exists() {
        path.canonicalize().map_err(|error| error.to_string())?
    } else {
        path
    };
    let current = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if current.as_deref().map(version) != expected {
        return Err("磁盘上的文档已变化，请重新打开或另存为".to_owned());
    }
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(text.as_bytes());
    // 原封不动的保存不重写文件，保留文件时间戳及额外元数据。
    if current.as_ref() != Some(&bytes) {
        atomic_write(&path, &bytes).map_err(|error| error.to_string())?;
    }
    snapshot(path, bytes)
}

#[derive(Serialize)]
struct Theme {
    id: String,
    name: String,
    styles: Vec<String>,
}

#[tauri::command]
fn import_theme(path: PathBuf) -> Result<Theme, String> {
    let name = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let parent = path.parent().ok_or_else(|| "主题缺少父目录".to_owned())?;
    let mut styles = vec![fs::read_to_string(&path).map_err(|error| error.to_string())?];
    for custom in [parent.join("base.user.css"), parent.join(format!("{name}.user.css"))] {
        match fs::read_to_string(custom) {
            Ok(css) => styles.push(css),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(Theme { id: name.clone(), name, styles })
}

#[tauri::command]
fn write_export(path: PathBuf, html: String) -> Result<(), String> {
    atomic_write(&path, html.as_bytes()).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(()))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_document, save_document, import_theme, write_export])
        .run(tauri::generate_context!())
        .expect("无法启动页屿");
}
