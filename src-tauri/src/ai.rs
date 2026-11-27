pub mod agent;
pub mod attachments;
mod cache;
pub mod config;
mod credentials;
mod models;
mod reasoning;
#[cfg(target_os = "macos")]
mod vault;

use crate::store::{Store, err};
use config::{Models, Selection, Target};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use models::DiscoveredModel;
use reqwest::{
    Client, RequestBuilder, Url,
    header::{HeaderValue, USER_AGENT},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    sync::Mutex,
    time::Duration,
};
use tauri::{State, ipc::Channel};
use tokio::sync::oneshot;
use url::Host;
use uuid::Uuid;

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, oneshot::Sender<()>>>);

impl Jobs {
    async fn run<T>(
        &self,
        id: String,
        request: impl Future<Output = Result<T, String>>,
    ) -> Result<Option<T>, String> {
        let (cancel, stop) = oneshot::channel();
        {
            let mut active = self.0.lock().map_err(err)?;
            if active.contains_key(&id) {
                return Err("生成任务已存在".into());
            }
            active.insert(id.clone(), cancel);
        }
        let result = tokio::select! {
            result = request => result.map(Some),
            _ = stop => Ok(None)
        };
        self.0.lock().map_err(err)?.remove(&id);
        result
    }
}

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

#[derive(Deserialize, Serialize)]
pub struct Message {
    role: String,
    text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    files: Vec<attachments::InputFile>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Delta {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<cache::Usage>,
    },
    Cancelled,
}

