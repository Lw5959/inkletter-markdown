const UTF8_BOM: &[u8] = &[0xef, 0xbb, 0xbf];

pub fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

pub fn decode(mut bytes: Vec<u8>) -> Result<(String, bool), String> {
    let bom = bytes.starts_with(UTF8_BOM);
    if bom {
        bytes.drain(..UTF8_BOM.len());
    }
    let text = String::from_utf8(bytes).map_err(|_| "文档需要使用 UTF-8 编码".to_owned())?;
    Ok((text, bom))
}

pub fn encode(text: &str, bom: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + if bom { UTF8_BOM.len() } else { 0 });
    if bom {
        bytes.extend_from_slice(UTF8_BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}
