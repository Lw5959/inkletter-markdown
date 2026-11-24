use crate::store::Store;
use serde_json::Value;
use std::{collections::VecDeque, path::PathBuf, sync::Mutex};
use tauri::State;

#[derive(Default)]
pub struct LaunchPaths(pub Mutex<VecDeque<PathBuf>>);

#[tauri::command]
pub async fn settings_load(store: State<'_, Store>) -> Result<Value, String> {
    store.read("settings.json")
}

#[tauri::command]
pub async fn settings_save(settings: Value, store: State<'_, Store>) -> Result<(), String> {
    store.write("settings.json", &settings)
}

#[tauri::command]
pub async fn launch_paths(paths: State<'_, LaunchPaths>) -> Result<Vec<PathBuf>, String> {
    Ok(paths
        .0
        .lock()
        .map_err(crate::store::err)?
        .drain(..)
        .collect())
}
