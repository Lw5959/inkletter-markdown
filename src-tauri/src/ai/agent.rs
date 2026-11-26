use super::{
    Event, Jobs, Message, Protocol, config, model_event, model_messages, stream_request,
    stream_response, system_messages,
};
use crate::store::{Store, err};
use config::{Models, Selection, Target};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tauri::{State, ipc::Channel};

#[derive(Deserialize)]
struct Tool {
    name: String,
    description: String,
    schema: Value,
}

impl Tool {
    fn definition(&self, protocol: Protocol) -> Value {
        match protocol {
            Protocol::Chat => json!({ "type": "function", "function": {
                "name": self.name, "description": self.description, "parameters": self.schema
            }}),
            Protocol::Anthropic => json!({
                "name": self.name, "description": self.description, "input_schema": self.schema
            }),
            Protocol::Responses => json!({ "type": "function", "name": self.name,
                "description": self.description, "parameters": self.schema }),
        }
    }
}

#[derive(Deserialize)]
struct ResultItem {
    id: String,
    content: String,
    error: bool,
}

#[derive(Deserialize)]
struct Exchange {
    output: Vec<Value>,
    results: Vec<ResultItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    id: String,
    session_id: String,
    selection: Selection,
    messages: Vec<Message>,
    tools: Vec<Tool>,
    history: Vec<Exchange>,
}

#[derive(Serialize)]
struct Call {
    id: String,
    name: String,
    arguments: String,
}

impl Call {
    fn from_values(id: &Value, name: &Value, arguments: String) -> Result<Self, String> {
        let id = id
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("模型的工具调用缺少编号")?;
        let name = name
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or("模型的工具调用缺少名称")?;
        Ok(Self {
            id: id.into(),
            name: name.into(),
            arguments,
        })
    }
}

#[derive(Serialize)]
pub struct Reply {
    text: String,
    calls: Vec<Call>,
    output: Vec<Value>,
}

fn request_body(
    settings: &Target,
    messages: &[Message],
    tools: &[Tool],
    history: &[Exchange],
) -> Value {
    let protocol = settings.protocol;
    let mut input = model_messages(protocol, messages);
    // 续接供应商返回的原始轮次。Responses 推理条目和 Anthropic 签名也必须随工具结果回传。
    for exchange in history {
        input.extend(exchange.output.iter().cloned());
        match protocol {
            Protocol::Chat => input.extend(exchange.results.iter().map(|result| {
                json!({
                    "role": "tool", "tool_call_id": result.id, "content": result.content
                })
            })),
            Protocol::Anthropic => {
                let content: Vec<_> = exchange.results.iter().map(|result| json!({
                    "type": "tool_result", "tool_use_id": result.id, "content": result.content, "is_error": result.error
                })).collect();
                input.push(json!({ "role": "user", "content": content }));
            }
            Protocol::Responses => input.extend(exchange.results.iter().map(|result| {
                json!({
                    "type": "function_call_output", "call_id": result.id, "output": result.content
                })
            })),
        }
    }
    let tools: Vec<_> = tools.iter().map(|tool| tool.definition(protocol)).collect();
    let model = &settings.model;
    let mut body = match protocol {
        Protocol::Chat => json!({ "model": model, "messages": input, "stream": true }),
        Protocol::Anthropic => {
            json!({ "model": model, "messages": input, "system": system_messages(messages), "stream": true, "max_tokens": 4096 })
        }
        Protocol::Responses => {
            json!({ "model": model, "input": input, "instructions": system_messages(messages),
            "stream": true, "store": false, "include": ["reasoning.encrypted_content"] })
        }
    };
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    body
}

#[derive(Default)]
struct ChatCall {
    id: String,
    name: String,
    arguments: String,
}

struct ContentBlock {
    value: Value,
    arguments: String,
}

#[derive(Default)]
struct Collected {
    text: String,
    reasoning: String,
    chat_calls: BTreeMap<u64, ChatCall>,
    blocks: BTreeMap<u64, ContentBlock>,
    items: BTreeMap<u64, Value>,
    output: Vec<Value>,
    complete: bool,
    expects_calls: bool,
}

fn index(value: &Value, key: &str) -> Result<u64, String> {
    value[key]
        .as_u64()
        .filter(|index| *index < 128)
        .ok_or_else(|| "模型返回了无效的流式条目".into())
}

