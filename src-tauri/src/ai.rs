use crate::store::{Store, err};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::{Client, Url};
use url::Host;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{State, ipc::Channel};
use tokio::sync::oneshot;

const SETTINGS_FILE: &str = "ai.json";

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Debug, Default, Deserialize, Serialize)]
struct Settings {
    endpoint: String,
    model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    endpoint: String,
    model: String,
    has_key: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Message {
    role: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Delta { text: String },
    Done,
    Cancelled,
}

pub fn safe_endpoint(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(err)?;
    let loopback = match url.host() {
        Some(Host::Domain(domain)) => domain == "localhost",
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.host().is_none() {
        return Err("地址须使用 HTTPS 或本机回环 HTTP，且不能包含用户名、密码或片段".into());
    }
    Ok(url)
}

fn completions(endpoint: &str) -> Result<Url, String> {
    let mut url = safe_endpoint(endpoint)?;
    let path = url.path().trim_end_matches('/');
    if !path.ends_with("/chat/completions") {
        let path = if path.is_empty() { "/v1/chat/completions".to_owned() }
            else { format!("{path}/chat/completions") };
        url.set_path(&path);
    }
    Ok(url)
}

fn credential(endpoint: &str) -> Result<keyring::Entry, String> {
    let key = blake3::hash(endpoint.as_bytes()).to_hex().to_string();
    // 调用方通过 get/set 显示系统凭据存储失败，绝不把凭据写到应用设置。
    keyring::Entry::new("io.yeyu.markdown.ai", &key).map_err(|error| format!("系统凭据存储不可用：{error}"))
}

fn password(endpoint: &str) -> Result<Option<String>, String> {
    match credential(endpoint)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("系统凭据存储不可用：{error}")),
    }
}

fn view(settings: Settings) -> View {
    let has_key = !settings.endpoint.is_empty() && password(&settings.endpoint).is_ok_and(|secret| secret.is_some());
    View { endpoint: settings.endpoint, model: settings.model, has_key }
}

#[tauri::command]
pub async fn ai_settings(store: State<'_, Store>) -> Result<View, String> {
    Ok(view(store.read(SETTINGS_FILE)?))
}

#[tauri::command]
pub async fn ai_config(endpoint: String, model: String, key: Option<String>, store: State<'_, Store>) -> Result<View, String> {
    let endpoint = completions(&endpoint)?.to_string();
    let model = model.trim().to_owned();
    if model.is_empty() {
        return Err("请填写模型名称".into());
    }
    if let Some(secret) = key {
        let entry = credential(&endpoint)?;
        if secret.trim().is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(error) => return Err(format!("删除系统凭据失败：{error}")),
            }
        } else {
            entry.set_password(secret.trim()).map_err(|error| format!("写入系统凭据失败：{error}"))?;
        }
    }
    let settings = Settings { endpoint, model };
    store.write(SETTINGS_FILE, &settings)?;
    Ok(view(settings))
}

async fn stream(http: &Client, settings: Settings, messages: Vec<Message>, event: &Channel<Event>) -> Result<(), String> {
    if settings.endpoint.is_empty() || settings.model.is_empty() {
        return Err("请先配置 AI 地址和模型".into());
    }
    let endpoint = completions(&settings.endpoint)?;
    let is_local_http = endpoint.scheme() == "http";
    let body: Vec<Value> = messages.into_iter().map(|message| json!({ "role": message.role, "content": message.text })).collect();
    let mut request = http.post(endpoint).timeout(Duration::from_secs(300))
        .header("Accept", "text/event-stream")
        .json(&json!({"model": settings.model, "messages": body, "stream": true}));
    match password(&settings.endpoint) {
        Ok(Some(key)) => request = request.bearer_auth(key),
        Ok(None) => {}
        Err(_) if is_local_http => {}
        Err(error) => return Err(error),
    }
    let response = request.send().await.map_err(|error| format!("无法连接模型服务：{}", error.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        let mut chunks = response.bytes_stream();
        let message = chunks.next().await.and_then(Result::ok).unwrap_or_default();
        let detail: String = String::from_utf8_lossy(&message).chars().take(500).collect();
        return Err(format!("模型服务返回 {status} {detail}"));
    }
    let mut events = response.bytes_stream().eventsource();
    let mut saw_delta = false;
    let mut complete = false;
    while let Some(frame) = events.next().await {
        let frame = frame.map_err(err)?;
        if frame.data.trim() == "[DONE]" {
            complete = true;
            break;
        }
        let data: Value = serde_json::from_str(&frame.data).map_err(err)?;
        if let Some(error) = data["error"]["message"].as_str() {
            return Err(error.chars().take(500).collect());
        }
        if let Some(text) = data["choices"][0]["delta"]["content"].as_str().filter(|text| !text.is_empty()) {
            event.send(Event::Delta { text: text.to_owned() }).map_err(err)?;
            saw_delta = true;
        }
        if data["choices"][0]["finish_reason"].is_string() {
            complete = true;
        }
    }
    if !saw_delta {
        return Err("模型未返回可用的流式文本".into());
    }
    if !complete {
        return Err("模型连接提前中断，请重试".into());
    }
    event.send(Event::Done).map_err(err)
}

#[tauri::command]
pub async fn ai_stream(id: String, messages: Vec<Message>, event: Channel<Event>, store: State<'_, Store>, jobs: State<'_, Jobs>, http: State<'_, Client>) -> Result<(), String> {
    let settings: Settings = store.read(SETTINGS_FILE)?;
    let (cancel, stop) = oneshot::channel();
    {
        let mut active = jobs.0.lock().map_err(err)?;
        if active.contains_key(&id) {
            return Err("生成任务已存在".into());
        }
        active.insert(id.clone(), cancel);
    }
    let result = tokio::select! {
        result = stream(&http, settings, messages, &event) => result,
        _ = stop => event.send(Event::Cancelled).map_err(err)
    };
    jobs.0.lock().map_err(err)?.remove(&id);
    result
}

#[tauri::command]
pub async fn ai_cancel(id: String, jobs: State<'_, Jobs>) -> Result<(), String> {
    if let Some(cancel) = jobs.0.lock().map_err(err)?.remove(&id) {
        let _ = cancel.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_endpoint_accepts_local_and_protects_credentials() {
        assert_eq!(completions("http://127.0.0.1:8081/").unwrap().as_str(), "http://127.0.0.1:8081/v1/chat/completions");
        assert_eq!(completions("https://example.org/v1/chat/completions").unwrap().as_str(), "https://example.org/v1/chat/completions");
        assert!(completions("http://example.org").is_err());
        assert!(completions("https://user@example.org").is_err());
    }
}
