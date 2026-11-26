use crate::store::{Store, err};
use serde_json::Value;
use std::{path::PathBuf, sync::Mutex};
use tauri::State;

#[derive(Default)]
pub struct SettingsLock(Mutex<()>);

#[tauri::command]
pub async fn settings_load(store: State<'_, Store>) -> Result<Value, String> {
    store.read("settings.json")
}

#[tauri::command]
pub async fn settings_save(
    settings: serde_json::Map<String, Value>,
    store: State<'_, Store>,
    lock: State<'_, SettingsLock>,
) -> Result<(), String> {
    let _write = lock.0.lock().map_err(err)?;
    let mut current: serde_json::Map<String, Value> = store.read("settings.json")?;
    // 各窗口只提交自己改过的字段，避免关闭旧窗口时覆盖另一窗口的新偏好。
    current.extend(settings);
    store.write("settings.json", &current)
}

#[tauri::command]
pub async fn settings_recent(
    path: PathBuf,
    store: State<'_, Store>,
    lock: State<'_, SettingsLock>,
) -> Result<Vec<PathBuf>, String> {
    let _write = lock.0.lock().map_err(err)?;
    let mut current: serde_json::Map<String, Value> = store.read("settings.json")?;
    let mut recent: Vec<PathBuf> = current
        .remove("recent")
        .map(serde_json::from_value)
        .transpose()
        .map_err(err)?
        .unwrap_or_default();
    recent.retain(|existing| existing != &path);
    recent.insert(0, path);
    recent.truncate(24);
    current.insert("recent".into(), serde_json::to_value(&recent).map_err(err)?);
    store.write("settings.json", &current)?;
    Ok(recent)
}