fn http_endpoint(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(err)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host().is_none()
    {
        return Err("地址须使用 HTTP 或 HTTPS，且不能包含用户名、密码或片段".into());
    }
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain == "localhost",
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

pub fn safe_endpoint(value: &str) -> Result<Url, String> {
    let url = http_endpoint(value)?;
    if url.scheme() == "http" && !is_loopback(&url) {
        return Err("地址须使用 HTTPS 或本机回环 HTTP".into());
    }
    Ok(url)
}

pub fn configured_endpoint(value: &str) -> Result<Url, String> {
    direct_endpoint(safe_endpoint(value)?)
}

fn direct_endpoint(url: Url) -> Result<Url, String> {
    // Android 会保存这些地址，查询参数可能包含密钥或访问令牌。
    #[cfg(target_os = "android")]
    if url.query().is_some() {
        return Err("请填写不带查询参数的服务器直达地址".into());
    }
    Ok(url)
}

fn is_opencode_go(url: &Url) -> bool {
    let path = url.path();
    url.scheme() == "https"
        && url.host_str() == Some("opencode.ai")
        && url.port().is_none()
        && (matches!(path, "/inference/go" | "/zen/go")
            || path.starts_with("/inference/go/")
            || path.starts_with("/zen/go/"))
}

fn model_endpoint(endpoint: &str, protocol: Protocol) -> Result<Url, String> {
    // AI 按供应商手动配置的地址连接，模型列表和生成请求共用同一地址规则。
    let mut url = direct_endpoint(http_endpoint(endpoint)?)?;
    let path = url.path().trim_end_matches('/');
    if path.ends_with(protocol.path()) {
        return Ok(url);
    }
    // 配置页允许输入服务根地址、API 前缀或完整地址；切协议时复用原有前缀。
    let prefix = if is_opencode_go(&url) && path == "/inference/go" {
        match protocol {
            Protocol::Anthropic => "/inference/go/anthropic/v1",
            Protocol::Chat | Protocol::Responses => "/inference/go/openai/v1",
        }
    } else if is_opencode_go(&url) && path == "/zen/go" {
        "/zen/go/v1"
    } else if path.is_empty() {
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

fn authorize(
    request: RequestBuilder,
    protocol: Protocol,
    key: Option<&str>,
) -> Result<RequestBuilder, String> {
    if protocol == Protocol::Anthropic {
        let request = request.header("anthropic-version", "2023-06-01");
        if let Some(key) = key {
            let mut value = HeaderValue::from_str(key).map_err(|_| "API 密钥含有无法发送的字符")?;
            value.set_sensitive(true);
            return Ok(request.header("x-api-key", value));
        }
        return Ok(request);
    }
    if let Some(key) = key {
        HeaderValue::from_str(key).map_err(|_| "API 密钥含有无法发送的字符")?;
        Ok(request.bearer_auth(key))
    } else {
        Ok(request)
    }
}

#[derive(Deserialize)]
pub struct Discovery {
    id: String,
    endpoint: String,
    protocol: Protocol,
    key: Option<String>,
}

#[derive(Deserialize)]
struct ModelsPage {
    data: Vec<Value>,
    #[serde(default)]
    has_more: bool,
    last_id: Option<String>,
}

fn models_endpoint(mut endpoint: Url, protocol: Protocol) -> Url {
    if is_opencode_go(&endpoint) {
        endpoint.set_path("/inference/go/v1/models");
        return endpoint;
    }
    let path = endpoint.path().trim_end_matches('/');
    let prefix = path.strip_suffix(protocol.path()).unwrap_or(path);
    endpoint.set_path(&format!("{prefix}/models"));
    endpoint
}

async fn discover_models(
    http: &Client,
    endpoint: Url,
    protocol: Protocol,
    key: Option<&str>,
) -> Result<Vec<DiscoveredModel>, String> {
    let mut discovered = BTreeMap::new();
    let mut after_id: Option<String> = None;
    for _ in 0..16 {
        let mut url = endpoint.clone();
        if let Some(after_id) = &after_id {
            url.query_pairs_mut().append_pair("after_id", after_id);
        }
        let request = http
            .get(url)
            .timeout(Duration::from_secs(12))
            .header("Accept", "application/json");
        let mut response = authorize(request, protocol, key)?
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "获取模型超时，请重试"
                } else {
                    "无法连接供应商，请检查 API 地址和网络"
                }
            })?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 => return Err("当前密钥无法读取模型列表，请检查密钥和权限".into()),
            404 | 405 | 501 => return Err("供应商未提供模型列表，请手动添加模型 ID".into()),
            status => return Err(format!("供应商获取模型失败（HTTP {status}）")),
        }
        let mut data = Vec::new();
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|_| "模型列表读取中断，请重试")?
        {
            if data.len() + bytes.len() > 2 * 1024 * 1024 {
                return Err("模型列表过大，请手动添加需要的模型 ID".into());
            }
            data.extend_from_slice(&bytes);
        }
        let page: ModelsPage =
            serde_json::from_slice(&data).map_err(|_| "供应商返回的模型列表格式无法识别")?;
        for item in page.data.iter().filter_map(DiscoveredModel::from_response) {
            discovered.insert(item.id.clone(), item);
        }
        if !page.has_more {
            return Ok(discovered.into_values().collect());
        }
        // 分页只更新已验证地址的游标，凭据始终发送到同一个服务。
        if page.last_id.is_none() || page.last_id == after_id {
            return Err("供应商模型列表的分页游标无效".into());
        }
        after_id = page.last_id;
    }
    Err("供应商模型列表分页过多，请手动添加需要的模型 ID".into())
}

#[tauri::command]
pub async fn ai_list_models(
    request: Discovery,
    store: State<'_, Store>,
    models: State<'_, Models>,
    http: State<'_, Client>,
) -> Result<Vec<DiscoveredModel>, String> {
    let endpoint = model_endpoint(&request.endpoint, request.protocol)?;
    let key = match request.key.as_deref().map(str::trim) {
        Some("") => None,
        Some(key) => Some(key.to_owned()),
        None => config::discovery_key(&store, &models, &request.id, request.protocol, &endpoint)?,
    };
    let mut discovered = tokio::time::timeout(
        Duration::from_secs(25),
        discover_models(
            &http,
            models_endpoint(endpoint.clone(), request.protocol),
            request.protocol,
            key.as_deref(),
        ),
    )
    .await
    .map_err(|_| "获取模型超时，请重试")??;
    models::enrich(&http, &endpoint, &mut discovered).await;
    Ok(discovered)
}

