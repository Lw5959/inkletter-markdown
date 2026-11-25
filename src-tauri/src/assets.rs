use crate::{
    store::{canonical, err, file_name},
    themes::data_uri,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn resolved(document: &Path, image: &Path) -> Result<PathBuf, String> {
    let folder = document.parent().ok_or("文档缺少所在目录")?;
    canonical(&if image.is_absolute() {
        image.to_owned()
    } else {
        folder.join(image)
    })
    .map_err(err)
}

fn image_mime(path: &Path) -> Option<&'static str> {
    mime_guess::from_path(path)
        .first_raw()
        .filter(|mime| mime.starts_with("image/"))
}

#[tauri::command]
pub async fn image_data(document: PathBuf, image: PathBuf) -> Result<String, String> {
    data_uri(&resolved(&document, &image)?, false)
}

fn media_copy(document: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let label = document
        .file_stem()
        .ok_or("请先保存文档")?
        .to_string_lossy();
    let folder = document.parent().ok_or("文档缺少所在目录")?;
    let subdir = format!("{label}.assets");
    let assets = folder.join(&subdir);
    fs::create_dir_all(&assets).map_err(err)?;
    if !canonical(&assets)
        .map_err(err)?
        .starts_with(canonical(folder).map_err(err)?)
    {
        return Err("图片目录指向文档目录之外".into());
    }
    let file = Path::new(name);
    if image_mime(file).is_none() {
        return Err("文件缺少受支持的图片扩展名".into());
    }
    let name = file_name(file);
    let mut tmp = tempfile::NamedTempFile::new_in(&assets).map_err(err)?;
    tmp.write_all(bytes).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    let dest = assets.join(&name);
    if fs::read(&dest).is_ok_and(|data| data == bytes) {
        return Ok(format!("{subdir}/{name}"));
    }
    let name = if dest.symlink_metadata().is_ok() {
        format!("{}-{name}", uuid::Uuid::new_v4().simple())
    } else {
        name
    };
    tmp.persist_noclobber(assets.join(&name)).map_err(err)?;
    Ok(format!("{subdir}/{name}"))
}

#[tauri::command]
pub async fn image_insert(document: PathBuf, name: String, data: String) -> Result<String, String> {
    let bytes = STANDARD.decode(data).map_err(err)?;
    media_copy(&document, &name, &bytes)
}

#[derive(Serialize)]
pub struct Relocated {
    path: String,
    original: Option<PathBuf>,
}

#[tauri::command]
pub async fn image_copy(document: PathBuf, image: PathBuf) -> Result<Relocated, String> {
    let source = resolved(&document, &image)?;
    let bytes = fs::read(&source).map_err(err)?;
    let path = media_copy(&document, &file_name(&source), &bytes)?;
    let destination = resolved(&document, Path::new(&path))?;
    let original = (source != destination).then_some(source);
    Ok(Relocated { path, original })
}

#[tauri::command]
pub async fn image_remove(
    document: PathBuf,
    paths: Vec<PathBuf>,
    references: Vec<PathBuf>,
) -> Result<(), String> {
    if paths.iter().any(|path| image_mime(path).is_none()) {
        return Err("只能移动图片资源".into());
    }
    let used: std::collections::HashSet<_> = references
        .iter()
        .filter_map(|reference| resolved(&document, reference).ok())
        .collect();
    trash::delete_all(paths.into_iter().filter(|path| !used.contains(path))).map_err(err)
}

#[tauri::command]
pub async fn image_upload(
    document: PathBuf,
    image: PathBuf,
    endpoint: String,
    service: Option<String>,
    http: tauri::State<'_, reqwest::Client>,
) -> Result<String, String> {
    let url = crate::ai::safe_endpoint(&endpoint)?;
    let source = resolved(&document, &image)?;
    let mime = image_mime(&source).ok_or("不支持上传该文件类型")?;
    let picgo = service.as_deref() == Some("picgo");
    let request = if picgo {
        let loopback = match url.host() {
            Some(url::Host::Domain(name)) => name == "localhost",
            Some(url::Host::Ipv4(address)) => address.is_loopback(),
            Some(url::Host::Ipv6(address)) => address.is_loopback(),
            None => false,
        };
        if !loopback || url.path() != "/upload" {
            return Err("PicGo / PicList 图床须使用本机的 /upload 接口".into());
        }
        // PicGo 的本机服务按绝对路径上传，由服务使用其现有图床配置。
        http.post(url)
            .json(&serde_json::json!({ "list": [source] }))
    } else {
        let bytes = tokio::fs::read(&source).await.map_err(err)?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name(&source))
            .mime_str(mime)
            .map_err(err)?;
        http.post(url)
            .multipart(reqwest::multipart::Form::new().part("file", part))
    };
    let data: serde_json::Value = request
        .send()
        .await
        .map_err(|error| {
            if picgo {
                "无法连接本机图床，请打开 PicGo 或 PicList 并启用上传服务".into()
            } else {
                err(error.without_url())
            }
        })?
        .error_for_status()
        .map_err(|error| err(error.without_url()))?
        .json()
        .await
        .map_err(err)?;
    let link = if picgo {
        if data["success"].as_bool() != Some(true) {
            return Err("本机图床上传失败，请查看 PicGo 或 PicList 的上传日志".into());
        }
        data["result"][0]
            .as_str()
            .ok_or("本机图床没有返回图片地址")?
    } else {
        data["url"]
            .as_str()
            .ok_or("接口应返回包含 url 字段的 JSON")?
    };
    let parsed = reqwest::Url::parse(link).map_err(err)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("上传接口返回了不受支持的图片地址".into());
    }
    Ok(parsed.to_string())
}
