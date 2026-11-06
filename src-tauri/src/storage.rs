//! 生成图片的本地落盘。
//!
//! 会话数据只存在内存里（刷新即失），所以生成的图必须落盘，
//! 否则关掉窗口就找不回来了。这也对应界面上的「打开图片文件夹」。

use crate::api;
use std::path::PathBuf;

const DEFAULT_SUBDIR: &str = "images";

/// 图片根目录：数据目录下的 images/。
pub fn images_dir() -> PathBuf {
    api::data_dir().join(DEFAULT_SUBDIR)
}

fn ensure_dir(dir: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))
}

/// 从 data URL 或远端 url 里取出二进制。
fn decode(source: &str) -> Result<Vec<u8>, String> {
    if source.starts_with("data:") {
        let b64 = crate::chat::strip_data_url(source);
        use base64::Engine;
        return base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("图片 base64 解码失败：{e}"));
    }
    Err("暂不支持从远端地址保存图片".into())
}

/// 保存一张图，返回绝对路径。
///
/// 文件名用 `时间戳-序号.png`，同一毫秒内多次保存也不会互相覆盖。
pub fn save_png(source: &str) -> Result<PathBuf, String> {
    let dir = images_dir();
    ensure_dir(&dir)?;
    let bytes = decode(source)?;
    let stamp = api::now_millis();
    let mut last_err = None;
    for seq in 0..100u32 {
        let path = dir.join(format!("{stamp}-{seq}.png"));
        if path.exists() {
            continue;
        }
        match std::fs::write(&path, &bytes) {
            Ok(()) => return Ok(path),
            Err(e) => last_err = Some(e),
        }
    }
    Err(format!(
        "保存图片失败：{}",
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "无法分配文件名".into())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_remote_urls() {
        assert!(decode("https://example.com/a.png").is_err());
    }

    #[test]
    fn decodes_data_url() {
        // "hi" 的 base64
        let bytes = decode("data:image/png;base64,aGk=").expect("decode");
        assert_eq!(bytes, b"hi");
    }
}
