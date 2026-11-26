use super::{UpdateInfo, UpdateProgress};
use crate::store::err;
use reqwest::{Client, Response, Url, header};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

const RELEASES: &str = "https://github.com/Lw5959/yeyu/releases/download";
const LATEST: &str = "https://api.github.com/repos/Lw5959/yeyu/releases/latest";
const PACKAGE_SUFFIX: &str = if cfg!(target_os = "android") {
    "android-arm64.apk"
} else if cfg!(target_arch = "aarch64") {
    "linux-arm64.deb"
} else {
    "linux-x64.deb"
};
const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct Downloads(Mutex<Option<Downloaded>>);

struct Downloaded {
    version: String,
    path: PathBuf,
    size: u64,
    sha256: String,
}

impl Downloaded {
    async fn matches_file(&self) -> bool {
        let Ok(mut file) = fs::File::open(&self.path).await else {
            return false;
        };
        if !file
            .metadata()
            .await
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == self.size)
        {
            return false;
        }
        let mut hash = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match file.read(&mut buffer).await {
                Ok(0) => return format!("{:x}", hash.finalize()) == self.sha256,
                Ok(read) => hash.update(&buffer[..read]),
                Err(_) => return false,
            }
        }
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: u64,
}

struct Package {
    info: UpdateInfo,
    name: String,
    url: Url,
    sha256: String,
    size: u64,
}

impl Release {
    fn package(self, installed: &Version) -> Result<Option<Package>, String> {
        let version = Version::parse(self.tag_name.strip_prefix('v').unwrap_or(&self.tag_name))
            .map_err(|_| "发布版本号无效")?;
        if version <= *installed || !version.pre.is_empty() {
            return Ok(None);
        }
        let name = format!("Yeyu_{version}_{PACKAGE_SUFFIX}");
        let url = format!("{RELEASES}/{}/{name}", self.tag_name);
        // 文件名、版本和地址同时匹配，摘要由同一次发布查询提供。
        let asset = self
            .assets
            .into_iter()
            .find(|asset| asset.name == name && asset.browser_download_url == url)
            .ok_or("当前版本未提供此设备的安装包")?;
        let sha256 = asset
            .digest
            .as_deref()
            .and_then(|digest| digest.strip_prefix("sha256:"))
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or("安装包缺少有效的 SHA-256 摘要")?
            .to_ascii_lowercase();
        if !(1..=MAX_PACKAGE_BYTES).contains(&asset.size) {
            return Err("安装包大小无效".into());
        }
        Ok(Some(Package {
            info: UpdateInfo {
                version: version.to_string(),
                notes: self.body.unwrap_or_default(),
            },
            name,
            url: Url::parse(&url).map_err(err)?,
            sha256,
            size: asset.size,
        }))
    }
}

async fn latest(app: &AppHandle, client: &Client) -> Result<Option<Package>, String> {
    let release = client
        .get(LATEST)
        .header(header::USER_AGENT, "Yeyu-Updater")
        .header(header::ACCEPT, "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json::<Release>()
        .await
        .map_err(err)?;
    release.package(&app.package_info().version)
}

#[tauri::command]
pub async fn update_check_package(
    app: AppHandle,
    client: State<'_, Client>,
) -> Result<Option<UpdateInfo>, String> {
    Ok(latest(&app, &client).await?.map(|package| package.info))
}

fn asset_redirect(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
        )
}

async fn download_response(client: &Client, mut url: Url) -> Result<Response, String> {
    for _ in 0..3 {
        let response = tokio::time::timeout(READ_TIMEOUT, client.get(url.clone()).send())
            .await
            .map_err(|_| "连接安装包下载超时")?
            .map_err(err)?;
        if response.status().is_success() {
            return Ok(response);
        }
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|header| header.to_str().ok());
        url = location
            .and_then(|target| url.join(target).ok())
            .filter(|target| response.status().is_redirection() && asset_redirect(target))
            .ok_or("无法从页屿发布下载安装包")?;
    }
    Err("安装包下载重定向次数过多".into())
}

