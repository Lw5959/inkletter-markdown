use crate::store::err;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: String,
}

#[tauri::command]
pub fn update_package() -> Option<String> {
    // DEB 由系统包管理器安装，AppImage 使用原生签名更新流程。
    if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none() {
        let arch = if std::env::consts::ARCH == "aarch64" {
            "arm64"
        } else {
            "x64"
        };
        return Some(format!("linux-{arch}.deb"));
    }
    None
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(err)?.check().await.map_err(err)?;
    Ok(update.map(|release| UpdateInfo {
        version: release.version,
        notes: release.body.unwrap_or_default(),
    }))
}

#[tauri::command]
pub async fn update_install(app: AppHandle, version: String) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(err)?
        .check()
        .await
        .map_err(err)?
        .filter(|update| update.version == version)
        .ok_or("发布版本已变化，请重新检查更新")?;
    // Tauri 在安装前验证发布资产签名。重新检查版本避免使用过期的确认。
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(err)?;
    if !cfg!(target_os = "windows") {
        app.request_restart();
    }
    Ok(())
}
