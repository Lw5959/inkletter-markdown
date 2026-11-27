use crate::store::Store;

#[cfg(not(target_os = "android"))]
#[derive(Default)]
pub(super) struct Credentials;

#[cfg(not(target_os = "android"))]
impl Credentials {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new("io.yeyu.markdown.ai", account)
            .map_err(|error| format!("系统凭据存储不可用：{error}"))
    }

    fn system_get(account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("系统凭据存储不可用：{error}")),
        }
    }

    pub(super) fn get(&self, _store: &Store, account: &str) -> Result<Option<String>, String> {
        #[cfg(target_os = "macos")]
        return super::vault::get(_store, account);
        #[cfg(not(target_os = "macos"))]
        Self::system_get(account)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn legacy_get(account: &str) -> Result<Option<String>, String> {
        // 仅由用户主动点击迁移调用，普通保存和请求不访问钥匙串。
        Self::system_get(account)
    }

    pub(super) fn set(&self, _store: &Store, account: &str, secret: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        return super::vault::set(_store, account, secret);
        #[cfg(not(target_os = "macos"))]
        Self::entry(account)?
            .set_password(secret)
            .map_err(|error| format!("写入系统凭据失败：{error}"))
    }

    pub(super) fn remove(&self, _store: &Store, account: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        return if super::vault::is_local(account) {
            super::vault::remove(_store, account)
        } else {
            Ok(())
        };
        #[cfg(not(target_os = "macos"))]
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(target_os = "android")]
pub(super) struct Credentials(pub(super) tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
impl Credentials {
    pub(super) fn get(&self, _store: &Store, account: &str) -> Result<Option<String>, String> {
        #[derive(serde::Deserialize)]
        struct Response {
            secret: Option<String>,
        }

        self.0
            .run_mobile_plugin::<Response>("readSecret", serde_json::json!({ "account": account }))
            .map(|response| response.secret)
            .map_err(|_| "无法读取 Android 系统凭据，请重新填写密钥".into())
    }

    pub(super) fn set(&self, _store: &Store, account: &str, secret: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin(
                "writeSecret",
                serde_json::json!({ "account": account, "secret": secret }),
            )
            .map_err(|_| "无法写入 Android 系统凭据".into())
    }

    pub(super) fn remove(&self, _store: &Store, account: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("deleteSecret", serde_json::json!({ "account": account }))
            .map_err(|_| "无法删除 Android 系统凭据".into())
    }
}
