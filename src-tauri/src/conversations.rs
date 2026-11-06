//! 会话本地持久化。
//!
//! 目录结构：`<data_dir>/conversations/index.json` 存轻量索引（启动时只读它），
//! `<id>.json` 存完整会话（含图片 data URL），按需加载，避免启动时把几十 MB
//! 的图片一次性读进内存。写入统一走「临时文件 + rename」，防止中途退出写坏文件。

use crate::api;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const SUBDIR: &str = "conversations";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConversationMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub turns: usize,
}

fn dir() -> PathBuf {
    api::data_dir().join(SUBDIR)
}

fn index_path() -> PathBuf {
    dir().join("index.json")
}

/// 会话 id 只能是最保守的字符集：它会直接拼进文件名，必须挡住目录穿越。
pub fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn conv_path(id: &str) -> Result<PathBuf, String> {
    if !safe_id(id) {
        return Err("非法的会话 id".into());
    }
    Ok(dir().join(format!("{id}.json")))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建会话目录失败：{e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入会话失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存会话失败：{e}"))?;
    Ok(())
}

fn read_index() -> Result<Vec<ConversationMeta>, String> {
    let path = index_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取会话索引失败：{e}"))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw).map_err(|e| format!("会话索引损坏：{e}"))
}

/// 把一条 meta 合并进索引：同 id 覆盖，保留最早的 created_at，按更新时间倒序。
fn merge_index(mut list: Vec<ConversationMeta>, incoming: ConversationMeta) -> Vec<ConversationMeta> {
    if let Some(old) = list.iter().find(|m| m.id == incoming.id) {
        let mut merged = incoming.clone();
        merged.created_at = old.created_at.min(incoming.created_at);
        list.retain(|m| m.id != incoming.id);
        list.push(merged);
    } else {
        list.push(incoming);
    }
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    list
}

pub fn list() -> Vec<ConversationMeta> {
    match read_index() {
        Ok(mut list) => {
            list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            list
        }
        Err(_) => Vec::new(),
    }
}

pub fn load(id: &str) -> Result<Option<Value>, String> {
    let path = conv_path(id)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取会话失败：{e}"))?;
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| format!("会话内容损坏：{e}"))?;
    Ok(Some(value))
}

/// 保存一个完整会话，返回更新后的索引项。
pub fn save(conversation: &Value) -> Result<ConversationMeta, String> {
    let id = conversation
        .get("id")
        .and_then(Value::as_str)
        .ok_or("会话缺少 id")?
        .to_string();
    let path = conv_path(&id)?;
    let now = api::now_millis();
    let title = conversation
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("新会话")
        .chars()
        .take(60)
        .collect::<String>();
    let created_at = conversation
        .get("createdAt")
        .and_then(Value::as_i64)
        .unwrap_or(now);
    let updated_at = conversation
        .get("updatedAt")
        .and_then(Value::as_i64)
        .unwrap_or(now);
    let turns = conversation
        .get("turns")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);

    let bytes = serde_json::to_vec_pretty(conversation)
        .map_err(|e| format!("序列化会话失败：{e}"))?;
    write_atomic(&path, &bytes)?;

    let meta = ConversationMeta {
        id,
        title,
        created_at,
        updated_at,
        turns,
    };
    let next = merge_index(read_index()?, meta.clone());
    let bytes = serde_json::to_vec_pretty(&next)
        .map_err(|e| format!("序列化会话索引失败：{e}"))?;
    write_atomic(&index_path(), &bytes)?;
    Ok(meta)
}

pub fn remove(id: &str) -> Result<(), String> {
    let path = conv_path(id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除会话失败：{e}"))?;
    }
    let next: Vec<ConversationMeta> = read_index()?
        .into_iter()
        .filter(|m| m.id != id)
        .collect();
    let bytes = serde_json::to_vec_pretty(&next)
        .map_err(|e| format!("序列化会话索引失败：{e}"))?;
    write_atomic(&index_path(), &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, updated: i64) -> ConversationMeta {
        ConversationMeta {
            id: id.into(),
            title: "会话".into(),
            created_at: 10,
            updated_at: updated,
            turns: 1,
        }
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(safe_id("c-123_ABC"));
        assert!(!safe_id(""));
        assert!(!safe_id("../etc/passwd"));
        assert!(!safe_id("a/b"));
        assert!(!safe_id("a.json"));
    }

    #[test]
    fn merge_keeps_earliest_created_at_and_sorts() {
        let list = vec![meta("a", 20), meta("b", 30)];
        let incoming = ConversationMeta {
            created_at: 99,
            updated_at: 40,
            ..meta("a", 0)
        };
        let merged = merge_index(list, incoming);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "a");
        assert_eq!(merged[0].created_at, 10);
        assert_eq!(merged[0].updated_at, 40);
        assert_eq!(merged[1].id, "b");
    }

    #[test]
    fn merge_adds_new_conversation() {
        let merged = merge_index(vec![meta("a", 20)], meta("c", 50));
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "c");
    }
}
