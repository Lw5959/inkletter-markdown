use super::{Protocol, model_endpoint};
use crate::store::{Store, err};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Mutex};
use tauri::State;
use uuid::Uuid;

const SETTINGS_FILE: &str = "ai.json";

#[derive(Default)]
pub struct Models(Mutex<()>);

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    provider_id: String,
    model: String,
}

#[derive(Deserialize, Serialize)]
pub struct ProviderDraft {
    id: String,
    name: String,
    endpoint: String,
    protocol: Protocol,
    models: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct Provider {
    #[serde(flatten)]
    draft: ProviderDraft,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
struct Catalog {
    providers: Vec<Provider>,
    active: Option<Selection>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Existing {
    Catalog(Catalog),
    Single {
        endpoint: String,
        model: String,
        #[serde(default)]
        protocol: Protocol,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderView {
    #[serde(flatten)]
    draft: ProviderDraft,
    has_key: bool,
}

#[derive(Serialize)]
pub struct View {
    providers: Vec<ProviderView>,
    active: Option<Selection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
}

#[derive(Default)]
pub(super) struct Target {
    pub endpoint: String,
    pub protocol: Protocol,
    pub model: String,
    pub credential: Option<String>,
}

impl Catalog {
    fn provider(&self, id: &str) -> Result<&Provider, String> {
        self.providers
            .iter()
            .find(|provider| provider.draft.id == id)
            .ok_or_else(|| "该供应商已删除或尚未保存".into())
    }

    fn target(&self, selection: Selection) -> Result<Target, String> {
        let supplier = self.provider(&selection.provider_id)?;
        if !supplier.draft.models.contains(&selection.model) {
            return Err("该模型已移除，请重新选择".into());
        }
        Ok(Target {
            endpoint: supplier.draft.endpoint.clone(),
            protocol: supplier.draft.protocol,
            model: selection.model,
            credential: supplier.credential.clone(),
        })
    }

    fn pick_available(&mut self) {
        let preferred = self
            .active
            .as_ref()
            .and_then(|selection| self.provider(&selection.provider_id).ok());
        if self
            .active
            .as_ref()
            .zip(preferred)
            .is_some_and(|(selection, provider)| provider.draft.models.contains(&selection.model))
        {
            return;
        }
        self.active = preferred
            .or_else(|| self.providers.first())
            .and_then(|provider| {
                provider.draft.models.first().map(|model| Selection {
                    provider_id: provider.draft.id.clone(),
                    model: model.clone(),
                })
            });
    }

    fn view(self, notice: Option<String>) -> View {
        View {
            providers: self
                .providers
                .into_iter()
                .map(|provider| ProviderView {
                    draft: provider.draft,
                    has_key: provider.credential.is_some(),
                })
                .collect(),
            active: self.active,
            notice,
        }
    }
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("io.yeyu.markdown.ai", account)
        .map_err(|error| format!("系统凭据存储不可用：{error}"))
}

pub(super) fn password(account: Option<&str>) -> Result<Option<String>, String> {
    let Some(account) = account else {
        return Ok(None);
    };
    match entry(account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("系统凭据存储不可用：{error}")),
    }
}

fn read_catalog(store: &Store) -> Result<Catalog, String> {
    let mut catalog = match store.read::<Option<Existing>>(SETTINGS_FILE)? {
        Some(Existing::Catalog(catalog)) => catalog,
        Some(Existing::Single {
            endpoint,
            model,
            protocol,
        }) if !endpoint.is_empty() && !model.is_empty() => {
            // 旧版以地址摘要定位凭据。保留这个引用，迁移时无需读取并重新保存密钥。
            let account = blake3::hash(endpoint.as_bytes()).to_hex().to_string();
            let credential = (!matches!(password(Some(&account)), Ok(None))).then_some(account);
            let name = Url::parse(&endpoint)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| "原有供应商".into());
            Catalog {
                providers: vec![Provider {
                    draft: ProviderDraft {
                        id: "legacy".into(),
                        name,
                        endpoint,
                        protocol,
                        models: vec![model],
                    },
                    credential,
                }],
                active: None,
            }
        }
        _ => Catalog::default(),
    };
    catalog.pick_available();
    Ok(catalog)
}

fn retire_credential(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(err(error)),
    }
}

fn save_catalog(store: &Store, catalog: Catalog, retired: Option<String>) -> Result<View, String> {
    store.write(SETTINGS_FILE, &catalog)?;
    let notice = retired
        .and_then(|account| retire_credential(&account).err())
        .map(|error| format!("配置已保存，旧系统凭据清理失败：{error}"));
    Ok(catalog.view(notice))
}

fn normalize(draft: &mut ProviderDraft) -> Result<(), String> {
    draft.name = draft.name.trim().to_owned();
    if draft.name.is_empty() || draft.name.chars().any(char::is_control) {
        return Err("请填写供应商名称".into());
    }
    draft.endpoint = model_endpoint(&draft.endpoint, draft.protocol)?.to_string();
    let mut unique = HashSet::new();
    for model in &mut draft.models {
        *model = model.trim().to_owned();
        if model.is_empty() || model.chars().any(char::is_control) {
            return Err("请填写每个模型的 ID".into());
        }
        if !unique.insert(model.as_str()) {
            return Err(format!("模型 ID 重复：{model}"));
        }
    }
    if draft.models.is_empty() {
        return Err("请至少添加一个模型".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_settings(
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.0.lock().map_err(err)?;
    Ok(read_catalog(&store)?.view(None))
}

#[tauri::command]
pub async fn ai_provider_save(
    mut provider: ProviderDraft,
    key: Option<String>,
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.0.lock().map_err(err)?;
    let mut catalog = read_catalog(&store)?;
    normalize(&mut provider)?;
    let index = catalog
        .providers
        .iter()
        .position(|item| item.draft.id == provider.id);
    if index.is_none() && Uuid::parse_str(&provider.id).is_err() {
        return Err("供应商标识无效，请重新打开模型配置".into());
    }
    let previous = index.map(|index| &catalog.providers[index]);
    let mut created = None;
    let credential = match key.as_deref().map(str::trim) {
        Some("") => None,
        Some(secret) => {
            reqwest::header::HeaderValue::from_str(secret)
                .map_err(|_| "API 密钥含有无法发送的字符")?;
            let account = Uuid::new_v4().to_string();
            entry(&account)?
                .set_password(secret)
                .map_err(|error| format!("写入系统凭据失败：{error}"))?;
            created = Some(account.clone());
            Some(account)
        }
        // 供应商更换地址时要求明确提供新密钥，避免把已有密钥发到另一个服务。
        None => previous
            .filter(|item| {
                item.draft.endpoint == provider.endpoint && item.draft.protocol == provider.protocol
            })
            .and_then(|item| item.credential.clone()),
    };
    let retired = previous
        .and_then(|item| item.credential.clone())
        .filter(|old| Some(old) != credential.as_ref());
    let next = Provider {
        draft: provider,
        credential,
    };
    if let Some(index) = index {
        catalog.providers[index] = next
    } else {
        catalog.providers.push(next)
    }
    catalog.pick_available();
    match save_catalog(&store, catalog, retired) {
        Ok(view) => Ok(view),
        Err(error) => {
            // 若元数据未写入，回收这次创建的凭据。已提交的新引用需要保留。
            if let Some(account) = created
                && read_catalog(&store).is_ok_and(|catalog| {
                    catalog
                        .providers
                        .iter()
                        .all(|item| item.credential.as_ref() != Some(&account))
                })
            {
                retire_credential(&account)
                    .map_err(|cleanup| format!("{error}。回收新系统凭据失败：{cleanup}"))?;
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn ai_provider_remove(
    id: String,
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.0.lock().map_err(err)?;
    let mut catalog = read_catalog(&store)?;
    let index = catalog
        .providers
        .iter()
        .position(|item| item.draft.id == id)
        .ok_or("该供应商已删除")?;
    let retired = catalog.providers.remove(index).credential;
    catalog.pick_available();
    save_catalog(&store, catalog, retired)
}

#[tauri::command]
pub async fn ai_model_select(
    selection: Selection,
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.0.lock().map_err(err)?;
    let mut catalog = read_catalog(&store)?;
    catalog.target(selection.clone())?;
    if catalog.active.as_ref() != Some(&selection) {
        catalog.active = Some(selection);
        store.write(SETTINGS_FILE, &catalog)?;
    }
    Ok(catalog.view(None))
}

pub(super) fn target(
    store: &Store,
    models: &Models,
    selection: Selection,
) -> Result<Target, String> {
    let _guard = models.0.lock().map_err(err)?;
    read_catalog(store)?.target(selection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_routes_shared_model_ids_to_the_selected_provider() {
        let mut catalog: Catalog = serde_json::from_value(json!({
            "providers": [
                {"id":"local", "name":"本地", "endpoint":"http://localhost:8080/v1/chat/completions", "protocol":"chat", "models":["shared", "backup"]},
                {"id":"cloud", "name":"远端", "endpoint":"https://example.test/v1/responses", "protocol":"responses", "models":["shared"], "credential":"system-account"}
            ],
            "active": {"providerId":"cloud", "model":"shared"}
        })).unwrap();
        let active = catalog.active.clone().unwrap();
        let target = catalog.target(active.clone()).unwrap();
        assert_eq!(target.protocol, Protocol::Responses);
        assert_eq!(target.credential.as_deref(), Some("system-account"));
        catalog.providers.remove(1);
        assert!(catalog.target(active).is_err());
        catalog.pick_available();
        let target = catalog.target(catalog.active.clone().unwrap()).unwrap();
        assert_eq!(target.protocol, Protocol::Chat);
        assert_eq!(target.credential, None);
        assert_eq!(target.model, "shared");
        catalog.providers[0].draft.models.remove(0);
        catalog.pick_available();
        assert_eq!(catalog.active.unwrap().model, "backup");
    }
}
