use crate::store::{err, file_name};
use serde::Serialize;
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Serialize)]
pub struct Profile {
    name: String,
    text: String,
}

fn read_profile(path: &Path) -> Result<Profile, String> {
    let data = fs::read(path).map_err(err)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let text = match extension.as_str() {
        "plist" => {
            let value = plist::Value::from_reader(Cursor::new(data)).map_err(err)?;
            let values = value.as_dictionary().ok_or("Typora 设置应为属性列表字典")?;
            // 只传递迁移会用到的字段，避免读取会话、历史记录和应用标识等无关数据。
            let mut selected = serde_json::Map::new();
            for key in [
                "theme",
                "darkTheme",
                "useDarkTheme",
                "schemeAwareness",
                "image_uploader",
                "imageUploader",
                "uploadEndpoint",
                "imageUploadUrl",
                "NSUserKeyEquivalents",
                "keyBinding",
                "sidebar_tab",
                "caseSensitive",
                "wholeWord",
                "enableAutoSave",
                "autoSaveTimer",
                "spellcheck",
                "ignoreSpell",
            ] {
                if let Some(value) = values.get(key) {
                    selected.insert(key.into(), serde_json::to_value(value).map_err(err)?);
                }
            }
            serde_json::to_string(&selected).map_err(err)?
        }
        "json" | "jsonc" => String::from_utf8(data).map_err(|_| "Typora 配置须为 UTF-8 文本")?,
        _ => return Err("请选择 Typora 的 plist、JSON 或 JSONC 配置文件".into()),
    };
    Ok(Profile {
        name: file_name(path),
        text,
    })
}

#[tauri::command]
pub async fn typora_profiles(
    app: tauri::AppHandle,
    path: Option<PathBuf>,
) -> Result<Vec<Profile>, String> {
    if let Some(path) = path {
        return read_profile(&path).map(|value| vec![value]);
    }
    let config = app.path().config_dir().map_err(err)?;
    #[cfg(target_os = "macos")]
    let paths = [
        app.path()
            .home_dir()
            .map_err(err)?
            .join("Library/Preferences/abnerworks.Typora.plist"),
        config.join("abnerworks.Typora/conf/conf.user.json"),
    ];
    #[cfg(not(target_os = "macos"))]
    let paths = [
        config.join("Typora/preferences.json"),
        config.join("Typora/conf/conf.user.json"),
        config.join("Typora/conf/config.user.json"),
    ];
    paths
        .iter()
        .filter(|path| path.is_file())
        .map(|path| read_profile(path))
        .collect()
}