fn append(value: &mut Value, text: &Value) {
    if let Some(text) = text.as_str() {
        match value {
            Value::String(previous) => previous.push_str(text),
            other => *other = Value::String(text.to_owned()),
        }
    }
}

impl Collected {
    fn frame<'a>(
        &mut self,
        protocol: Protocol,
        event: &str,
        data: &'a Value,
    ) -> Result<Option<&'a str>, String> {
        let kind = data["type"].as_str().unwrap_or(event);
        let (delta, finished) = match protocol {
            Protocol::Chat => {
                let choice = &data["choices"][0];
                let part = &choice["delta"];
                if let Some(think) = part["reasoning_content"].as_str() {
                    self.reasoning.push_str(think);
                }
                if let Some(calls) = part["tool_calls"].as_array() {
                    for call in calls {
                        let draft = self.chat_calls.entry(index(call, "index")?).or_default();
                        if let Some(id) = call["id"].as_str().filter(|id| !id.is_empty()) {
                            draft.id = id.into();
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            draft.name.push_str(name);
                        }
                        if let Some(args) = call["function"]["arguments"].as_str() {
                            draft.arguments.push_str(args);
                        }
                    }
                }
                if choice["finish_reason"] == "tool_calls" && data["error"].is_null() {
                    self.expects_calls = true;
                    (part["content"].as_str(), true)
                } else {
                    model_event(protocol, event, data)?
                }
            }
            Protocol::Anthropic => {
                match kind {
                    "content_block_start" => {
                        self.blocks.insert(
                            index(data, "index")?,
                            ContentBlock {
                                value: data["content_block"].clone(),
                                arguments: String::new(),
                            },
                        );
                    }
                    "content_block_delta" => {
                        let block = self
                            .blocks
                            .get_mut(&index(data, "index")?)
                            .ok_or("模型返回的内容块不完整")?;
                        let delta = &data["delta"];
                        match delta["type"].as_str() {
                            Some("input_json_delta") => block
                                .arguments
                                .push_str(delta["partial_json"].as_str().unwrap_or_default()),
                            Some("text_delta") => append(&mut block.value["text"], &delta["text"]),
                            Some("thinking_delta") => {
                                append(&mut block.value["thinking"], &delta["thinking"])
                            }
                            Some("signature_delta") => {
                                append(&mut block.value["signature"], &delta["signature"])
                            }
                            _ => {}
                        }
                    }
                    // 工具轮次同样等到 message_stop，避免使用半截工具参数。
                    "message_delta" if data["delta"]["stop_reason"] == "tool_use" => {
                        self.expects_calls = true;
                        return Ok(None);
                    }
                    _ => {}
                }
                model_event(protocol, event, data)?
            }
            Protocol::Responses => {
                if kind == "response.output_item.done" {
                    self.items
                        .insert(index(data, "output_index")?, data["item"].clone());
                }
                if kind == "response.completed" {
                    self.output = data["response"]["output"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                }
                model_event(protocol, event, data)?
            }
        };
        if let Some(text) = delta {
            self.text.push_str(text);
        }
        self.complete |= finished;
        Ok(delta)
    }

    fn finish(self, protocol: Protocol) -> Result<Reply, String> {
        if !self.complete {
            return Err("模型连接提前中断，请重试".into());
        }
        let mut text = self.text;
        let mut calls = Vec::new();
        let output = match protocol {
            Protocol::Chat => {
                let mut tool_calls = Vec::new();
                for call in self.chat_calls.into_values() {
                    if call.id.is_empty() || call.name.is_empty() {
                        return Err("模型返回的工具调用不完整".into());
                    }
                    tool_calls.push(json!({ "id": call.id, "type": "function", "function": {
                        "name": call.name, "arguments": call.arguments
                    }}));
                    calls.push(Call {
                        id: call.id,
                        name: call.name,
                        arguments: call.arguments,
                    });
                }
                let mut assistant = json!({ "role": "assistant", "content": text });
                if !tool_calls.is_empty() {
                    assistant["tool_calls"] = json!(tool_calls);
                }
                // DeepSeek 思考模式在同一轮工具续接时要求回传 reasoning_content。
                if !self.reasoning.is_empty() {
                    assistant["reasoning_content"] = json!(self.reasoning);
                }
                vec![assistant]
            }
            Protocol::Anthropic => {
                let mut content = Vec::new();
                for mut block in self.blocks.into_values() {
                    if block.value["type"] == "tool_use" {
                        if !block.arguments.is_empty() {
                            block.value["input"] = serde_json::from_str(&block.arguments)
                                .map_err(|_| "模型返回的工具参数不完整")?;
                        }
                        calls.push(Call::from_values(
                            &block.value["id"],
                            &block.value["name"],
                            block.value["input"].to_string(),
                        )?);
                    }
                    content.push(block.value);
                }
                vec![json!({ "role": "assistant", "content": content })]
            }
            Protocol::Responses => {
                let output: Vec<_> = if self.output.is_empty() {
                    self.items.into_values().collect()
                } else {
                    self.output
                };
                for item in &output {
                    if item["type"] == "function_call" {
                        calls.push(Call::from_values(
                            &item["call_id"],
                            &item["name"],
                            item["arguments"].as_str().unwrap_or_default().into(),
                        )?);
                    }
                }
                if text.is_empty() {
                    // 部分兼容接口只在完成事件里附带最终文本。
                    text.extend(
                        output
                            .iter()
                            .filter_map(|item| item["content"].as_array())
                            .flatten()
                            .filter(|part| part["type"] == "output_text")
                            .filter_map(|part| part["text"].as_str()),
                    );
                }
                output
            }
        };
        if self.expects_calls && calls.is_empty() {
            return Err("模型未返回完整的工具调用".into());
        }
        if calls.is_empty() && text.trim().is_empty() {
            return Err("模型未返回可用内容".into());
        }
        Ok(Reply {
            text,
            calls,
            output,
        })
    }
}

