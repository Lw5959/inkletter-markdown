use serde::Serialize;
#[cfg(not(target_os = "android"))]
use std::time::{Duration, Instant};
#[cfg(not(target_os = "android"))]
use tauri::{AppHandle, ipc::Channel};
#[cfg(not(target_os = "android"))]
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(any(target_os = "android", target_os = "linux"))]
pub mod package;

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateProgress {
    Download {
        downloaded: u64,
        total: Option<u64>,
    },
    #[cfg(any(target_os = "android", target_os = "linux"))]
    Verify,
    #[cfg(not(target_os = "android"))]
    Install,
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn update_package() -> bool {
    // DEB 由系统包管理器安装，AppImage 使用原生签名更新流程。
    cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = fetch_update(&app).await?;
    Ok(update.map(|release| UpdateInfo {
        version: release.version,
        notes: release.body.unwrap_or_default(),
    }))
}

#[cfg(not(target_os = "android"))]
async fn fetch_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = app.updater().map_err(|_| "无法初始化更新服务")?;
    // 超时只限制发布信息检查，避免慢速网络上的大安装包被提前中断。
    tokio::time::timeout(Duration::from_secs(15), updater.check())
        .await
        .map_err(|_| "检查更新超时")?
        .map_err(|_| "无法读取更新发布信息".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    version: String,
    progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let update = fetch_update(&app)
        .await?
        .filter(|update| update.version == version)
        .ok_or("发布版本已变化，请重新检查更新")?;
    let mut downloaded = 0;
    let mut last_report: Option<Instant> = None;
    // 仅上报实际收到的字节并限制 IPC 频率。安装仍由 Tauri 校验签名后执行。
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                if total == Some(downloaded)
                    || last_report.is_none_or(|last| last.elapsed() >= Duration::from_millis(100))
                {
                    last_report = Some(Instant::now());
                    let _ = progress.send(UpdateProgress::Download { downloaded, total });
                }
            },
            || {
                // 此回调在字节接收完毕时触发，签名校验和安装尚未完成。
                let _ = progress.send(UpdateProgress::Install);
            },
        )
        .await
        .map_err(|_| "下载、校验或安装更新失败，请重新检查更新")?;
    if !cfg!(target_os = "windows") {
        app.request_restart();
    }
    Ok(())
}
