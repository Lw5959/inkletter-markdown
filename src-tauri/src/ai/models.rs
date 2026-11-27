use super::{
    Protocol,
    config::Target,
    reasoning::{Effort, is_openai_reasoning},
};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_efforts: Option<Vec<Effort>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Options {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<Effort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_input: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected: Option<Metadata>,
}

impl Options {
    pub fn input_limit(&self) -> Option<u32> {
        // 总窗口包含输入和输出。服务未公布单独的输入上限时，从总窗口预留本次输出额度。
        self.input_tokens.or_else(|| {
            let detected = self.detected.as_ref()?;
            detected.input_tokens.or_else(|| {
                detected
                    .context_tokens?
                    .checked_sub(self.output_limit().unwrap_or(0))
                    .filter(|limit| *limit > 0)
            })
        })
    }

    pub fn output_limit(&self) -> Option<u32> {
        self.output_tokens
            .or_else(|| self.detected.as_ref()?.output_tokens)
    }
}

#[derive(Serialize)]
pub struct DiscoveredModel {
    pub id: String,
    pub(super) metadata: Metadata,
}

impl DiscoveredModel {
    pub(super) fn from_response(value: &Value) -> Option<Self> {
        let id = value["id"].as_str()?.trim();
        if id.is_empty() || id.chars().any(char::is_control) {
            return None;
        }
        Some(Self {
            id: id.to_owned(),
            metadata: Metadata::from_response(value),
        })
    }
}

impl Metadata {
    fn from_response(value: &Value) -> Self {
        let limit = &value["limit"];
        let supported = &value["capabilities"]["reasoning"];
        let effort_values = supported["effort"]
            .as_array()
            .or_else(|| {
                value["reasoning_options"]
                    .as_array()?
                    .iter()
                    .find(|item| item["type"] == "effort")?["values"]
                    .as_array()
            })
            .or_else(|| value["reasoning_efforts"].as_array());
        let reasoning_efforts = if let Some(values) = effort_values {
            Some(
                values
                    .iter()
                    .filter_map(|value| serde_json::from_value(value.clone()).ok())
                    .collect(),
            )
        } else if supported.is_object() || value["reasoning"] == false {
            Some(Vec::new())
        } else {
            None
        };
        Self {
            display_name: [&value["display_name"], &value["name"]]
                .into_iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .find(|name| !name.is_empty() && !name.chars().any(char::is_control))
                .map(str::to_owned),
            input_tokens: token_limit([
                &limit["input"],
                &value["max_input_tokens"],
                &value["input_token_limit"],
                &value["max_prompt_tokens"],
            ]),
            output_tokens: token_limit([
                &limit["output"],
                &value["max_output_tokens"],
                &value["max_completion_tokens"],
                &value["output_token_limit"],
                &value["top_provider"]["max_completion_tokens"],
            ]),
            context_tokens: token_limit([
                &limit["context"],
                &value["context_length"],
                &value["context_window"],
                &value["max_context_length"],
            ]),
            reasoning_efforts,
            input_modalities: [
                &value["modalities"]["input"],
                &value["architecture"]["input_modalities"],
                &value["input_modalities"],
            ]
            .into_iter()
            .find_map(|modalities| {
                let values: Vec<_> = modalities
                    .as_array()?
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|value| value.trim().to_ascii_lowercase())
                    .filter(|value| !value.is_empty())
                    .collect();
                (!values.is_empty()).then_some(values)
            })
            .or_else(|| {
                let vision = value["capabilities"]["vision"]
                    .as_bool()
                    .or_else(|| value["capabilities"]["vision"]["supported"].as_bool())
                    .or_else(|| value["supports_vision"].as_bool())?;
                Some(if vision {
                    vec!["image".into()]
                } else {
                    vec!["text".into()]
                })
            }),
        }
    }

    pub(super) fn fill_missing(&mut self, catalog: Self) {
        self.display_name = self.display_name.take().or(catalog.display_name);
        self.input_tokens = self.input_tokens.or(catalog.input_tokens);
        self.output_tokens = self.output_tokens.or(catalog.output_tokens);
        self.context_tokens = self.context_tokens.or(catalog.context_tokens);
        self.reasoning_efforts = self.reasoning_efforts.take().or(catalog.reasoning_efforts);
        self.input_modalities = self.input_modalities.take().or(catalog.input_modalities);
    }
}

