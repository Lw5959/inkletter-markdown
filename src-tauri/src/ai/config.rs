use super::{
    Protocol,
    credentials::Credentials,
    model_endpoint,
    models::{Metadata, Options},
    reasoning::Effort,
};
use crate::store::{Store, err};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Mutex,
};
use tauri::State;
use uuid::Uuid;

const SETTINGS_FILE: &str = "ai.json";

#[cfg_attr(not(target_os = "android"), derive(Default))]
pub struct Models {
    lock: Mutex<()>,
    credentials: Credentials,
}

#[cfg(target_os = "android")]
pub(crate) fn android_credentials() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Manager;
    tauri::plugin::Builder::new("android-ai-credentials")
        .setup(|app, api| {
            let plugin = api.register_android_plugin("io.yeyu.markdown", "AiCredentials")?;
            app.manage(Models {
                lock: Mutex::new(()),
                credentials: Credentials(plugin),
            });
            Ok(())
        })
        .build()
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    provider_id: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<Effort>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDraft {
    id: String,
    name: String,
    endpoint: String,
    protocol: Protocol,
    models: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    model_options: BTreeMap<String, Options>,
}

#[derive(Deserialize, Serialize)]
struct Provider {
    #[serde(flatten)]
    draft: ProviderDraft,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
    #[cfg(target_os = "macos")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_account: Option<String>,
}

#[cfg(target_os = "macos")]
impl Provider {
    fn migration_account(&self) -> Option<&str> {
        self.credential
            .as_deref()
            .filter(|account| !super::vault::is_local(account))
            .or(self.legacy_account.as_deref())
    }
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    legacy_key: bool,
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
    pub reasoning_effort: Option<Effort>,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub image_input: Option<bool>,
    pub input_modalities: Option<Vec<String>>,
    pub credential: Option<String>,
}

impl Target {
    pub fn accepts_image(&self, media_type: &str) -> Option<bool> {
        self.image_input.or_else(|| {
            Some(
                self.input_modalities
                    .as_ref()?
                    .iter()
                    .any(|mode| matches!(mode.as_str(), "image" | "image/*") || mode == media_type),
            )
        })
    }
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
        let options = supplier.draft.model_options.get(&selection.model);
        Ok(Target {
            endpoint: supplier.draft.endpoint.clone(),
            protocol: supplier.draft.protocol,
            model: selection.model,
            reasoning_effort: selection
                .reasoning_effort
                .or_else(|| options?.reasoning_effort),
            input_tokens: options.and_then(Options::input_limit),
            output_tokens: options.and_then(Options::output_limit),
            image_input: options.and_then(|options| options.image_input),
            input_modalities: options
                .and_then(|options| options.detected.as_ref()?.input_modalities.clone()),
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
                    reasoning_effort: None,
                })
            });
    }

    fn view(mut self, notice: Option<String>) -> View {
        // 当前强度随选中的模型返回，模型选项表保存各个模型自己的偏好。
        let effort = self.active.as_ref().and_then(|selection| {
            self.provider(&selection.provider_id)
                .ok()?
                .draft
                .model_options
                .get(&selection.model)?
                .reasoning_effort
        });
        if let Some(active) = &mut self.active {
            active.reasoning_effort = effort;
        }
        View {
            providers: self
                .providers
                .into_iter()
                .map(|provider| ProviderView {
                    #[cfg(target_os = "macos")]
                    legacy_key: provider.migration_account().is_some(),
                    #[cfg(not(target_os = "macos"))]
                    legacy_key: false,
                    has_key: provider.credential.is_some(),
                    draft: provider.draft,
                })
                .collect(),
            active: self.active,
            notice,
        }
    }
}

fn read_catalog(store: &Store, _credentials: &Credentials) -> Result<Catalog, String> {
    let mut catalog = match store.read::<Option<Existing>>(SETTINGS_FILE)? {
        Some(Existing::Catalog(catalog)) => catalog,
        Some(Existing::Single {
            endpoint,
            model,
            protocol,
        }) if !endpoint.is_empty() && !model.is_empty() => {
            // 单模型配置以原地址摘要定位凭据。macOS 保留候选引用，启动不探测钥匙串。
            let account = blake3::hash(endpoint.as_bytes()).to_hex().to_string();
            #[cfg(not(target_os = "macos"))]
            let credential =
                (!matches!(_credentials.get(store, &account), Ok(None))).then_some(account);
            #[cfg(target_os = "macos")]
            let credential = None;
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
                        model_options: BTreeMap::new(),
                    },
                    credential,
                    #[cfg(target_os = "macos")]
                    legacy_account: Some(account),
                }],
                active: None,
            }
        }
        _ => Catalog::default(),
    };
    catalog.pick_available();
    Ok(catalog)
}