async fn turn(
    http: &Client,
    endpoint: Url,
    settings: Target,
    key: Option<String>,
    request: Request,
    channel: &Channel<Event>,
) -> Result<Reply, String> {
    let protocol = settings.protocol;
    let body = request_body(
        &settings,
        &request.messages,
        &request.tools,
        &request.history,
    );
    let request = stream_request(
        http,
        endpoint,
        protocol,
        key.as_deref(),
        &body,
        &request.session_id,
    )?
    .timeout(Duration::from_secs(120));
    let response = stream_response(request).await?;
    let mut events = response.bytes_stream().eventsource();
    let mut collected = Collected::default();
    let mut bytes = 0;
    while let Some(frame) = events.next().await {
        let frame = frame.map_err(err)?;
        bytes += frame.data.len();
        if bytes > 4 * 1024 * 1024 {
            return Err("本轮模型输出过长，请缩小任务范围".into());
        }
        if frame.data.trim() == "[DONE]" {
            collected.complete |= protocol == Protocol::Chat;
            break;
        }
        let data: Value =
            serde_json::from_str(&frame.data).map_err(|_| "供应商返回了无法识别的流式数据")?;
        if let Some(text) = collected
            .frame(protocol, &frame.event, &data)?
            .filter(|text| !text.is_empty())
        {
            channel
                .send(Event::Delta {
                    text: text.to_owned(),
                })
                .map_err(err)?;
        }
        if collected.complete {
            break;
        }
    }
    let reply = collected.finish(protocol)?;
    Ok(reply)
}

