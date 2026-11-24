use crate::store::{Store, err};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder, Url, header::HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{State, ipc::Channel};
use tokio::sync::oneshot;
use url::Host;

const SETTINGS_FILE: &str = "ai.json";

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Chat,
    Anthropic,
    Responses,
}

impl Protocol {
    fn path(self) -> &'static str {
        match self {
            Self::Chat => "/chat/completions",
            Self::Anthropic => "/messages",
            Self::Responses => "/responses",
        }
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct Settings {
    endpoint: String,
    model: String,
    #[serde(default)]
    protocol: Protocol,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    endpoint: String,
    model: String,
    protocol: Protocol,
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
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host().is_none()
    {
        return Err("地址须使用 HTTPS 或本机回环 HTTP，且不能包含用户名、密码或片段".into());
    }
    Ok(url)
}

fn model_endpoint(endpoint: &str, protocol: Protocol) -> Result<Url, String> {
    let mut url = safe_endpoint(endpoint)?;
    let path = url.path().trim_end_matches('/');
    if path.ends_with(protocol.path()) {
        return Ok(url);
    }
    // 配置页允许输入服务根地址、API 前缀或完整地址；切协议时复用原有前缀。
    let prefix = if path.is_empty() {
        "/v1"
    } else {
        [Protocol::Chat, Protocol::Anthropic, Protocol::Responses]
            .iter()
            .find_map(|known| path.strip_suffix(known.path()))
            .unwrap_or(path)
    };
    url.set_path(&format!("{prefix}{}", protocol.path()));
    Ok(url)
}

fn credential(endpoint: &str) -> Result<keyring::Entry, String> {
    let key = blake3::hash(endpoint.as_bytes()).to_hex().to_string();
    // 调用方通过 get/set 显示系统凭据存储失败，绝不把凭据写到应用设置。
    keyring::Entry::new("io.yeyu.markdown.ai", &key)
        .map_err(|error| format!("系统凭据存储不可用：{error}"))
}

fn password(endpoint: &str) -> Result<Option<String>, String> {
    match credential(endpoint)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("系统凭据存储不可用：{error}")),
    }
}

fn view(settings: Settings) -> View {
    let has_key = !settings.endpoint.is_empty()
        && password(&settings.endpoint).is_ok_and(|secret| secret.is_some());
    View {
        endpoint: settings.endpoint,
        model: settings.model,
        protocol: settings.protocol,
        has_key,
    }
}

#[tauri::command]
pub async fn ai_settings(store: State<'_, Store>) -> Result<View, String> {
    Ok(view(store.read(SETTINGS_FILE)?))
}

#[tauri::command]
pub async fn ai_config(
    endpoint: String,
    model: String,
    key: Option<String>,
    protocol: Option<Protocol>,
    store: State<'_, Store>,
) -> Result<View, String> {
    let protocol = protocol.unwrap_or_default();
    let endpoint = model_endpoint(&endpoint, protocol)?.to_string();
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
            entry
                .set_password(secret.trim())
                .map_err(|error| format!("写入系统凭据失败：{error}"))?;
        }
    }
    let settings = Settings {
        endpoint,
        model,
        protocol,
    };
    store.write(SETTINGS_FILE, &settings)?;
    Ok(view(settings))
}

