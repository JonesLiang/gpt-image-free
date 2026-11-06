//! 账号池与额度的数据模型。
//!
//! 这些结构直接对应本机 chatgpt2api 后端的 `/api/accounts` 返回。
//! 关键点：额度是**每个账号独立的滚动 24 小时窗口**，不是自然日零点刷新，
//! 所以每个账号都带自己的 `reset_after` 时间戳。

use serde::{Deserialize, Serialize};

/// `limits_progress` 里的一项，例如 image_gen / deep_research。
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct LimitProgress {
    #[serde(default)]
    pub feature_name: String,
    #[serde(default)]
    pub remaining: i64,
    /// RFC3339 时间戳；上游给的是 UTC。
    #[serde(default)]
    pub reset_after: Option<String>,
}

/// 后端返回的单个账号。
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Account {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default, rename = "type")]
    pub plan: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub quota: i64,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub limits_progress: Vec<LimitProgress>,
    #[serde(default)]
    pub restore_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

impl Account {
    /// 取 image_gen 这一项额度明细。
    pub fn image_limit(&self) -> Option<&LimitProgress> {
        self.limits_progress
            .iter()
            .find(|item| item.feature_name == "image_gen")
    }

    /// 下次刷新时间：优先用 image_gen 的 reset_after，退回账号级 restore_at。
    pub fn reset_after(&self) -> Option<&str> {
        self.image_limit()
            .and_then(|item| item.reset_after.as_deref())
            .or(self.restore_at.as_deref())
    }

    /// 是否被标记为不可用（限流/冻结/异常/禁用）。
    pub fn is_blocked(&self) -> bool {
        matches!(self.status.as_str(), "限流" | "冻结" | "异常" | "禁用")
    }

    /// 额度是否耗尽。注意：状态可能还停在「正常」但 quota 已经为 0。
    pub fn is_exhausted(&self) -> bool {
        self.quota <= 0
    }

    /// 能否用于新会话：没被标记且还有额度。
    pub fn is_usable(&self) -> bool {
        !self.is_blocked() && !self.is_exhausted() && !self.access_token.is_empty()
    }

    /// 邮箱展示名：名字部分，太长时截断。
    pub fn display_name(&self) -> String {
        let name = self
            .email
            .split('@')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("未命名账号");
        name.to_string()
    }
}

#[derive(Debug, Deserialize)]
pub struct AccountsResponse {
    #[serde(default)]
    pub items: Vec<Account>,
}

/// 刷新后给前端用的账号视图：把“能不能用”“什么时候刷新”都算好。
#[derive(Debug, Clone, Serialize)]
pub struct AccountView {
    pub email: String,
    pub name: String,
    pub plan: String,
    pub status: String,
    pub quota: i64,
    pub usable: bool,
    pub blocked: bool,
    /// 下次刷新的 RFC3339 时间（UTC），前端换算成本地时间显示。
    pub reset_at: Option<String>,
    /// 距离下次刷新的毫秒数；已过期则为负。
    pub reset_in_ms: Option<i64>,
    /// 额度窗口是否已经过期（说明可以重新查询真实额度了）。
    pub reset_due: bool,
    pub access_token: String,
}

/// 把时间戳解析成毫秒级 Unix 时间。
///
/// 上游给的是 `2026-11-06T09:09:41.61` 这种**不带时区**的 ISO 字符串，
/// 实测它是 UTC。带 `Z` 或 `+00:00` 的也一并支持。
pub fn parse_rfc3339_millis(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // 拆出日期与时间
    let (date_part, rest) = s.split_once('T')?;
    let (time_part, tz_offset_secs) = if let Some(stripped) = rest.strip_suffix('Z') {
        (stripped, 0i64)
    } else if let Some(stripped) = rest.strip_suffix("+00:00") {
        (stripped, 0i64)
    } else if let Some(idx) = rest.rfind('+') {
        let (t, _tz) = rest.split_at(idx);
        (t, 0i64)
    } else {
        (rest, 0i64)
    };
    let mut d = date_part.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;

    // 秒数允许带小数，取整数部分即可（界面上只显示到分钟）。
    let time_clean = time_part.split('.').next().unwrap_or(time_part);
    let mut t = time_clean.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let second: i64 = t.next().unwrap_or("0").parse().ok()?;

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second + tz_offset_secs;
    Some(secs * 1000)
}

/// Howard Hinnant 的 days_from_civil 算法，公历日期转「距 1970-01-01 的天数」。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_upstream_style_timestamp() {
        // 上游实际返回的格式：不带时区，按 UTC 处理。
        let ms = parse_rfc3339_millis("2026-11-06T09:09:41.61").expect("should parse");
        // 2026-11-06 09:09:41 UTC
        assert_eq!(ms, 1_793_956_181_000);
    }

    #[test]
    fn parses_zulu_and_offset() {
        assert_eq!(
            parse_rfc3339_millis("2026-11-06T09:09:41Z"),
            parse_rfc3339_millis("2026-11-06T09:09:41")
        );
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_rfc3339_millis("").is_none());
        assert!(parse_rfc3339_millis("not a date").is_none());
        assert!(parse_rfc3339_millis("2026-11-06").is_none());
    }

    fn acct(status: &str, quota: i64) -> Account {
        Account {
            email: "someone@duck.com".into(),
            status: status.into(),
            quota,
            access_token: "tok".into(),
            ..Default::default()
        }
    }

    #[test]
    fn usable_requires_unblocked_and_quota() {
        assert!(acct("正常", 5).is_usable());
        assert!(!acct("正常", 0).is_usable());
        assert!(!acct("限流", 5).is_usable());
        assert!(!acct("冻结", 5).is_usable());
    }

    #[test]
    fn reset_after_prefers_image_gen() {
        let mut a = acct("正常", 5);
        a.restore_at = Some("2026-11-07T00:00:00".into());
        a.limits_progress = vec![
            LimitProgress {
                feature_name: "reason".into(),
                remaining: 50,
                reset_after: Some("2026-11-07T06:00:00".into()),
            },
            LimitProgress {
                feature_name: "image_gen".into(),
                remaining: 5,
                reset_after: Some("2026-11-06T09:09:41".into()),
            },
        ];
        assert_eq!(a.reset_after(), Some("2026-11-06T09:09:41"));
    }
}