fn model_request(
    http: &Client,
    endpoint: Url,
    settings: &Target,
    messages: &[Message],
    key: Option<String>,
    session_id: &str,
) -> Result<RequestBuilder, String> {
    attachments::validate(messages, settings)?;
    let protocol = settings.protocol;
    let conversation = model_messages(protocol, messages);
    let model = &settings.model;
    let mut body = match protocol {
        Protocol::Chat => json!({ "model": model, "messages": conversation, "stream": true }),
        Protocol::Anthropic => json!({
            "model": model, "messages": conversation, "system": system_messages(messages), "max_tokens": 4096, "stream": true
        }),
        Protocol::Responses => json!({
            "model": model, "input": conversation, "instructions": system_messages(messages), "store": false, "stream": true
        }),
    };
    reasoning::request_options(&mut body, settings);
    models::apply_limits(&mut body, settings)?;
    stream_request(http, endpoint, protocol, key.as_deref(), body, session_id)
}

fn model_messages(protocol: Protocol, messages: &[Message]) -> Vec<Value> {
    messages
        .iter()
        .filter(|message| protocol == Protocol::Chat || message.role != "system")
        .map(|message| {
            if message.files.is_empty() {
                return json!({ "role": message.role, "content": message.text });
            }
            let text_type = if protocol == Protocol::Responses {
                "input_text"
            } else {
                "text"
            };
            let mut parts = vec![json!({ "type": text_type, "text": message.text })];
            parts.extend(message.files.iter().map(|file| file.part(protocol)));
            json!({ "role": message.role, "content": parts })
        })
        .collect()
}

fn system_messages(messages: &[Message]) -> String {
    messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn stream_request(
    http: &Client,
    endpoint: Url,
    protocol: Protocol,
    key: Option<&str>,
    mut body: Value,
    session_id: &str,
) -> Result<RequestBuilder, String> {
    let go = is_opencode_go(&endpoint);
    if cache::requests_usage(&endpoint, protocol) {
        body["stream_options"] = json!({ "include_usage": true });
    }
    let mut request = http
        .post(endpoint)
        .timeout(Duration::from_secs(300))
        .header("Accept", "text/event-stream")
        .json(&body);
    if go {
        // 只向 Go 官方 HTTPS 地址发送不含正文的会话标识，供应商据此复用路由和缓存。
        let session = Uuid::try_parse(session_id).map_err(|_| "AI 对话编号无效，请新建对话")?;
        request = request
            .header(USER_AGENT, concat!("yeyu/", env!("CARGO_PKG_VERSION")))
            .header(
                "x-opencode-session",
                format!("ses_yeyu_{}", session.simple()),
            );
    }
    authorize(request, protocol, key)
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
    endpoint: Url,
    settings: Target,
    key: Option<String>,
    messages: Vec<Message>,
    event: &Channel<Event>,
    session_id: &str,
) -> Result<(), String> {
    let expect_usage = cache::requests_usage(&endpoint, settings.protocol);
    let request = model_request(http, endpoint, &settings, &messages, key, session_id)?;
    let response = stream_response(request).await?;
    let mut events = response.bytes_stream().eventsource();
    let mut saw_delta = false;
    let mut complete = false;
    let mut usage = None;
    while let Some(frame) = events.next().await {
        let frame = frame.map_err(err)?;
        if frame.data.trim() == "[DONE]" {
            complete |= settings.protocol == Protocol::Chat;
            break;
        }
        let data: Value = serde_json::from_str(&frame.data).map_err(err)?;
        let (delta, finished) = model_event(settings.protocol, &frame.event, &data)?;
        usage = cache::usage(settings.protocol, &data).or(usage);
        reasoning::emit(event, settings.protocol, &frame.event, &data)?;
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
            if settings.protocol == Protocol::Chat
                && usage.is_none()
                && (expect_usage || data.get("usage").is_some())
            {
                usage = cache::chat_tail(&mut events).await.or(usage);
            }
            break;
        }
    }
    if !saw_delta {
        return Err("模型未返回可用的流式文本".into());
    }
    if !complete {
        return Err("模型连接提前中断，请重试".into());
    }
    event.send(Event::Done { usage }).map_err(err)
}

