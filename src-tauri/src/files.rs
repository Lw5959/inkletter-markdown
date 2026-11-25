pub use crate::document_bytes::hash;
use crate::document_bytes::{decode, encode};
use crate::store::{Store, atomic_write, canonical, err, file_name};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;

pub type SaveLock = Mutex<()>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    pub path: PathBuf,
    pub name: String,
    pub text: String,
    pub bom: bool,
    pub version: String,
}

#[derive(Debug, Serialize)]
pub struct SaveError {
    kind: &'static str,
    message: String,
}

impl SaveError {
    fn io(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "io",
            message: err(error),
        }
    }

    fn conflict() -> Self {
        Self {
            kind: "conflict",
            message: "磁盘上的文件已变化".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub path: Option<PathBuf>,
    pub title: String,
    pub text: String,
    pub bom: bool,
    pub base_version: Option<String>,
    pub anchor: usize,
    pub head: usize,
    pub mode: String,
}

fn snapshot(path: PathBuf, bytes: Vec<u8>) -> Result<FileSnapshot, String> {
    let version = hash(&bytes);
    let (text, bom) = decode(bytes)?;
    let name = file_name(&path);
    Ok(FileSnapshot {
        path,
        name,
        text,
        bom,
        version,
    })
}

pub fn read(path: &Path) -> Result<FileSnapshot, String> {
    let path = canonical(path).map_err(err)?;
    let bytes = fs::read(&path).map_err(err)?;
    snapshot(path, bytes)
}

pub fn current_version(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(hash(&bytes))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(err(error)),
    }
}

fn write(
    path: &Path,
    text: &str,
    bom: bool,
    expected: Option<&str>,
) -> Result<FileSnapshot, SaveError> {
    let path = match canonical(path) {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(|| SaveError::io("缺少父目录"))?;
            let name = path
                .file_name()
                .ok_or_else(|| SaveError::io("缺少文件名"))?;
            canonical(parent).map_err(SaveError::io)?.join(name)
        }
        Err(error) => return Err(SaveError::io(error)),
    };
    let current = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(SaveError::io(error)),
    };
    if current.as_deref().map(hash).as_deref() != expected {
        return Err(SaveError::conflict());
    }
    let bytes = encode(text, bom);
    // 无变化时保留文件本身。首次保存用不覆盖的原子重命名处理同名竞争。
    if current.as_ref() != Some(&bytes) {
        if current.is_none() {
            use std::io::Write;
            let mut out =
                tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(SaveError::io)?;
            out.write_all(&bytes).map_err(SaveError::io)?;
            out.as_file().sync_all().map_err(SaveError::io)?;
            out.persist_noclobber(&path).map_err(|error| {
                if error.error.kind() == io::ErrorKind::AlreadyExists {
                    SaveError::conflict()
                } else {
                    SaveError::io(error)
                }
            })?;
            #[cfg(unix)]
            fs::File::open(path.parent().unwrap())
                .and_then(|dir| dir.sync_all())
                .map_err(SaveError::io)?;
        } else {
            atomic_write(&path, &bytes).map_err(SaveError::io)?;
        }
    }
    snapshot(path, bytes).map_err(SaveError::io)
}

#[tauri::command]
pub async fn open_document(path: PathBuf) -> Result<FileSnapshot, String> {
    read(&path)
}

#[tauri::command]
pub async fn document_version(path: PathBuf) -> Result<Option<String>, String> {
    current_version(&path)
}

#[tauri::command]
pub async fn save_document(
    path: PathBuf,
    text: String,
    bom: bool,
    expected: Option<String>,
    saves: State<'_, SaveLock>,
) -> Result<FileSnapshot, SaveError> {
    let _save = saves.lock().map_err(SaveError::io)?;
    write(&path, &text, bom, expected.as_deref())
}

#[tauri::command]
pub async fn load_recovery(store: State<'_, Store>) -> Result<Option<Recovery>, String> {
    store.read("recovery.json")
}

#[tauri::command]
pub async fn save_recovery(
    store: State<'_, Store>,
    recovery: Option<Recovery>,
) -> Result<(), String> {
    match recovery {
        Some(recovery) => store.write("recovery.json", &recovery),
        None => store.remove("recovery.json"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_roundtrip_and_external_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("笔记.md");
        let original = b"\xef\xbb\xbf# title\r\n\r\n-    list\nlast\r";
        fs::write(&path, original).unwrap();
        let before = read(&path).unwrap();
        let after = write(&path, &before.text, before.bom, Some(&before.version)).unwrap();
        assert_eq!(before.version, after.version);
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::write(&path, "外部编辑").unwrap();
        let error = write(&path, "本地修改", before.bom, Some(&before.version)).unwrap_err();
        assert_eq!(error.kind, "conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "外部编辑");
    }

    #[test]
    fn new_document_and_recovery_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("新笔记.md");
        let checksum = write(&path, "正文\r\n", false, None).unwrap().version;
        assert_eq!(current_version(&path).unwrap(), Some(checksum));
        let store = Store(dir.path().join("data"));
        let recovery = Recovery {
            path: Some(path),
            title: "新笔记.md".into(),
            text: "未完成".into(),
            bom: false,
            base_version: None,
            anchor: 2,
            head: 3,
            mode: "source".into(),
        };
        store.write("recovery.json", &recovery).unwrap();
        assert_eq!(
            store
                .read::<Option<Recovery>>("recovery.json")
                .unwrap()
                .unwrap()
                .text,
            "未完成"
        );
        store.remove("recovery.json").unwrap();
        assert!(
            store
                .read::<Option<Recovery>>("recovery.json")
                .unwrap()
                .is_none()
        );
    }
}
