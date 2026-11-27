use crate::store::{Store, atomic_write};
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
};
use uuid::Uuid;

const VERSION: u8 = 1;
const KEY_BYTES: usize = 32;
const HEADER: usize = 1 + NONCE_LEN;
const SOURCE: &str = "ai-credentials";
const MASTER: &str = "vault.key";

pub(super) fn account() -> String {
    format!("local-{}", Uuid::new_v4())
}

pub(super) fn is_local(account: &str) -> bool {
    account
        .strip_prefix("local-")
        .is_some_and(|id| Uuid::try_parse(id).is_ok())
}

fn record_path(store: &Store, account: &str) -> Result<PathBuf, String> {
    if !is_local(account) {
        return Err("密钥引用格式无效".into());
    }
    Ok(store.0.join(SOURCE).join(account))
}

fn master(store: &Store, create: bool) -> Result<LessSafeKey, String> {
    let dir = store.0.join(SOURCE);
    let path = dir.join(MASTER);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(&dir)
                .and_then(|_| fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)))
                .map_err(|_| "无法创建页屿密钥库")?;
            let mut bytes = [0; KEY_BYTES];
            SystemRandom::new()
                .fill(&mut bytes)
                .map_err(|_| "无法初始化页屿密钥库")?;
            let mut temp =
                tempfile::NamedTempFile::new_in(&dir).map_err(|_| "无法写入页屿密钥库")?;
            temp.write_all(&bytes)
                .and_then(|_| temp.as_file().sync_all())
                .map_err(|_| "无法写入页屿密钥库")?;
            // 多个进程同时首次写入时共用第一个生成的主密钥，绝不覆盖。
            match temp.persist_noclobber(&path) {
                Ok(_) => {
                    fs::File::open(&dir)
                        .and_then(|dir| dir.sync_all())
                        .map_err(|_| "无法保存页屿密钥库")?;
                    bytes.to_vec()
                }
                Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                    fs::read(&path).map_err(|_| "无法读取页屿密钥库")?
                }
                Err(_) => return Err("无法保存页屿密钥库".into()),
            }
        }
        Err(_) => return Err("无法读取页屿密钥库，请重新填写 API 密钥".into()),
    };
    UnboundKey::new(&AES_256_GCM, &bytes)
        .map(LessSafeKey::new)
        .map_err(|_| "页屿密钥库格式无效".into())
}

pub(super) fn set(store: &Store, account: &str, secret: &str) -> Result<(), String> {
    let path = record_path(store, account)?;
    let key = master(store, true)?;
    let mut nonce = [0; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "无法生成密钥记录随机值")?;
    let mut sealed = secret.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(account.as_bytes()),
        &mut sealed,
    )
    .map_err(|_| "无法加密 API 密钥")?;
    let mut data = vec![VERSION];
    data.extend(nonce);
    data.extend(sealed);
    atomic_write(&path, &data).map_err(|_| "无法保存 API 密钥".into())
}

pub(super) fn get(store: &Store, account: &str) -> Result<Option<String>, String> {
    let mut data = match fs::read(record_path(store, account)?) {
        Ok(data) => data,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取已保存的 API 密钥".into()),
    };
    let format_error = "已保存的 API 密钥无法读取，请重新填写";
    if data.first() != Some(&VERSION) || data.len() < HEADER + AES_256_GCM.tag_len() {
        return Err(format_error.into());
    }
    let nonce = Nonce::try_assume_unique_for_key(&data[1..HEADER]).map_err(|_| format_error)?;
    let plain = master(store, false)?
        .open_in_place(nonce, Aad::from(account.as_bytes()), &mut data[HEADER..])
        .map_err(|_| format_error)?;
    String::from_utf8(plain.to_vec())
        .map(Some)
        .map_err(|_| format_error.into())
}

pub(super) fn remove(store: &Store, account: &str) -> Result<(), String> {
    match fs::remove_file(record_path(store, account)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法删除页屿密钥记录".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_saved_secret_without_system_credentials_and_authenticates_each_record() {
        let temporary = tempfile::tempdir().unwrap();
        let store = Store(temporary.path().to_path_buf());
        let first = account();
        let second = account();
        assert_eq!(get(&store, &first).unwrap(), None);
        set(&store, &first, "vault-fixture-only").unwrap();
        let path = record_path(&store, &first).unwrap();
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            path.parent()
                .unwrap()
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            path.parent()
                .unwrap()
                .join(MASTER)
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(!String::from_utf8_lossy(&fs::read(&path).unwrap()).contains("vault-fixture-only"));
        assert_eq!(
            get(&store, &first).unwrap().as_deref(),
            Some("vault-fixture-only")
        );
        fs::copy(&path, record_path(&store, &second).unwrap()).unwrap();
        assert!(get(&store, &second).is_err());
        remove(&store, &first).unwrap();
        assert_eq!(get(&store, &first).unwrap(), None);
    }
}
