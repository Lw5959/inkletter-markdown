use super::{Message, Protocol, config::Target};
#[cfg(not(target_os = "android"))]
use crate::store::file_name;
use crate::{document_bytes::decode, store::err};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Read;
#[cfg(not(target_os = "android"))]
use std::{fs::File, path::PathBuf};

const MAX_BINARY: usize = 3 * 1024 * 1024;
const MAX_TEXT: usize = 512 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputFile {
    name: String,
    media_type: String,
    data: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Attachment {
    Text { name: String, text: String },
    Binary(InputFile),
}

pub(crate) fn read(name: String, reader: impl Read) -> Result<Attachment, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_BINARY as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > MAX_BINARY {
        return Err(format!("「{name}」超过单个附件 3 MiB 的上限"));
    }
    let media_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if bytes.starts_with(b"PK\x03\x04") {
        match name
            .rsplit('.')
            .next()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("docx") => {
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            }
            Some("xlsx") => {
                Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            }
            Some("pptx") => {
                Some("application/vnd.openxmlformats-officedocument.presentationml.presentation")
            }
            _ => None,
        }
    } else {
        None
    };
    if let Some(media_type) = media_type {
        return Ok(Attachment::Binary(InputFile {
            name,
            media_type: media_type.into(),
            data: STANDARD.encode(bytes),
        }));
    }
    if bytes.len() > MAX_TEXT {
        return Err(format!("「{name}」超过单个文本附件 512 KiB 的上限"));
    }
    let text = decode(bytes)
        .ok()
        .map(|(text, _)| text)
        .filter(|text| !text.contains('\0'))
        .ok_or_else(|| {
            format!("无法读取「{name}」，请选择 UTF-8 文本、常见图片、PDF 或 Office 文档")
        })?;
    if text.trim().is_empty() {
        return Err(format!("「{name}」没有可读内容"));
    }
    Ok(Attachment::Text { name, text })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn ai_read_attachment(path: PathBuf) -> Result<Attachment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = file_name(&path);
        if !path.metadata().is_ok_and(|info| info.is_file()) {
            return Err(format!("无法读取「{name}」，请选择文件"));
        }
        read(
            name.clone(),
            File::open(path).map_err(|_| format!("无法打开「{name}」"))?,
        )
    })
    .await
    .map_err(err)?
}

impl InputFile {
    pub(super) fn part(&self, protocol: Protocol) -> Value {
        let data_url = || format!("data:{};base64,{}", self.media_type, self.data);
        let source =
            || json!({ "type": "base64", "media_type": self.media_type, "data": self.data });
        match (protocol, self.media_type.starts_with("image/")) {
            (Protocol::Chat, true) => {
                json!({"type": "image_url", "image_url": {"url": data_url()}})
            }
            (Protocol::Responses, true) => json!({"type": "input_image", "image_url": data_url()}),
            (Protocol::Anthropic, true) => json!({"type": "image", "source": source()}),
            (Protocol::Chat, false) => {
                json!({"type": "file", "file": {"filename": self.name, "file_data": data_url()}})
            }
            (Protocol::Responses, false) => {
                json!({"type": "input_file", "filename": self.name, "file_data": data_url()})
            }
            (Protocol::Anthropic, false) => {
                json!({"type": "document", "title": self.name, "source": source()})
            }
        }
    }
}

pub(super) fn validate(messages: &[Message], target: &Target) -> Result<(), String> {
    let mut bytes = 0;
    let mut count = 0;
    for message in messages {
        for file in &message.files {
            if message.role != "user" || file.name.trim().is_empty() || file.data.is_empty() {
                return Err("附件需要随用户消息发送".into());
            }
            bytes += file.data.len();
            count += 1;
            if count > 8 || bytes > 12 * 1024 * 1024 || file.data.len() > MAX_BINARY.div_ceil(3) * 4
            {
                return Err("附件过多或过大，请移除部分附件".into());
            }
            match file.media_type.as_str() {
                "image/png" | "image/jpeg" | "image/gif" | "image/webp" => {
                    match target.accepts_image(&file.media_type) {
                        Some(true) => {}
                        Some(false) => {
                            return Err(format!(
                                "当前模型不支持「{}」的图片格式，请切换模型或更换图片",
                                file.name
                            ));
                        }
                        None => {
                            return Err(
                                "当前模型的图片能力尚未确认，请在模型配置中获取规格或设置图片输入"
                                    .into(),
                            );
                        }
                    }
                }
                "application/pdf" => {}
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                    if target.protocol == Protocol::Responses => {}
                _ => {
                    return Err(format!(
                        "当前模型接口无法接收「{}」，请使用 Responses 接口或添加文本版",
                        file.name
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_protocol_uses_its_native_image_part_and_checks_the_model() {
        let Attachment::Binary(file) =
            read("截图".into(), &b"\x89PNG\r\n\x1a\nfixture"[..]).unwrap()
        else {
            panic!("应识别 PNG 文件头");
        };
        assert_eq!(
            file.part(Protocol::Chat)["image_url"]["url"],
            format!("data:image/png;base64,{}", file.data)
        );
        assert_eq!(file.part(Protocol::Responses)["type"], "input_image");
        assert_eq!(
            file.part(Protocol::Anthropic)["source"]["media_type"],
            "image/png"
        );
        let messages = [Message {
            role: "user".into(),
            text: "读图片".into(),
            files: vec![file],
        }];
        assert!(validate(&messages, &Target::default()).is_err());
        assert!(
            validate(
                &messages,
                &Target {
                    input_modalities: Some(vec!["image/jpeg".into()]),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            validate(
                &messages,
                &Target {
                    input_modalities: Some(vec!["image/png".into()]),
                    ..Default::default()
                }
            )
            .is_ok()
        );
        assert!(
            validate(
                &messages,
                &Target {
                    image_input: Some(false),
                    input_modalities: Some(vec!["image/png".into()]),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
}