fn save_catalog(
    store: &Store,
    credentials: &Credentials,
    catalog: Catalog,
    retired: Option<String>,
) -> Result<View, String> {
    store.write(SETTINGS_FILE, &catalog)?;
    let notice = retired
        .and_then(|account| credentials.remove(store, &account).err())
        .map(|error| format!("配置已保存，旧密钥清理失败：{error}"));
    Ok(catalog.view(notice))
}

fn normalize(draft: &mut ProviderDraft) -> Result<(), String> {
    draft.name = draft.name.trim().to_owned();
    if draft.name.is_empty() || draft.name.chars().any(char::is_control) {
        return Err("请填写供应商名称".into());
    }
    draft.endpoint = model_endpoint(&draft.endpoint, draft.protocol)?.to_string();
    if draft.models.is_empty() {
        return Err("请至少添加一个模型".into());
    }
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
    draft
        .model_options
        .retain(|id, _| unique.contains(id.as_str()));
    for (id, options) in &mut draft.model_options {
        if let Some(name) = options.display_name.take() {
            let name = name.trim();
            if name.chars().any(char::is_control) || name.chars().count() > 128 {
                return Err(format!("模型 {id} 的显示名须在 128 个字符以内"));
            }
            if !name.is_empty() {
                options.display_name = Some(name.to_owned());
            }
        }
        if options.input_tokens == Some(0) || options.output_tokens == Some(0) {
            return Err(format!("模型 {id} 的输入、输出上限须为正整数"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_settings(
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.lock.lock().map_err(err)?;
    Ok(read_catalog(&store, &models.credentials)?.view(None))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedModel {
    provider_id: String,
    endpoint: String,
    protocol: Protocol,
    model: String,
    metadata: Metadata,
}

#[tauri::command]
pub async fn ai_model_metadata(
    mut request: DetectedModel,
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.lock.lock().map_err(err)?;
    let mut catalog = read_catalog(&store, &models.credentials)?;
    let provider = catalog
        .providers
        .iter_mut()
        .find(|item| item.draft.id == request.provider_id)
        .ok_or("供应商已移除")?;
    // 查询后仅补规格。其他文档窗口可能已更改地址、模型设置或密钥。
    if provider.draft.endpoint != request.endpoint
        || provider.draft.protocol != request.protocol
        || !provider.draft.models.contains(&request.model)
    {
        return Err("模型配置已变化，请重新获取规格".into());
    }
    let options = provider
        .draft
        .model_options
        .entry(request.model)
        .or_default();
    if let Some(previous) = options.detected.take() {
        request.metadata.fill_missing(previous);
    }
    options.detected = Some(request.metadata);
    store.write(SETTINGS_FILE, &catalog)?;
    Ok(catalog.view(None))
}

#[tauri::command]
pub async fn ai_provider_save(
    mut provider: ProviderDraft,
    key: Option<String>,
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.lock.lock().map_err(err)?;
    let mut catalog = read_catalog(&store, &models.credentials)?;
    normalize(&mut provider)?;
    let index = catalog
        .providers
        .iter()
        .position(|item| item.draft.id == provider.id);
    if index.is_none() && Uuid::parse_str(&provider.id).is_err() {
        return Err("供应商标识无效，请重新打开模型配置".into());
    }
    let previous = index.map(|index| &catalog.providers[index]);
    let keep = previous.filter(|item| {
        item.draft.protocol == provider.protocol
            && model_endpoint(&item.draft.endpoint, item.draft.protocol)
                .is_ok_and(|endpoint| endpoint.as_str() == provider.endpoint)
    });
    let mut created = None;
    let credential = match key.as_deref().map(str::trim) {
        Some("") => None,
        Some(secret) => {
            reqwest::header::HeaderValue::from_str(secret)
                .map_err(|_| "API 密钥含有无法发送的字符")?;
            #[cfg(target_os = "macos")]
            let account = super::vault::account();
            #[cfg(not(target_os = "macos"))]
            let account = Uuid::new_v4().to_string();
            models.credentials.set(&store, &account, secret)?;
            created = Some(account.clone());
            Some(account)
        }
        // 供应商更换地址时要求明确提供新密钥，避免把已有密钥发到另一个服务。
        None => keep.and_then(|item| item.credential.clone()),
    };
    let retired = previous
        .and_then(|item| item.credential.clone())
        .filter(|old| Some(old) != credential.as_ref());
    let next = Provider {
        draft: provider,
        credential,
        #[cfg(target_os = "macos")]
        legacy_account: if key.is_none() {
            keep.and_then(|item| item.legacy_account.clone())
        } else {
            None
        },
    };
    if let Some(index) = index {
        catalog.providers[index] = next
    } else {
        catalog.providers.push(next)
    }
    catalog.pick_available();
    save_with_created(&store, &models.credentials, catalog, retired, created)
}

fn save_with_created(
    store: &Store,
    credentials: &Credentials,
    catalog: Catalog,
    retired: Option<String>,
    created: Option<String>,
) -> Result<View, String> {
    match save_catalog(store, credentials, catalog, retired) {
        Ok(view) => Ok(view),
        Err(error) => {
            // 若元数据未写入，回收这次创建的凭据。已提交的新引用需要保留。
            if let Some(account) = created
                && read_catalog(store, credentials).is_ok_and(|catalog| {
                    catalog
                        .providers
                        .iter()
                        .all(|item| item.credential.as_ref() != Some(&account))
                })
            {
                credentials
                    .remove(store, &account)
                    .map_err(|cleanup| format!("{error}。回收新密钥失败：{cleanup}"))?;
            }
            Err(error)
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn ai_key_migrate(
    id: String,
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let (account, endpoint, protocol) = {
        let _guard = models.lock.lock().map_err(err)?;
        let catalog = read_catalog(&store, &models.credentials)?;
        let provider = catalog.provider(&id)?;
        (
            provider
                .migration_account()
                .ok_or("此供应商没有待迁移的密钥")?
                .to_owned(),
            provider.draft.endpoint.clone(),
            provider.draft.protocol,
        )
    };
    let legacy = account.clone();
    let secret = tauri::async_runtime::spawn_blocking(move || Credentials::legacy_get(&legacy))
        .await
        .map_err(err)??
        .ok_or("在钥匙串中未找到旧密钥，请重新填写 API 密钥")?;
    let _guard = models.lock.lock().map_err(err)?;
    let mut catalog = read_catalog(&store, &models.credentials)?;
    let provider = catalog
        .providers
        .iter_mut()
        .find(|provider| provider.draft.id == id)
        .ok_or("供应商已移除")?;
    if provider.migration_account() != Some(&account)
        || provider.draft.endpoint != endpoint
        || provider.draft.protocol != protocol
    {
        return Err("供应商配置已改动，请重新打开模型配置".into());
    }
    let local = super::vault::account();
    models.credentials.set(&store, &local, &secret)?;
    provider.credential = Some(local.clone());
    provider.legacy_account = None;
    save_with_created(&store, &models.credentials, catalog, None, Some(local))
}

#[tauri::command]
pub async fn ai_provider_remove(
    id: String,
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.lock.lock().map_err(err)?;
    let mut catalog = read_catalog(&store, &models.credentials)?;
    let index = catalog
        .providers
        .iter()
        .position(|item| item.draft.id == id)
        .ok_or("该供应商已删除")?;
    let retired = catalog.providers.remove(index).credential;
    catalog.pick_available();
    save_catalog(&store, &models.credentials, catalog, retired)
}

#[tauri::command]
pub async fn ai_model_select(
    mut selection: Selection,
    update_effort: Option<bool>,
    store: State<'_, Store>,
    models: State<'_, Models>,
) -> Result<View, String> {
    let _guard = models.lock.lock().map_err(err)?;
    let mut catalog = read_catalog(&store, &models.credentials)?;
    catalog.target(selection.clone())?;
    let effort = selection.reasoning_effort.take();
    let update_effort = update_effort.unwrap_or_default();
    if update_effort {
        let provider = catalog
            .providers
            .iter_mut()
            .find(|provider| provider.draft.id == selection.provider_id)
            .ok_or("该供应商已删除或尚未保存")?;
        provider
            .draft
            .model_options
            .entry(selection.model.clone())
            .or_default()
            .reasoning_effort = effort;
    }
    if update_effort || catalog.active.as_ref() != Some(&selection) {
        catalog.active = Some(selection);
        store.write(SETTINGS_FILE, &catalog)?;
    }
    Ok(catalog.view(None))
}

pub(super) fn target(
    store: &Store,
    models: &Models,
    selection: Selection,
) -> Result<(Target, Url, Option<String>), String> {
    let _guard = models.lock.lock().map_err(err)?;
    let settings = read_catalog(store, &models.credentials)?.target(selection)?;
    let endpoint = model_endpoint(&settings.endpoint, settings.protocol)?;
    // 在同一把锁内读取配置和凭据，避免开始请求时引用已被并发保存删除。
    let key = credential_key(store, models, settings.credential.as_deref(), &endpoint)?;
    Ok((settings, endpoint, key))
}

fn credential_key(
    store: &Store,
    models: &Models,
    account: Option<&str>,
    _endpoint: &Url,
) -> Result<Option<String>, String> {
    let Some(account) = account else {
        return Ok(None);
    };
    #[cfg(target_os = "macos")]
    if !super::vault::is_local(account) {
        return Err("请在模型配置中迁移旧密钥，或重新填写 API 密钥".into());
    }
    match models.credentials.get(store, account) {
        #[cfg(not(any(target_os = "android", target_os = "macos")))]
        Err(_) if _endpoint.scheme() == "http" && super::is_loopback(_endpoint) => Ok(None),
        #[cfg(any(target_os = "android", target_os = "macos"))]
        Ok(None) => Err("已找不到此 API 密钥，请重新填写".into()),
        result => result,
    }
}

pub(super) fn discovery_key(
    store: &Store,
    models: &Models,
    id: &str,
    protocol: Protocol,
    endpoint: &Url,
) -> Result<Option<String>, String> {
    let _guard = models.lock.lock().map_err(err)?;
    let catalog = read_catalog(store, &models.credentials)?;
    let Ok(provider) = catalog.provider(id) else {
        return Ok(None);
    };
    if provider.draft.protocol != protocol
        || model_endpoint(&provider.draft.endpoint, protocol)? != *endpoint
    {
        return Ok(None);
    }
    credential_key(store, models, provider.credential.as_deref(), endpoint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_routes_shared_model_ids_to_the_selected_provider() {
        let mut catalog: Catalog = serde_json::from_value(json!({
            "providers": [
                {"id":"local", "name":"本地", "endpoint":"http://localhost:8080/v1/chat/completions", "protocol":"chat", "models":["shared", "backup"],
                 "modelOptions":{"shared":{"displayName":"本地写作","outputTokens":2048,"reasoningEffort":"low","detected":{"contextTokens":16000,"outputTokens":4000}},
                 "backup":{"inputTokens":8000,"reasoningEffort":"high"}}},
                {"id":"cloud", "name":"远端", "endpoint":"https://example.test/v1/responses", "protocol":"responses", "models":["shared"], "credential":"system-account"}
            ],
            "active": {"providerId":"cloud", "model":"shared"}
        })).unwrap();
        let active = catalog.active.clone().unwrap();
        let target = catalog.target(active.clone()).unwrap();
        assert_eq!(target.protocol, Protocol::Responses);
        assert_eq!(target.credential.as_deref(), Some("system-account"));
        assert_eq!(target.reasoning_effort, None);
        catalog.providers.remove(1);
        assert!(catalog.target(active).is_err());
        catalog.pick_available();
        let target = catalog.target(catalog.active.clone().unwrap()).unwrap();
        assert_eq!(target.protocol, Protocol::Chat);
        assert_eq!(target.credential, None);
        assert_eq!(target.model, "shared");
        assert_eq!(target.reasoning_effort, Some(Effort::Low));
        assert_eq!(target.input_tokens, Some(13_952));
        assert_eq!(target.output_tokens, Some(2_048));
        catalog = serde_json::from_value(serde_json::to_value(&catalog).unwrap()).unwrap();
        catalog.providers[0].draft.models.remove(0);
        catalog.pick_available();
        let active = catalog.view(None).active.unwrap();
        assert_eq!(active.model, "backup");
        assert_eq!(active.reasoning_effort, Some(Effort::High));
    }
}
