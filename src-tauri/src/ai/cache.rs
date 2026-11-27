use super::{Protocol, is_opencode_go};
use eventsource_stream::Event;
use futures_util::{Stream, StreamExt};
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    cached_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
}

pub(super) fn requests_usage(endpoint: &Url, protocol: Protocol) -> bool {
    // 兼容网关可能拒绝 stream_options，仅向已知支持的直连地址主动请求用量。
    protocol == Protocol::Chat
        && (is_opencode_go(endpoint)
            || (endpoint.scheme() == "https"
                && endpoint.port().is_none()
                && matches!(
                    endpoint.host_str(),
                    Some("api.openai.com" | "api.deepseek.com")
                )))
}

pub(super) fn usage(protocol: Protocol, frame: &Value) -> Option<Usage> {
    let (cached_tokens, input_tokens) = match protocol {
        Protocol::Chat => {
            let usage = &frame["usage"];
            let read = usage["prompt_cache_hit_tokens"]
                .as_u64()
                .or_else(|| usage["prompt_tokens_details"]["cached_tokens"].as_u64())
                .or_else(|| usage["cached_tokens"].as_u64());
            (read, usage["prompt_tokens"].as_u64())
        }
        Protocol::Responses => {
            let usage = &frame["response"]["usage"];
            (
                usage["input_tokens_details"]["cached_tokens"].as_u64(),
                usage["input_tokens"].as_u64(),
            )
        }
        Protocol::Anthropic => {
            let usage = frame.pointer("/message/usage").unwrap_or(&frame["usage"]);
            let read = usage["cache_read_input_tokens"].as_u64();
            let write = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            // Messages 的 input_tokens 只含未缓存部分。
            let input = usage["input_tokens"]
                .as_u64()
                .and_then(|input| input.checked_add(read.unwrap_or(0))?.checked_add(write));
            (read, input)
        }
    };
    (input_tokens.is_some() || cached_tokens.is_some()).then_some(Usage {
        cached_tokens,
        input_tokens: input_tokens.filter(|&input| input >= cached_tokens.unwrap_or(0)),
    })
}

pub(super) async fn chat_tail<S, E>(events: &mut S) -> Option<Usage>
where
    S: Stream<Item = Result<Event, E>> + Unpin,
{
    // Chat 的独立用量帧在 finish_reason 之后。正文已结束时，缺失统计或断流不影响结果。
    tokio::time::timeout(Duration::from_secs(1), async {
        for _ in 0..8 {
            let frame = events.next().await?.ok()?;
            if frame.data.trim() == "[DONE]" || frame.data.len() > 64 * 1024 {
                break;
            }
            let data = serde_json::from_str(&frame.data).ok()?;
            if let Some(usage) = usage(Protocol::Chat, &data) {
                return Some(usage);
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uses_provider_cache_counts_and_distinguishes_zero_from_missing() {
        assert_eq!(
            usage(Protocol::Chat, &json!({"usage":{"prompt_tokens":215}})),
            Some(Usage {
                cached_tokens: None,
                input_tokens: Some(215)
            })
        );
        assert_eq!(
            usage(
                Protocol::Chat,
                &json!({"usage":{"prompt_tokens":215,"prompt_cache_hit_tokens":0}})
            ),
            Some(Usage {
                cached_tokens: Some(0),
                input_tokens: Some(215)
            })
        );
        assert_eq!(
            usage(
                Protocol::Responses,
                &json!({"response":{"usage":{"input_tokens":3056,"input_tokens_details":{"cached_tokens":2048}}}})
            ),
            Some(Usage {
                cached_tokens: Some(2048),
                input_tokens: Some(3056)
            })
        );
        assert_eq!(
            usage(
                Protocol::Anthropic,
                &json!({"message":{"usage":{"input_tokens":30,"cache_read_input_tokens":140,"cache_creation_input_tokens":50}}})
            ),
            Some(Usage {
                cached_tokens: Some(140),
                input_tokens: Some(220)
            })
        );
    }
}