fn model_request(
    http: &Client,
    endpoint: Url,
    settings: &Settings,
    messages: &[Message],
    key: Option<String>,
) -> Result<RequestBuilder, String> {
    let protocol = settings.protocol;
    let conversation: Vec<Value> = messages
        .iter()
        .filter(|message| protocol == Protocol::Chat || message.role != "system")
        .map(|message| json!({ "role": message.role, "content": message.text }))
        .collect();
    let system = || {
        messages
            .iter()
            .filter(|message| message.role == "system")
            .map(|message| message.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let model = &settings.model;
    let body = match protocol {
        Protocol::Chat => json!({ "model": model, "messages": conversation, "stream": true }),
        Protocol::Anthropic => json!({
            "model": model, "messages": conversation, "system": system(), "max_tokens": 4096, "stream": true
        }),
        Protocol::Responses => json!({
            "model": model, "input": conversation, "instructions": system(), "store": false, "stream": true
        }),
    };
    let request = http
        .post(endpoint)
        .timeout(Duration::from_secs(300))
        .header("Accept", "text/event-stream")
        .json(&body);
    if protocol == Protocol::Anthropic {
        let request = request.header("anthropic-version", "2023-06-01");
        if let Some(key) = key {
            let mut value = HeaderValue::from_str(&key).map_err(err)?;
            value.set_sensitive(true);
            return Ok(request.header("x-api-key", value));
        }
        return Ok(request);
    }
    Ok(match key {
        Some(key) => request.bearer_auth(key),
        None => request,
    })
}

fn model_event<'a>(
    protocol: Protocol,
    event_name: &str,
    data: &'a Value,
) -> Result<(Option<&'a str>, bool), String> {
    if let Some(error) = data["error"]["message"].as_str() {
        return Err(error.chars().take(500).collect());
    }
    let kind = data["type"].as_str().unwrap_or(event_name);
    if kind == "error" {
        return Err(data["message"]
            .as_str()
            .unwrap_or("模型服务返回流式错误")
            .chars()
            .take(500)
            .collect());
    }
    // 截断、拒绝或工具调用不能作为完整改稿进入差异审阅。
    let incomplete = "模型未完整返回写作内容，请调整请求后重试";
    match protocol {
        Protocol::Chat => {
            let choice = &data["choices"][0];
            let stop = choice["finish_reason"].as_str();
            if matches!(
                stop,
                Some("length" | "content_filter" | "tool_calls" | "function_call")
            ) || choice["delta"]["refusal"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
            {
                return Err(incomplete.into());
            }
            Ok((choice["delta"]["content"].as_str(), stop.is_some()))
        }
        Protocol::Anthropic => match kind {
            "content_block_start" if data["content_block"]["type"] == "text" => {
                Ok((data["content_block"]["text"].as_str(), false))
            }
            "content_block_delta" if data["delta"]["type"] == "text_delta" => {
                Ok((data["delta"]["text"].as_str(), false))
            }
            "message_delta"
                if matches!(
                    data["delta"]["stop_reason"].as_str(),
                    Some(
                        "max_tokens"
                            | "model_context_window_exceeded"
                            | "refusal"
                            | "tool_use"
                            | "pause_turn"
                    )
                ) =>
            {
                Err(incomplete.into())
            }
            "message_stop" => Ok((None, true)),
            _ => Ok((None, false)),
        },
        Protocol::Responses => match kind {
            "response.output_text.delta" => Ok((data["delta"].as_str(), false)),
            "response.completed" => Ok((None, true)),
            "response.failed" => Err(data["response"]["error"]["message"]
                .as_str()
                .unwrap_or("模型生成失败")
                .chars()
                .take(500)
                .collect()),
            "response.incomplete" | "response.refusal.delta" | "response.refusal.done" => {
                Err(incomplete.into())
            }
            _ => Ok((None, false)),
        },
    }
}

async fn stream(
    http: &Client,
    settings: Settings,
    messages: Vec<Message>,
    event: &Channel<Event>,
) -> Result<(), String> {
    if settings.endpoint.is_empty() || settings.model.is_empty() {
        return Err("请先配置 AI 地址和模型".into());
    }
    let endpoint = model_endpoint(&settings.endpoint, settings.protocol)?;
    let key = match password(&settings.endpoint) {
        Ok(secret) => secret,
        Err(_) if endpoint.scheme() == "http" => None,
        Err(error) => return Err(error),
    };
    let request = model_request(http, endpoint, &settings, &messages, key)?;
    let response = request
        .send()
        .await
        .map_err(|error| format!("无法连接模型服务：{}", error.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        let mut chunks = response.bytes_stream();
        let message = chunks.next().await.and_then(Result::ok).unwrap_or_default();
        let detail: String = String::from_utf8_lossy(&message)
            .chars()
            .take(500)
            .collect();
        return Err(format!("模型服务返回 {status} {detail}"));
    }
    let mut events = response.bytes_stream().eventsource();
    let mut saw_delta = false;
    let mut complete = false;
    while let Some(frame) = events.next().await {
        let frame = frame.map_err(err)?;
        if frame.data.trim() == "[DONE]" {
            complete |= settings.protocol == Protocol::Chat;
            break;
        }
        let data: Value = serde_json::from_str(&frame.data).map_err(err)?;
        let (delta, finished) = model_event(settings.protocol, &frame.event, &data)?;
        if let Some(text) = delta.filter(|text| !text.is_empty()) {
            event
                .send(Event::Delta {
                    text: text.to_owned(),
                })
                .map_err(err)?;
            saw_delta = true;
        }
        if finished {
            complete = true;
            break;
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
pub async fn ai_stream(
    id: String,
    messages: Vec<Message>,
    event: Channel<Event>,
    store: State<'_, Store>,
    jobs: State<'_, Jobs>,
    http: State<'_, Client>,
) -> Result<(), String> {
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
    fn endpoint_accepts_local_and_preserves_api_prefix() {
        assert_eq!(
            model_endpoint("http://127.0.0.1:8081/", Protocol::Chat)
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8081/v1/chat/completions"
        );
        assert_eq!(
            model_endpoint(
                "https://example.org/team/v1/chat/completions",
                Protocol::Responses
            )
            .unwrap()
            .as_str(),
            "https://example.org/team/v1/responses"
        );
        assert_eq!(
            model_endpoint("https://example.org/v1/messages", Protocol::Anthropic)
                .unwrap()
                .as_str(),
            "https://example.org/v1/messages"
        );
        assert!(model_endpoint("http://example.org", Protocol::Anthropic).is_err());
        assert!(model_endpoint("https://user@example.org", Protocol::Responses).is_err());
        let old: Settings = serde_json::from_value(json!({
            "endpoint": "https://example.org/v1/chat/completions", "model": "legacy"
        }))
        .unwrap();
        assert_eq!(old.protocol, Protocol::Chat);
    }

    #[test]
    fn protocol_requests_include_prompt_and_expected_authentication() {
        let messages = [
            Message {
                role: "system".into(),
                text: "Saved prompt".into(),
            },
            Message {
                role: "user".into(),
                text: "Markdown".into(),
            },
        ];
        for protocol in [Protocol::Chat, Protocol::Anthropic, Protocol::Responses] {
            let settings = Settings {
                protocol,
                model: "test".into(),
                ..Default::default()
            };
            let endpoint = model_endpoint("https://example.org", protocol).unwrap();
            let request = model_request(
                &Client::new(),
                endpoint,
                &settings,
                &messages,
                Some("test-key".into()),
            )
            .unwrap()
            .build()
            .unwrap();
            let body: Value =
                serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            assert_eq!(body["stream"], true);
            assert_eq!(body["model"], "test");
            if protocol == Protocol::Anthropic {
                assert_eq!(request.headers()["x-api-key"], "test-key");
                assert_eq!(request.headers()["anthropic-version"], "2023-06-01");
                assert!(request.headers().get("authorization").is_none());
                assert_eq!(body["system"], "Saved prompt");
                assert_eq!(body["messages"][0]["role"], "user");
            } else {
                assert_eq!(request.headers()["authorization"], "Bearer test-key");
                if protocol == Protocol::Responses {
                    assert_eq!(body["instructions"], "Saved prompt");
                    assert_eq!(body["input"][0]["content"], "Markdown");
                    assert_eq!(body["store"], false);
                } else {
                    assert_eq!(body["messages"][0]["content"], "Saved prompt");
                }
            }
        }
    }

    #[test]
    fn protocol_events_stream_text_and_reject_incomplete_edits() {
        let examples = [
            (
                Protocol::Chat,
                json!({"choices":[{"delta":{"content":"稿"}}]}),
                json!({"choices":[{"finish_reason":"stop"}]}),
                json!({"choices":[{"finish_reason":"length"}]}),
            ),
            (
                Protocol::Anthropic,
                json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"稿"}}),
                json!({"type":"message_stop"}),
                json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"}}),
            ),
            (
                Protocol::Responses,
                json!({"type":"response.output_text.delta","delta":"稿"}),
                json!({"type":"response.completed"}),
                json!({"type":"response.incomplete"}),
            ),
        ];
        for (protocol, delta, done, failure) in examples {
            assert_eq!(
                model_event(protocol, "", &delta).unwrap(),
                (Some("稿"), false)
            );
            assert_eq!(model_event(protocol, "", &done).unwrap(), (None, true));
            assert!(model_event(protocol, "", &failure).is_err());
        }
        assert_eq!(
            model_event(
                Protocol::Responses,
                "",
                &json!({"type":"response.failed","response":{"error":{"message":"服务繁忙"}}})
            ),
            Err("服务繁忙".into())
        );
    }
}
