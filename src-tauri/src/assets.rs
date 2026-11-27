use crate::{
    store::{canonical, err, file_name},
    themes::data_uri,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
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

pub(crate) fn image_mime(path: &Path) -> Option<&'static str> {
    mime_guess::from_path(path)
        .first_raw()
        .filter(|mime| mime.starts_with("image/"))
}

#[tauri::command]
pub async fn image_data(document: PathBuf, image: PathBuf) -> Result<String, String> {
    data_uri(&resolved(&document, &image)?, false)
}

fn media_subdir(document: &Path) -> Result<String, String> {
    let label = document
        .file_stem()
        .ok_or("请先保存文档")?
        .to_string_lossy();
    Ok(format!("{label}.assets"))
}

fn media_folder(document: &Path, subdir: &str) -> Result<PathBuf, String> {
    let folder = document.parent().ok_or("文档缺少所在目录")?;
    let assets = folder.join(subdir);
    fs::create_dir_all(&assets).map_err(err)?;
    if !canonical(&assets)
        .map_err(err)?
        .starts_with(canonical(folder).map_err(err)?)
    {
        return Err("图片目录指向文档目录之外".into());
    }
    Ok(assets)
}

fn media_copy(document: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let subdir = media_subdir(document)?;
    let assets = media_folder(document, &subdir)?;
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

#[derive(Serialize)]
pub struct ImageFingerprint {
    digest: String,
    extension: String,
}

fn image_file(path: &Path) -> Result<(fs::File, String), String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if image_mime(path).is_none() || !fs::metadata(path).map_err(err)?.is_file() {
        return Err("图片需要是受支持类型的本地文件".into());
    }
    let extension = match extension.as_str() {
        "jpeg" => "jpg".into(),
        "tif" => "tiff".into(),
        _ => extension,
    };
    Ok((fs::File::open(path).map_err(err)?, extension))
}

fn digest(reader: impl std::io::Read) -> Result<String, String> {
    Ok(blake3::Hasher::new()
        .update_reader(reader)
        .map_err(err)?
        .finalize()
        .to_hex()
        .to_string())
}

#[tauri::command]
pub async fn image_fingerprints(
    document: PathBuf,
    images: Vec<PathBuf>,
) -> Result<Vec<Result<ImageFingerprint, String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        images
            .into_iter()
            .map(|image| {
                let (file, extension) = image_file(&resolved(&document, &image)?)?;
                Ok(ImageFingerprint {
                    digest: digest(file)?,
                    extension,
                })
            })
            .collect()
    })
    .await
    .map_err(err)
}

#[derive(Deserialize)]
pub struct PlannedImage {
    image: PathBuf,
    name: String,
    digest: String,
}

fn collect_images(document: &Path, copies: Vec<PlannedImage>) -> Result<(), String> {
    let subdir = media_subdir(document)?;
    let mut staged = Vec::new();
    let mut destinations = std::collections::HashMap::new();
    let assets = media_folder(document, &subdir)?;
    for item in copies {
        let (mut source, extension) = image_file(&resolved(document, &item.image)?)?;
        let filename = item
            .name
            .strip_suffix(&format!(".{extension}"))
            .ok_or("整理后的图片扩展名须与原图一致")?;
        // 插件只提议文件名。宿主把名称、目录及写入范围限制在本文的资源文件夹内。
        if filename.is_empty()
            || filename.len() > 100
            || !filename.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
            })
        {
            return Err("插件返回了无效的图片文件名".into());
        }
        if let Some(previous) = destinations.insert(item.name.clone(), item.digest.clone()) {
            if previous != item.digest {
                return Err("不同图片使用了同一个目标文件名".into());
            }
            if digest(source)? != item.digest {
                return Err("原图已变化，请重新预览".into());
            }
            continue;
        }
        let target = assets.join(&item.name);
        match fs::symlink_metadata(&target) {
            Ok(existing) => {
                if !existing.is_file()
                    || digest(fs::File::open(&target).map_err(err)?)? != item.digest
                {
                    return Err(format!("资源目录已有同名文件 {}", item.name));
                }
                if digest(source)? != item.digest {
                    return Err("原图已变化，请重新预览".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // 提交前准备所有副本并核对预览中的内容。目标文件始终采用不覆盖写入。
                let mut temp = tempfile::NamedTempFile::new_in(&assets).map_err(err)?;
                std::io::copy(&mut source, &mut temp).map_err(err)?;
                if digest(temp.reopen().map_err(err)?)? != item.digest {
                    return Err("原图已变化，请重新预览".into());
                }
                temp.as_file().sync_all().map_err(err)?;
                staged.push((temp, target));
            }
            Err(error) => return Err(err(error)),
        }
    }
    for (temp, path) in staged {
        temp.persist_noclobber(path).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn image_collect(document: PathBuf, copies: Vec<PlannedImage>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || collect_images(&document, copies))
        .await
        .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_collection_reuses_equal_content_and_refuses_changed_sources() {
        let folder = tempfile::tempdir().unwrap();
        let document = folder.path().join("使用手册.md");
        let source = folder.path().join("原图.JPG");
        let duplicate = folder.path().join("副本.jpeg");
        let target = folder.path().join("使用手册.assets/image-01.jpg");
        let data = include_bytes!("../../assets/app-icon.png");
        let expected = digest(&data[..]).unwrap();
        fs::write(&source, data).unwrap();
        fs::write(&duplicate, data).unwrap();
        let copies = || {
            vec![
                PlannedImage {
                    image: source.clone(),
                    name: "image-01.jpg".into(),
                    digest: expected.clone(),
                },
                PlannedImage {
                    image: duplicate.clone(),
                    name: "image-01.jpg".into(),
                    digest: expected.clone(),
                },
            ]
        };
        fs::write(&duplicate, b"external change").unwrap();
        assert!(collect_images(&document, copies()).is_err());
        assert!(!target.exists());
        fs::write(&duplicate, data).unwrap();
        collect_images(&document, copies()).unwrap();
        collect_images(&document, copies()).unwrap();
        assert_eq!(fs::read(&target).unwrap(), data);
        assert_eq!(fs::read(&source).unwrap(), data);
        assert_eq!(fs::read(&duplicate).unwrap(), data);
        fs::write(&target, b"a different image").unwrap();
        assert!(collect_images(&document, copies()).is_err());
        assert_eq!(fs::read(target).unwrap(), b"a different image");
    }
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