#[tauri::command]
pub async fn update_download_package(
    app: AppHandle,
    client: State<'_, Client>,
    downloads: State<'_, Downloads>,
    version: String,
    progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let mut ready = downloads.0.try_lock().map_err(|_| "已有更新正在下载")?;
    if let Some(item) = ready.as_ref().filter(|item| item.version == version) {
        if item.matches_file().await {
            return Ok(());
        }
    }
    let package = latest(&app, &client)
        .await?
        .filter(|item| item.info.version == version)
        .ok_or("发布版本已变化，请重新检查更新")?;
    let directory = app.path().app_cache_dir().map_err(err)?.join("updates");
    fs::create_dir_all(&directory).await.map_err(err)?;
    let destination = directory.join(&package.name);
    let (file, partial) = tempfile::NamedTempFile::new_in(&directory)
        .map_err(err)?
        .into_parts();
    let mut file = fs::File::from_std(file);
    let total = Some(package.size);
    let _ = progress.send(UpdateProgress::Download {
        downloaded: 0,
        total,
    });
    let mut response = download_response(&client, package.url).await?;
    let mut received = 0u64;
    let mut hasher = Sha256::new();
    let mut last_report = Instant::now();
    while let Some(chunk) = tokio::time::timeout(READ_TIMEOUT, response.chunk())
        .await
        .map_err(|_| "安装包下载超时")?
        .map_err(err)?
    {
        received += chunk.len() as u64;
        if received > package.size {
            return Err("安装包大小与发布记录不符".into());
        }
        file.write_all(&chunk).await.map_err(err)?;
        hasher.update(&chunk);
        if received == package.size || last_report.elapsed() >= Duration::from_millis(100) {
            let _ = progress.send(UpdateProgress::Download {
                downloaded: received,
                total,
            });
            last_report = Instant::now();
        }
    }
    let _ = progress.send(UpdateProgress::Verify);
    if received != package.size || format!("{:x}", hasher.finalize()) != package.sha256 {
        return Err("安装包校验失败，请重新下载".into());
    }
    // 校验后才把临时文件转为可安装文件，失败或断网时由 TempPath 清理。
    file.sync_all().await.map_err(err)?;
    drop(file);
    partial.persist(&destination).map_err(err)?;
    *ready = Some(Downloaded {
        version,
        path: destination,
        size: received,
        sha256: package.sha256,
    });
    Ok(())
}

pub(crate) async fn verified_path(downloads: &Downloads, version: &str) -> Result<PathBuf, String> {
    let ready = downloads.0.try_lock().map_err(|_| "已有更新正在下载")?;
    let item = ready
        .as_ref()
        .filter(|item| item.version == version)
        .ok_or("请先下载并校验安装包")?;
    if !item.matches_file().await {
        return Err("安装包已变化，请重新下载".into());
    }
    Ok(item.path.clone())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn update_open_package(
    downloads: State<'_, Downloads>,
    version: String,
) -> Result<&'static str, String> {
    use gio::prelude::AppInfoExt;

    let path = verified_path(&downloads, &version).await?;
    // 缺少 DEB 打开程序时，界面仍可把已校验的包保存到用户选择的位置。
    let (kind, _) = gio::content_type_guess(Some(&path), &[]);
    let handler = gio::AppInfo::default_for_type(&kind, false);
    if handler.is_some_and(|app| {
        app.launch(
            &[gio::File::for_path(&path)],
            None::<&gio::AppLaunchContext>,
        )
        .is_ok()
    }) {
        Ok("installer")
    } else {
        Ok("save")
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn update_save_package(
    downloads: State<'_, Downloads>,
    version: String,
    path: PathBuf,
) -> Result<(), String> {
    let source = verified_path(&downloads, &version).await?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("deb") {
        return Err("请选择 .deb 文件名".into());
    }
    let parent = path.parent().ok_or("缺少保存目录")?;
    let (file, temp) = tempfile::NamedTempFile::new_in(parent)
        .map_err(err)?
        .into_parts();
    let mut out = fs::File::from_std(file);
    tokio::io::copy(&mut fs::File::open(source).await.map_err(err)?, &mut out)
        .await
        .map_err(err)?;
    out.sync_all().await.map_err(err)?;
    drop(out);
    temp.persist(path).map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn released_asset() -> Release {
        let name = format!("Yeyu_9.0.0_{PACKAGE_SUFFIX}");
        Release {
            tag_name: "v9.0.0".into(),
            body: None,
            assets: vec![Asset {
                browser_download_url: format!("{RELEASES}/v9.0.0/{name}"),
                name,
                digest: Some(format!("sha256:{}", "a".repeat(64))),
                size: 1024,
            }],
        }
    }

    #[test]
    fn package_requires_expected_asset_and_digest() {
        let installed = Version::new(0, 2, 13);
        let package = released_asset().package(&installed).unwrap().unwrap();
        assert_eq!(package.info.version, "9.0.0");
        assert!(
            released_asset()
                .package(&Version::new(9, 0, 0))
                .unwrap()
                .is_none()
        );

        let mut release = released_asset();
        release.assets[0].digest = None;
        assert!(release.package(&installed).is_err());
        let mut release = released_asset();
        release.assets[0].browser_download_url = "https://example.invalid/file.deb".into();
        assert!(release.package(&installed).is_err());
    }

    #[tokio::test]
    async fn cached_package_detects_same_size_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("update");
        fs::write(&path, b"signed").await.unwrap();
        let ready = Downloaded {
            version: "9.0.0".into(),
            path,
            size: 6,
            sha256: format!("{:x}", Sha256::digest(b"signed")),
        };
        assert!(ready.matches_file().await);
        fs::write(&ready.path, b"edited").await.unwrap();
        assert!(!ready.matches_file().await);
    }
}
