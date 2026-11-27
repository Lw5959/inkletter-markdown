use super::{Event, Protocol, config::Target};
use crate::store::err;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::ipc::Channel;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

pub(super) fn request_options(body: &mut Value, target: &Target) {
    // 默认沿用服务端设置，兼容普通模型和只接受基础字段的网关。
    let Some(effort) = target.reasoning_effort else {
        return;
    };
    let model = target
        .model
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match target.protocol {
        Protocol::Chat => body["reasoning_effort"] = json!(effort),
        Protocol::Responses => {
            body["reasoning"] = json!({ "effort": effort });
            if effort != Effort::None && is_openai_reasoning(&model) {
                // OpenAI Responses 通过公开的思考摘要提供可读文本。
                body["reasoning"]["summary"] = json!("auto");
            }
        }
        Protocol::Anthropic if effort == Effort::None => {
            body["thinking"] = json!({"type": "disabled"})
        }
        Protocol::Anthropic => {
            let model = model.replace('.', "-");
            let claude = model
                .strip_prefix("claude-")
                .and_then(|name| name.split_once('-'));
            if claude.is_some_and(|(family, number)| {
                matches!(family, "fable" | "mythos")
                    || ["4-6", "4-7", "4-8", "5"]
                        .iter()
                        .any(|prefix| version(number, prefix))
            }) {
                body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
                body["output_config"] = json!({ "effort": effort });
                body["max_tokens"] = json!(16_384);
            } else if model.starts_with("claude-3-7-")
                || claude.is_some_and(|(_, number)| version(number, "4"))
            {
                // 支持手动预算的旧款 Claude 需要在输出上限内为正文预留空间。
                let budget = match effort {
                    Effort::None | Effort::Minimal | Effort::Low => 1_024,
                    Effort::Medium => 2_048,
                    Effort::High => 4_096,
                    Effort::Xhigh => 6_144,
                    Effort::Max => 8_192,
                };
                body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
                body["max_tokens"] = json!(budget + 4_096);
            } else {
                body["output_config"] = json!({ "effort": effort });
            }
        }
    }
}

pub(super) fn is_openai_reasoning(model: &str) -> bool {
    let name = model
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    !name.contains("-chat-")
        && ["o1", "o3", "o4", "gpt-5", "gpt-6"]
            .iter()
            .any(|prefix| version(&name, prefix))
}

fn version(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['-', '.']))
}

fn delta<'a>(protocol: Protocol, event_name: &str, data: &'a Value) -> Option<&'a str> {
    let kind = data["type"].as_str().unwrap_or(event_name);
    match protocol {
        Protocol::Chat => {
            let part = &data["choices"][0]["delta"];
            ["reasoning_content", "reasoning", "reasoning_text"]
                .iter()
                .filter_map(|field| part[*field].as_str())
                .find(|text| !text.is_empty())
        }
        Protocol::Anthropic => match kind {
            "content_block_start" if data["content_block"]["type"] == "thinking" => {
                data["content_block"]["thinking"].as_str()
            }
            "content_block_delta" if data["delta"]["type"] == "thinking_delta" => {
                data["delta"]["thinking"].as_str()
            }
            _ => None,
        },
        Protocol::Responses => match kind {
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                data["delta"].as_str()
            }
            "response.reasoning_summary_part.added"
                if data["summary_index"]
                    .as_u64()
                    .is_some_and(|index| index > 0) =>
            {
                Some("\n\n")
            }
            _ => None,
        },
    }
}

pub(super) fn emit(
    channel: &Channel<Event>,
    protocol: Protocol,
    event_name: &str,
    data: &Value,
) -> Result<(), String> {
    // 签名、加密推理和工具参数由协议续接专用，不进入可见思考或文档正文。
    if let Some(text) = delta(protocol, event_name, data).filter(|text| !text.is_empty()) {
        channel
            .send(Event::Reasoning {
                text: text.to_owned(),
            })
            .map_err(err)?;
    }
    Ok(())
}
