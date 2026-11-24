use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Store(pub PathBuf);

impl Store {
    pub fn read<T: DeserializeOwned + Default>(&self, name: &str) -> Result<T, String> {
        match fs::read(self.0.join(name)) {
            Ok(data) => serde_json::from_slice(&data).map_err(err),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(T::default()),
            Err(error) => Err(err(error)),
        }
    }

    pub fn write<T: Serialize>(&self, name: &str, data: &T) -> Result<(), String> {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().ok_or("缺少应用数据目录")?).map_err(err)?;
        atomic_write(&path, &serde_json::to_vec(data).map_err(err)?).map_err(err)
    }

    pub fn remove(&self, name: &str) -> Result<(), String> {
        match fs::remove_file(self.0.join(name)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(err(error)),
        }
    }
}

pub fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    // 去除 Windows 的 extended-length 前缀，让对话框、URL 和跨进程路径一致。
    dunce::canonicalize(path)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("缺少父目录"))?;
    let mut out = tempfile::NamedTempFile::new_in(parent)?;
    out.write_all(bytes)?;
    if let Ok(metadata) = fs::metadata(path) {
        out.as_file().set_permissions(metadata.permissions())?;
    }
    out.as_file().sync_all()?;
    out.persist(path)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
