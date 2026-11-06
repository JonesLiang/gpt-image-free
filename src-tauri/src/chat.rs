//! 会话与上下文注入。
//!
//! 一个会话绑定一个账号。账号正常就一直用它；账号不可用时用户手动换号，
//! 换号后把上下文（最近一张图 + 带轮次序号的文字）注入新账号，
//! 让模型看到的内容和同账号续写时一致。

use crate::api;
use serde::{Deserialize, Serialize};

/// 默认注入最近多少轮文字。
pub const DEFAULT_CONTEXT_ROUNDS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub id: String,
    pub prompt: String,
    /// pending / running / done / error
    pub status: String,
    /// 图片：data URL 或远端 url。
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// 这一轮用的是哪个账号（邮箱）。
    #[serde(default)]
    pub account: Option<String>,
    /// 参考的是第几轮（1 起）；0 表示文生图。
    #[serde(default)]
    pub ref_round: usize,
    /// 这一轮是否注入了上下文（换号后的第一轮）。
    #[serde(default)]
    pub injected: bool,
    #[serde(default)]
    pub text: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// 绑定的账号邮箱（展示用）。
    #[serde(default)]
    pub email: String,
    /// 绑定的账号 access_token（真正传给后端）。
    #[serde(default)]
    pub token: String,
    pub turns: Vec<Turn>,
    #[serde(default)]
    pub switched_at: i64,
    pub created_at: i64,
}

impl Conversation {
    pub fn new(id: String, email: String, token: String) -> Self {
        Self {
            id,
            title: "新会话".into(),
            email,
            token,
            turns: Vec::new(),
            switched_at: 0,
            created_at: api::now_millis(),
        }
    }

    /// 最近一张成功生成的图（base64 部分，不含 data URL 前缀）。
    pub fn latest_image_b64(&self) -> Option<String> {
        self.turns
            .iter()
            .rev()
            .find(|t| t.status == "done" && t.image.is_some())
            .and_then(|t| t.image.as_ref())
            .map(|img| strip_data_url(img).to_string())
    }

    /// 最近一张成功图片所在的轮次（1 起）。
    pub fn latest_image_round(&self) -> usize {
        self.turns
            .iter()
            .enumerate()
            .rev()
            .find(|(_, t)| t.status == "done" && t.image.is_some())
            .map(|(i, _)| i + 1)
            .unwrap_or(0)
    }

    pub fn done_count(&self) -> usize {
        self.turns.iter().filter(|t| t.status == "done").count()
    }
}

/// 去掉 `data:image/png;base64,` 前缀，只留 base64 本体。
pub fn strip_data_url(s: &str) -> &str {
    match s.find(",") {
        Some(idx) if s.starts_with("data:") => &s[idx + 1..],
        _ => s,
    }
}

/// 生成带轮次序号的上下文文字。
///
/// 编号必须是**真实轮次**，不能从 1 重新数，否则模型会误判先后顺序。
pub fn build_context_text(turns: &[Turn], limit: usize) -> String {
    let limit = limit.max(1);
    if turns.is_empty() {
        return String::new();
    }
    let start = turns.len().saturating_sub(limit);
    let kept = &turns[start..];
    kept.iter()
        .enumerate()
        .map(|(i, t)| format!("第 {} 轮：{}", start + i + 1, t.prompt.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 换号时拼出的完整提示词：上下文 + 本轮要求。
pub fn compose_injected_prompt(turns: &[Turn], current: &str, limit: usize) -> String {
    let ctx = build_context_text(turns, limit);
    let now = current.trim();
    if ctx.is_empty() {
        return now.to_string();
    }
    format!("【这是一个续接的会话，之前的内容如下】\n{ctx}\n\n【本轮要求】\n{now}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(prompt: &str) -> Turn {
        Turn {
            id: "t".into(),
            prompt: prompt.into(),
            status: "done".into(),
            image: None,
            error: None,
            account: None,
            ref_round: 0,
            injected: false,
            text: None,
            created_at: 0,
        }
    }

    #[test]
    fn context_keeps_real_round_numbers() {
        let turns: Vec<Turn> = (1..=8).map(|i| turn(&format!("第{i}句"))).collect();
        let ctx = build_context_text(&turns, 3);
        assert_eq!(ctx, "第 6 轮：第6句\n第 7 轮：第7句\n第 8 轮：第8句");
    }

    #[test]
    fn injected_prompt_marks_sections() {
        let turns = vec![turn("画一只猫"), turn("加一顶帽子")];
        let full = compose_injected_prompt(&turns, "背景换成夜晚", 5);
        assert!(full.starts_with("【这是一个续接的会话"));
        assert!(full.contains("第 2 轮：加一顶帽子"));
        assert!(full.ends_with("【本轮要求】\n背景换成夜晚"));
    }

    #[test]
    fn no_history_means_no_prefix() {
        assert_eq!(compose_injected_prompt(&[], "只画一张", 5), "只画一张");
    }

    #[test]
    fn latest_image_skips_failed_and_running() {
        let mut conv = Conversation::new("c1".into(), "a@b.c".into(), "tok".into());
        let mut ok = turn("ok");
        ok.image = Some("data:image/png;base64,BBB".into());
        let mut failed = turn("bad");
        failed.status = "error".into();
        let mut running = turn("waiting");
        running.status = "running".into();
        conv.turns = vec![ok, failed, running];
        assert_eq!(conv.latest_image_b64().as_deref(), Some("BBB"));
        assert_eq!(conv.latest_image_round(), 1);
        assert_eq!(conv.done_count(), 1);
    }

    #[test]
    fn strip_data_url_handles_plain_values() {
        assert_eq!(strip_data_url("data:image/png;base64,AAA"), "AAA");
        assert_eq!(strip_data_url("AAA"), "AAA");
    }
}