fn token_limit<'a>(values: impl IntoIterator<Item = &'a Value>) -> Option<u32> {
    values
        .into_iter()
        .filter_map(Value::as_u64)
        .filter_map(|value| u32::try_from(value).ok())
        .find(|value| *value > 0)
}

pub(super) async fn enrich(http: &Client, endpoint: &Url, models: &mut [DiscoveredModel]) {
    // 只补齐明确匹配的官方服务。目录请求与供应商认证隔离，不携带密钥或模型 ID。
    let provider = match (endpoint.scheme(), endpoint.host_str()) {
        ("https", Some("api.openai.com")) => "openai",
        ("https", Some("api.anthropic.com")) => "anthropic",
        ("https", Some("api.deepseek.com")) => "deepseek",
        _ => return,
    };
    if !models.iter().any(|model| {
        let info = &model.metadata;
        info.output_tokens.is_none()
            || (info.input_tokens.is_none() && info.context_tokens.is_none())
            || info.reasoning_efforts.is_none()
            || info.input_modalities.is_none()
    }) {
        return;
    }
    let Ok(response) = http
        .get("https://models.dev/api.json")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .and_then(|response| response.error_for_status())
    else {
        return;
    };
    let Ok(catalog) = response.json::<Value>().await else {
        return;
    };
    for model in models {
        let metadata = &catalog[provider]["models"][model.id.as_str()];
        if metadata.is_object() {
            model
                .metadata
                .fill_missing(Metadata::from_response(metadata));
        }
    }
}

pub(super) fn apply_limits(body: &mut Value, target: &Target) -> Result<(), String> {
    if let Some(limit) = target.input_tokens {
        // base64 是传输格式，不能按文本 Token 计入。图片和二进制文档由服务端计量。
        let mut ascii = 0usize;
        let mut other = 0usize;
        count_text(body, &mut ascii, &mut other);
        let estimate = ascii.div_ceil(4) + other;
        if estimate > limit as usize {
            return Err(format!(
                "本轮输入约 {estimate} Token，超过模型的输入上限 {limit}。请缩小上下文或调整模型配置。"
            ));
        }
    }
    if let Some(limit) = target.output_tokens {
        let field = match target.protocol {
            Protocol::Chat if is_openai_reasoning(&target.model) => "max_completion_tokens",
            Protocol::Chat | Protocol::Anthropic => "max_tokens",
            Protocol::Responses => "max_output_tokens",
        };
        if let Some(budget) = body["thinking"]["budget_tokens"].as_u64() {
            if limit <= 1024 {
                return Err(
                    "当前输出上限不足以开启此模型的思考，请提高输出上限或选择默认强度".into(),
                );
            }
            body["thinking"]["budget_tokens"] = json!(budget.min(u64::from((limit / 2).max(1024))));
        }
        body[field] = json!(limit);
    }
    Ok(())
}

fn count_text(value: &Value, ascii: &mut usize, other: &mut usize) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| count_text(item, ascii, other)),
        Value::Object(fields) => {
            for (key, item) in fields {
                if (key == "data" && value["type"] == "base64")
                    || (matches!(key.as_str(), "image_url" | "url" | "file_data")
                        && item.as_str().is_some_and(|text| text.starts_with("data:")))
                {
                    continue;
                }
                *ascii += key.len() + 4;
                count_text(item, ascii, other);
            }
        }
        Value::String(text) => {
            let plain = text.bytes().filter(u8::is_ascii).count();
            *ascii += plain + 2;
            *other += text.chars().count() - plain;
        }
        _ => *ascii += 4,
    }
}
