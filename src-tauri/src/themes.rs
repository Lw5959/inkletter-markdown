use crate::store::{Store, canonical, err, file_name};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, State};

#[derive(Default)]
pub struct ThemeImports(Mutex<HashMap<String, PathBuf>>);

#[derive(Clone, Deserialize, Serialize)]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub styles: Vec<String>,
}

#[derive(Serialize)]
pub struct Import {
    id: String,
    name: String,
    entry: String,
}

#[tauri::command]
pub async fn typora_theme_paths(app: tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let config = app.path().config_dir().map_err(err)?;
    #[cfg(target_os = "macos")]
    let directories = [
        config.join("abnerworks.Typora/themes"),
        app.path()
            .home_dir()
            .map_err(err)?
            .join("Applications/Typora.app/Contents/Resources/TypeMark/style/themes"),
        PathBuf::from("/Applications/Typora.app/Contents/Resources/TypeMark/style/themes"),
    ];
    #[cfg(not(target_os = "macos"))]
    let directories = [config.join("Typora/themes")];

    // 用户目录优先，同名内置主题只在用户目录缺少时补入。
    let mut paths = BTreeMap::new();
    for directory in directories {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(err(error)),
        };
        for entry in entries {
            let path = entry.map_err(err)?.path();
            let name = file_name(&path).to_ascii_lowercase();
            if name.ends_with(".css") && !name.ends_with(".user.css") && path.is_file() {
                paths.entry(name).or_insert(path);
            }
        }
    }
    Ok(paths.into_values().collect())
}

fn relative(path: &Path) -> Result<&Path, String> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("主题资源路径超出所选目录".into());
    }
    Ok(path)
}

pub fn data_uri(path: &Path, allow_fonts: bool) -> Result<String, String> {
    let mime = mime_guess::from_path(path)
        .first_raw()
        .ok_or("无法识别资源类型")?;
    let is_font = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            ["woff", "woff2", "otf", "ttf", "eot", "ttc"]
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        });
    if !mime.starts_with("image/") && !(allow_fonts && is_font) {
        return Err("仅支持图片或字体资源".into());
    }
    let bytes = fs::read(path).map_err(err)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn theme_begin(
    path: PathBuf,
    imports: State<'_, ThemeImports>,
) -> Result<Import, String> {
    let path = canonical(&path).map_err(err)?;
    if !path.is_file()
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("css"))
    {
        return Err("请选择主题的 CSS 文件".into());
    }
    let name = path
        .file_stem()
        .ok_or("缺少主题名称")?
        .to_string_lossy()
        .into_owned();
    let id = uuid::Uuid::new_v4().to_string();
    imports
        .0
        .lock()
        .map_err(err)?
        .insert(id.clone(), path.parent().ok_or("缺少主题目录")?.to_owned());
    Ok(Import {
        id,
        name,
        entry: file_name(&path),
    })
}

#[tauri::command]
pub async fn theme_read(
    id: String,
    path: PathBuf,
    imports: State<'_, ThemeImports>,
    store: State<'_, Store>,
) -> Result<Option<String>, String> {
    let root = imports
        .0
        .lock()
        .map_err(err)?
        .get(&id)
        .cloned()
        .ok_or("主题导入已结束")?;
    let path = relative(&path)?;
    let resolved = match canonical(&root.join(path)) {
        Ok(value) if value.starts_with(&root) => value,
        Ok(_) => return Err("主题资源指向所选目录之外".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(err(error)),
    };
    let is_css = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("css"));
    let data = if is_css {
        fs::read_to_string(&resolved).map_err(err)?
    } else {
        data_uri(&resolved, true)?
    };
    let dest = store.0.join("themes").join(id).join("source").join(path);
    fs::create_dir_all(dest.parent().ok_or("缺少资源目录")?).map_err(err)?;
    fs::copy(resolved, dest).map_err(err)?;
    Ok(Some(data))
}

#[tauri::command]
pub async fn theme_finish(
    theme: Theme,
    imports: State<'_, ThemeImports>,
    store: State<'_, Store>,
) -> Result<(), String> {
    if imports.0.lock().map_err(err)?.remove(&theme.id).is_none() {
        return Err("主题导入已结束".into());
    }
    store.write(&format!("themes/{}/theme.json", theme.id), &theme)
}

#[tauri::command]
pub async fn theme_abort(
    id: String,
    imports: State<'_, ThemeImports>,
    store: State<'_, Store>,
) -> Result<(), String> {
    if imports.0.lock().map_err(err)?.remove(&id).is_some() {
        let dir = store.0.join("themes").join(id);
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn theme_list(store: State<'_, Store>) -> Result<Vec<Theme>, String> {
    let root = store.0.join("themes");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut themes = Vec::new();
    for entry in fs::read_dir(root).map_err(err)?.flatten() {
        let path = entry.path().join("theme.json");
        if path.is_file() {
            let theme = fs::read(path)
                .map_err(err)
                .and_then(|bytes| serde_json::from_slice::<Theme>(&bytes).map_err(err));
            if let Ok(theme) = theme {
                themes.push(theme);
            }
        }
    }
    themes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(themes)
}
