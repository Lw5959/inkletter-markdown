use reqwest::Url;
use semver::Version;
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "android"))]
use std::time::{Duration, Instant};
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
use tauri::ipc::Channel;
#[cfg(not(target_os = "android"))]
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(any(target_os = "android", target_os = "linux"))]
pub mod package;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateSource {
    #[default]
    Auto,
    Github,
    Gitee,
}

fn endpoint(app: &AppHandle, index: usize) -> Result<Url, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config["endpoints"].get(index))
        .and_then(|entry| entry.as_str())
        .and_then(|url| Url::parse(url).ok())
        .ok_or_else(|| "更新源地址无效".into())
}

fn candidates<T>(
    results: [Result<Option<T>, String>; 2],
    version: impl Fn(&T) -> &str,
) -> Result<Vec<T>, String> {
    let [primary, mirror] = results;
    if primary.is_err() && mirror.is_err() {
        return Err("GitHub 和 Gitee 更新源暂不可用".into());
    }
    // 先选择更新的版本。同版本优先使用 GitHub，下载失败时还可以尝试 Gitee。
    let mut available: Vec<T> = [primary, mirror]
        .into_iter()
        .filter_map(|item| item.ok().flatten())
        .collect();
    available.sort_by_cached_key(|item| std::cmp::Reverse(Version::parse(version(item)).ok()));
    Ok(available)
}

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
pub async fn update_check(
    app: AppHandle,
    source: Option<UpdateSource>,
) -> Result<Option<UpdateInfo>, String> {
    Ok(fetch_updates(&app, source.unwrap_or_default())
        .await?
        .into_iter()
        .next()
        .map(|release| UpdateInfo {
            version: release.version,
            notes: release.body.unwrap_or_default(),
        }))
}

#[cfg(not(target_os = "android"))]
async fn check_endpoint(app: &AppHandle, index: usize) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint(app, index)?])
        .map_err(|_| "无法初始化更新源")?
        .configure_client(|client| {
            client
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(30))
        })
        .build()
        .map_err(|_| "无法初始化更新服务")?;
    // 检查设整体时限，下载时只限制连接及读取停滞。
    tokio::time::timeout(Duration::from_secs(10), updater.check())
        .await
        .map_err(|_| "检查更新超时")?
        .map_err(|_| "无法读取更新发布信息".into())
}

#[cfg(not(target_os = "android"))]
async fn fetch_updates(app: &AppHandle, source: UpdateSource) -> Result<Vec<Update>, String> {
    match source {
        UpdateSource::Github => Ok(check_endpoint(app, 0).await?.into_iter().collect()),
        UpdateSource::Gitee => Ok(check_endpoint(app, 1).await?.into_iter().collect()),
        UpdateSource::Auto => {
            let (primary, mirror) = tokio::join!(check_endpoint(app, 0), check_endpoint(app, 1));
            candidates([primary, mirror], |item| &item.version)
        }
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    version: String,
    source: Option<UpdateSource>,
    progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let mut error = "发布版本已变化，请重新检查更新";
    for update in fetch_updates(&app, source.unwrap_or_default())
        .await?
        .into_iter()
        .filter(|item| item.version == version)
    {
        let _ = progress.send(UpdateProgress::Download {
            downloaded: 0,
            total: None,
        });
        let mut downloaded = 0;
        let mut last_report: Option<Instant> = None;
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    if total == Some(downloaded)
                        || last_report
                            .is_none_or(|last| last.elapsed() >= Duration::from_millis(100))
                    {
                        last_report = Some(Instant::now());
                        let _ = progress.send(UpdateProgress::Download { downloaded, total });
                    }
                },
                || {},
            )
            .await;
        let Ok(bytes) = bytes else {
            error = "无法下载或校验更新，请重新检查更新";
            continue;
        };
        // Tauri 在 download 内验签。只切换下载源，已启动的安装只执行一次。
        let _ = progress.send(UpdateProgress::Install);
        update
            .install(bytes)
            .map_err(|_| "安装更新失败，请重新检查更新")?;
        if !cfg!(target_os = "windows") {
            app.request_restart();
        }
        return Ok(());
    }
    Err(error.into())
}

#[cfg(test)]
mod tests {
    use super::candidates;

    #[test]
    fn mirrors_select_newest_and_keep_same_version_fallback() {
        let primary = ("0.2.19", "GitHub");
        let mirror = ("0.2.19", "Gitee");
        let newer = ("0.2.20", "Gitee");
        assert_eq!(
            candidates([Ok(Some(primary)), Ok(Some(mirror))], |item| item.0).unwrap(),
            [primary, mirror]
        );
        assert_eq!(
            candidates([Ok(Some(primary)), Ok(Some(newer))], |item| item.0).unwrap()[0],
            newer
        );
        assert_eq!(
            candidates([Err("offline".into()), Ok(Some(mirror))], |item| item.0).unwrap(),
            [mirror]
        );
        assert!(
            candidates::<(&str, &str)>([Err("offline".into()), Ok(None)], |item| item.0)
                .unwrap()
                .is_empty()
        );
    }
}
