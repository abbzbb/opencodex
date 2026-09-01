use serde_json::Value;

pub const MAX_IO_BYTES: usize = 64 * 1024;
pub const UTF8_BOM: [u8; 3] = [0xef, 0xbb, 0xbf];

pub fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    if bytes.len() >= 3 && bytes[..3] == UTF8_BOM {
        &bytes[3..]
    } else {
        bytes
    }
}

pub fn is_single_json_object_line(text: &str) -> bool {
    if !text.ends_with('\n') {
        return false;
    }
    if text.match_indices('\n').nth(1).is_some() {
        return false;
    }
    if text.contains('\u{001b}') {
        return false;
    }
    matches!(serde_json::from_str::<Value>(text), Ok(Value::Object(_)))
}

pub fn decode_stdout_object(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_IO_BYTES {
        return Err(format!("stdout exceeds {MAX_IO_BYTES} bytes"));
    }
    let payload = strip_utf8_bom(bytes);
    let text = std::str::from_utf8(payload).map_err(|_| "invalid UTF-8".to_string())?;
    if !is_single_json_object_line(text) {
        return Err("stdout must be one JSON object plus a single newline".to_string());
    }
    serde_json::from_str(text).map_err(|_| "invalid JSON".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_one_object_line_and_rejects_pollution() {
        assert!(is_single_json_object_line("{\"ok\":true}\n"));
        assert!(!is_single_json_object_line("{\"ok\":true}"));
        assert!(!is_single_json_object_line("{\"ok\":true}\nextra\n"));
        assert!(!is_single_json_object_line("[]\n"));
        assert!(!is_single_json_object_line("{\"ok\":true}\n\u{001b}[0m"));
    }
}
