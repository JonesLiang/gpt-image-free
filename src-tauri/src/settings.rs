//! 用户设置：持久化到数据目录下的 settings.json。
//!
//! 只有真正需要跨启动保留的东西才放这里（当前是文字输出开关），
//! 会话内容不落盘，避免把提示词和图片写进配置文件。

use crate::api;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// 聊天时是否额外输出一段文字说明。默认关闭：
    /// 生图模型的正常行为是只出图，开这个会多消耗一次文本额度。
    #[serde(default)]
    pub text_reply: bool,
    /// 换号时注入最近多少轮文字。
    #[serde(default = "default_context_rounds")]
    pub context_rounds: usize,
    /// 后端地址。
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// 启动时是否自动检查更新。
    #[serde(default = "default_true")]
    pub auto_check_update: bool,
}

fn default_context_rounds() -> usize {
    crate::chat::DEFAULT_CONTEXT_ROUNDS
}

fn default_base_url() -> String {
    api::DEFAULT_BASE_URL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            text_reply: false,
            context_rounds: default_context_rounds(),
            base_url: default_base_url(),
            auto_check_update: true,
        }
    }
}

fn settings_path() -> PathBuf {
    api::data_dir().join("client-settings.json")
}

impl Settings {
    pub fn load() -> Self {
        std::fs::read_to_string(settings_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .map(|mut s: Settings| {
                // 防御：手改配置可能写出离谱值。
                s.context_rounds = s.context_rounds.clamp(1, 50);
                if s.base_url.trim().is_empty() {
                    s.base_url = default_base_url();
                }
                s
            })
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, text).map_err(|e| format!("保存设置失败：{e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_have_text_off() {
        let s = Settings::default();
        assert!(!s.text_reply, "文字输出默认必须是关的");
        assert_eq!(s.context_rounds, 5);
        assert_eq!(s.base_url, api::DEFAULT_BASE_URL);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: Settings = serde_json::from_str(r#"{"text_reply": true}"#).unwrap();
        assert!(s.text_reply);
        assert_eq!(s.context_rounds, 5);
        assert!(s.auto_check_update);
    }
}