async fn stream_response(request: RequestBuilder) -> Result<reqwest::Response, String> {
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
        if detail.contains("MissingSessionID") {
            return Err("OpenCode Go 未收到会话标识。请使用其官方 API 地址，或确认服务代理会转发 x-opencode-session。".into());
        }
        return Err(format!("模型服务返回 {status} {detail}"));
    }
    Ok(response)
}

#[tauri::command]
pub async fn ai_stream(
    id: String,
    session_id: String,
    selection: Selection,
    messages: Vec<Message>,
    event: Channel<Event>,
    store: State<'_, Store>,
    jobs: State<'_, Jobs>,
    models: State<'_, Models>,
    http: State<'_, Client>,
) -> Result<(), String> {
    let request = async {
        let (settings, endpoint, key) = config::target(&store, &models, selection)?;
        stream(
            &http,
            endpoint,
            settings,
            key,
            messages,
            &event,
            &session_id,
        )
        .await
    };
    match jobs.run(id, request).await? {
        Some(()) => Ok(()),
        None => event.send(Event::Cancelled).map_err(err),
    }
}

#[tauri::command]
pub async fn ai_cancel(id: String, jobs: State<'_, Jobs>) -> Result<(), String> {
    if let Some(cancel) = jobs.0.lock().map_err(err)?.remove(&id) {
        let _ = cancel.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_conversations(
    value: Option<Value>,
    store: State<'_, Store>,
) -> Result<Value, String> {
    const FILE: &str = "ai-conversations.json";
    if let Some(value) = value {
        if !value.is_object() {
            return Err("会话记录格式无效".into());
        }
        store.write(FILE, &value)?;
        Ok(Value::Null)
    } else {
        store.read(FILE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0d19324b-93a1-485a-a086-df35839c6c77";

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
        assert_eq!(
            model_endpoint("http://192.0.2.10:8080/team/v1", Protocol::Anthropic)
                .unwrap()
                .as_str(),
            "http://192.0.2.10:8080/team/v1/messages"
        );
        assert!(safe_endpoint("http://192.0.2.10:8080/team/v1").is_err());
        assert!(model_endpoint("file:///v1", Protocol::Chat).is_err());
        assert!(model_endpoint("https://user@example.org", Protocol::Responses).is_err());
    }

    #[test]
    fn opencode_go_uses_the_same_session_for_all_protocols() {
        let http = Client::new();
        let second = "81d31869-b85f-4c20-b984-3d1f5b067c88";
        let session_header = "x-opencode-session";
        let cases = [
            (Protocol::Chat, "/inference/go/openai/v1/chat/completions"),
            (Protocol::Anthropic, "/inference/go/anthropic/v1/messages"),
            (Protocol::Responses, "/inference/go/openai/v1/responses"),
        ];
        for (protocol, path) in cases {
            let endpoint = model_endpoint("https://opencode.ai/inference/go", protocol).unwrap();
            assert_eq!(endpoint.path(), path);
            assert_eq!(
                models_endpoint(endpoint.clone(), protocol).path(),
                "/inference/go/v1/models"
            );
            let build = |session| {
                stream_request(
                    &http,
                    endpoint.clone(),
                    protocol,
                    Some("fixture"),
                    json!({ "stream": true }),
                    session,
                )
                .unwrap()
                .build()
                .unwrap()
            };
            let request = build(SESSION);
            let body: Value =
                serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            assert_eq!(
                body["stream_options"]["include_usage"].as_bool(),
                (protocol == Protocol::Chat).then_some(true)
            );
            let headers = request.headers();
            assert_eq!(
                headers[USER_AGENT],
                concat!("yeyu/", env!("CARGO_PKG_VERSION"))
            );
            assert_eq!(
                headers[session_header],
                "ses_yeyu_0d19324b93a1485aa086df35839c6c77"
            );
            assert_eq!(
                headers[session_header],
                build(SESSION).headers()[session_header]
            );
            assert_ne!(
                headers[session_header],
                build(second).headers()[session_header]
            );
            if protocol == Protocol::Anthropic {
                assert_eq!(headers["x-api-key"], "fixture");
            } else {
                assert_eq!(headers["authorization"], "Bearer fixture");
            }
        }

        let legacy = model_endpoint("https://opencode.ai/zen/go/v1", Protocol::Chat).unwrap();
        assert_eq!(legacy.path(), "/zen/go/v1/chat/completions");
        let body = json!({});
        assert!(
            stream_request(
                &http,
                legacy.clone(),
                Protocol::Chat,
                None,
                body.clone(),
                SESSION
            )
            .unwrap()
            .build()
            .unwrap()
            .headers()
            .contains_key(session_header)
        );
        assert!(
            stream_request(
                &http,
                legacy,
                Protocol::Chat,
                None,
                body.clone(),
                "无法作为请求头"
            )
            .is_err()
        );
        for endpoint in [
            "https://opencode.ai/zen/v1",
            "https://opencode.ai:8443/zen/go/v1",
            "https://opencode.ai/inference/go-other",
            "https://opencode.ai.example.org/zen/go/v1",
            "http://opencode.ai/zen/go/v1",
        ] {
            let endpoint = model_endpoint(endpoint, Protocol::Chat).unwrap();
            let request =
                stream_request(&http, endpoint, Protocol::Chat, None, body.clone(), SESSION)
                    .unwrap()
                    .build()
                    .unwrap();
            assert!(!request.headers().contains_key(session_header));
            let body: Value =
                serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            assert!(body.get("stream_options").is_none());
        }
    }

    #[tokio::test]
    async fn remote_http_lists_models_and_streams_with_provider_auth() {
        use std::{
            io::{BufRead, BufReader, Read, Write},
            net::TcpListener,
        };
        let bind = std::env::var("YEYU_TEST_AI_BIND").unwrap_or_else(|_| "127.0.0.1".into());
        let listener = TcpListener::bind((bind.as_str(), 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let root = format!("http://models.example.test:{}/team/v1", addr.port());
        let server = std::thread::spawn(move || {
            let answers = [
                (
                    "GET",
                    "/team/v1/models",
                    "authorization: bearer fixture",
                    r#"{"data":[{"id":"text-2"},{"id":"text-1","name":"Writer One","limit":{"context":16384,"output":4096},"capabilities":{"reasoning":{"supported":true,"effort":["low","max"]}}},{"id":"text-2"}]}"#,
                ),
                (
                    "GET",
                    "/team/v1/models",
                    "x-api-key: fixture",
                    r#"{"data":[{"id":"claude-1"}],"has_more":true,"last_id":"claude-1"}"#,
                ),
                (
                    "GET",
                    "/team/v1/models?after_id=claude-1",
                    "x-api-key: fixture",
                    r#"{"data":[{"id":"claude-2"}],"has_more":false}"#,
                ),
                (
                    "POST",
                    "/team/v1/chat/completions",
                    "authorization: bearer fixture",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"远端可用\"}}]}\n\n",
                ),
            ];
            for (method, path, auth, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = String::new();
                let mut reader = BufReader::new(&stream);
                loop {
                    let length = request.len();
                    if reader.read_line(&mut request).unwrap() == 0 || &request[length..] == "\r\n"
                    {
                        break;
                    }
                }
                assert!(request.starts_with(&format!("{method} {path} HTTP/1.1\r\n")));
                let headers = request.to_ascii_lowercase();
                assert!(headers.contains(auth));
                if auth.starts_with("x-api-key") {
                    assert!(headers.contains("anthropic-version: 2023-06-01"));
                }
                let content_type = if method == "POST" {
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    let mut payload = vec![0; length];
                    reader.read_exact(&mut payload).unwrap();
                    let payload: Value = serde_json::from_slice(&payload).unwrap();
                    assert_eq!(payload["model"], "text-1");
                    assert_eq!(payload["stream"], true);
                    "text/event-stream"
                } else {
                    "application/json"
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        // 固定测试域名解析到夹具。在有网卡的机器上也可绑定真实非回环地址。
        let http = Client::builder()
            .no_proxy()
            .resolve("models.example.test", addr)
            .build()
            .unwrap();
        let responses = models_endpoint(
            model_endpoint(&root, Protocol::Responses).unwrap(),
            Protocol::Responses,
        );
        let discovered = discover_models(&http, responses, Protocol::Responses, Some("fixture"))
            .await
            .unwrap();
        assert_eq!(
            discovered
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["text-1", "text-2"]
        );
        assert_eq!(
            discovered[0].metadata.display_name.as_deref(),
            Some("Writer One")
        );
        assert_eq!(discovered[0].metadata.context_tokens, Some(16_384));
        assert_eq!(discovered[0].metadata.output_tokens, Some(4_096));
        assert_eq!(
            discovered[0].metadata.reasoning_efforts,
            Some(vec![reasoning::Effort::Low, reasoning::Effort::Max])
        );
        let anthropic = models_endpoint(
            model_endpoint(&root, Protocol::Anthropic).unwrap(),
            Protocol::Anthropic,
        );
        assert_eq!(
            discover_models(&http, anthropic, Protocol::Anthropic, Some("fixture"))
                .await
                .unwrap()
                .into_iter()
                .map(|model| model.id)
                .collect::<Vec<_>>(),
            ["claude-1", "claude-2"]
        );
        let settings = Target {
            protocol: Protocol::Chat,
            model: "text-1".into(),
            ..Default::default()
        };
        let mut events = model_request(
            &http,
            model_endpoint(&root, settings.protocol).unwrap(),
            &settings,
            &[Message {
                role: "user".into(),
                text: "测试流式响应".into(),
                files: vec![],
            }],
            Some("fixture".into()),
            SESSION,
        )
        .unwrap()
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes_stream()
        .eventsource();
        let event = events.next().await.unwrap().unwrap();
        let data = serde_json::from_str(&event.data).unwrap();
        assert_eq!(
            model_event(settings.protocol, &event.event, &data).unwrap(),
            (Some("远端可用"), false)
        );
        server.join().unwrap();
    }

    #[test]
    fn protocol_requests_include_prompt_and_expected_authentication() {
        let messages = [
            Message {
                role: "system".into(),
                text: "Saved prompt".into(),
                files: vec![],
            },
            Message {
                role: "user".into(),
                text: "Markdown".into(),
                files: vec![],
            },
        ];
        for protocol in [Protocol::Chat, Protocol::Anthropic, Protocol::Responses] {
            let settings = Target {
                protocol,
                model: "test".into(),
                input_tokens: Some(512),
                output_tokens: Some(1536),
                ..Default::default()
            };
            let endpoint = model_endpoint("https://example.org", protocol).unwrap();
            let request = model_request(
                &Client::new(),
                endpoint,
                &settings,
                &messages,
                Some("test-key".into()),
                SESSION,
            )
            .unwrap()
            .build()
            .unwrap();
            let body: Value =
                serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            assert_eq!(body["stream"], true);
            assert_eq!(body["model"], "test");
            let field = if protocol == Protocol::Responses {
                "max_output_tokens"
            } else {
                "max_tokens"
            };
            assert_eq!(body[field], 1536);
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
            let over_limit = [Message {
                role: "user".into(),
                text: "测试上下文".repeat(512),
                files: vec![],
            }];
            let endpoint = model_endpoint("https://example.org", protocol).unwrap();
            let error = model_request(
                &Client::new(),
                endpoint,
                &settings,
                &over_limit,
                None,
                SESSION,
            )
            .unwrap_err();
            assert!(error.contains("超过模型的输入上限 512"));
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
