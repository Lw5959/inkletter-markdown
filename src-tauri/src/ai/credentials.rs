#[cfg(not(target_os = "android"))]
#[derive(Default)]
pub(super) struct Credentials;

#[cfg(not(target_os = "android"))]
impl Credentials {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new("io.yeyu.markdown.ai", account)
            .map_err(|error| format!("系统凭据存储不可用：{error}"))
    }

    pub(super) fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("系统凭据存储不可用：{error}")),
        }
    }

    pub(super) fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        Self::entry(account)?
            .set_password(secret)
            .map_err(|error| format!("写入系统凭据失败：{error}"))
    }

    pub(super) fn remove(&self, account: &str) -> Result<(), String> {
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
    pub(super) fn get(&self, account: &str) -> Result<Option<String>, String> {
        #[derive(serde::Deserialize)]
        struct Response {
            secret: Option<String>,
        }

        self.0
            .run_mobile_plugin::<Response>("readSecret", serde_json::json!({ "account": account }))
            .map(|response| response.secret)
            .map_err(|_| "无法读取 Android 系统凭据，请重新填写密钥".into())
    }

    pub(super) fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin(
                "writeSecret",
                serde_json::json!({ "account": account, "secret": secret }),
            )
            .map_err(|_| "无法写入 Android 系统凭据".into())
    }

    pub(super) fn remove(&self, account: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("deleteSecret", serde_json::json!({ "account": account }))
            .map_err(|_| "无法删除 Android 系统凭据".into())
    }
}