#[tauri::command]
pub async fn ai_agent_turn(
    request: Request,
    event: Channel<Event>,
    store: State<'_, Store>,
    jobs: State<'_, Jobs>,
    models: State<'_, Models>,
    http: State<'_, Client>,
) -> Result<Option<Reply>, String> {
    jobs.run(request.id.clone(), async {
        let (settings, endpoint, key) = config::target(&store, &models, request.selection.clone())?;
        turn(&http, endpoint, settings, key, request, &event).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Request {
        serde_json::from_value(json!({
            "id": "agent-fixture", "sessionId": "0d19324b-93a1-485a-a086-df35839c6c77",
            "selection": { "providerId": "fixture", "model": "test-model" },
            "messages": [{ "role": "system", "text": "使用授权文档" }, { "role": "user", "text": "读取第一行" }],
            "tools": [{ "name": "read_document", "description": "读取", "schema": { "type": "object" } }],
            "history": []
        })).unwrap()
    }

    fn exchange(reply: Reply) -> Exchange {
        Exchange {
            output: reply.output,
            results: vec![ResultItem {
                id: reply.calls[0].id.clone(),
                content: "{\"markdown\":\"第一行\"}".into(),
                error: false,
            }],
        }
    }

    fn parse(protocol: Protocol, frames: &[Value]) -> Reply {
        let mut current = Collected::default();
        for frame in frames {
            current.frame(protocol, "message", frame).unwrap();
        }
        current.finish(protocol).unwrap()
    }

    #[test]
    fn anthropic_keeps_signed_thinking_and_uses_a_user_tool_result() {
        let protocol = Protocol::Anthropic;
        let reply = parse(
            protocol,
            &[
                json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"fixture"}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}),
                json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"read_document","input":{}}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"document\":"}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}),
                json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
                json!({"type":"message_stop"}),
            ],
        );
        assert_eq!(reply.calls[0].arguments, "{\"document\":1}");
        let request = request();
        let body = request_body(
            &Target {
                protocol,
                ..Default::default()
            },
            &request.messages,
            &request.tools,
            &[exchange(reply)],
        );
        assert_eq!(body["messages"][1]["content"][0]["signature"], "signed");
        assert_eq!(body["messages"][2]["role"], "user");
        assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "tool-1");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn responses_replays_items_with_function_call_outputs() {
        let protocol = Protocol::Responses;
        let reply = parse(
            protocol,
            &[json!({"type":"response.completed","response":{"output":[
                {"type":"reasoning","encrypted_content":"fixture-encrypted"},
                {"type":"function_call","call_id":"call-1","name":"read_document","arguments":"{\"document\":1}"}
            ]}})],
        );
        assert_eq!(reply.calls[0].id, "call-1");
        let request = request();
        let body = request_body(
            &Target {
                protocol,
                ..Default::default()
            },
            &request.messages,
            &request.tools,
            &[exchange(reply)],
        );
        assert_eq!(body["store"], false);
        assert_eq!(body["input"][1]["encrypted_content"], "fixture-encrypted");
        assert_eq!(body["input"][3]["type"], "function_call_output");
        assert_eq!(body["input"][3]["call_id"], "call-1");
        assert_eq!(body["tools"][0]["name"], "read_document");
    }

    #[tokio::test]
    async fn chat_stream_runs_two_requests_with_a_tool_result_and_reasoning() {
        use std::{
            io::{BufRead, BufReader, Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = std::thread::spawn(move || {
            let rounds = [
                vec![
                    json!({"choices":[{"delta":{"reasoning_content":"fixture-reasoning"}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_document","arguments":"{\"document\":"}}]}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}),
                    json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
                ],
                vec![json!({"choices":[{"delta":{"content":"已读取"},"finish_reason":"stop"}]})],
            ];
            for (round, frames) in rounds.into_iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&stream);
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap() == 0 || header == "\r\n" {
                        break;
                    }
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["tools"][0]["function"]["name"], "read_document");
                if round == 1 {
                    assert_eq!(
                        body["messages"][2]["reasoning_content"],
                        "fixture-reasoning"
                    );
                    assert_eq!(body["messages"][3]["tool_call_id"], "call-1");
                    assert_eq!(body["messages"][3]["content"], "{\"markdown\":\"第一行\"}");
                }
                let body: String = frames
                    .into_iter()
                    .map(|frame| format!("data: {frame}\n\n"))
                    .collect();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let http = Client::builder().no_proxy().build().unwrap();
        let channel = Channel::new(|_| Ok(()));
        let settings = || Target {
            protocol: Protocol::Chat,
            model: "test-model".into(),
            ..Default::default()
        };
        let reply = turn(
            &http,
            endpoint.clone(),
            settings(),
            None,
            request(),
            &channel,
        )
        .await
        .unwrap();
        assert_eq!(reply.calls[0].arguments, "{\"document\":1}");
        let mut follow = request();
        follow.history.push(exchange(reply));
        let reply = turn(&http, endpoint, settings(), None, follow, &channel)
            .await
            .unwrap();
        assert_eq!(reply.text, "已读取");
        assert!(reply.calls.is_empty());
        server.join().unwrap();
    }
}
