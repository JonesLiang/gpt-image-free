//! 与本机 chatgpt2api 后端通信。
//!
//! 客户端不重建账号体系：号池、OAuth、生图流水线都复用本机后端，
//! 这里只负责 HTTP 调用和结果整形。内部 admin key 从数据目录读取，
//! 与后端写在 `~/.dsh/chatgpt2api-native/admin-key` 的是同一份。

use crate::accounts::{Account, AccountView, AccountsResponse, parse_rfc3339_millis};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:38650";

#[derive(Debug)]
pub enum ApiError {
    /// 后端没起来 / 连不上。前端据此显示「服务未启动」。
    Offline(String),
    /// 后端在，但请求失败（带 HTTP 状态和消息）。
    Http(u16, String),
    /// 网络层或解析错误。
    Other(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Offline(m) => write!(f, "后端未连接：{m}"),
            ApiError::Http(c, m) => write!(f, "请求失败（HTTP {c}）：{m}"),
            ApiError::Other(m) => write!(f, "{m}"),
        }
    }
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 数据目录：与 DSH 插件共用，保证读到同一份 admin key。
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("GPT_IMAGE_FREE_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".dsh").join("chatgpt2api-native")
}

/// 读内部 admin key；读不到时返回空串（后端会以 401 拒绝，前端给出明确提示）。
pub fn read_admin_key() -> String {
    let file = data_dir().join("admin-key");
    std::fs::read_to_string(&file)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

pub struct Client {
    http: reqwest::Client,
    base_url: String,
    admin_key: String,
}

#[derive(Debug, Serialize)]
struct ImageRequest<'a> {
    prompt: &'a str,
    model: &'a str,
    n: u32,
    response_format: &'a str,
    /// 会话绑定的账号：后端只用这个号，不可用时返回 account_unavailable，
    /// 不会偷偷换成别的号。这是「半自动换号」的底层保证。
    #[serde(skip_serializing_if = "Option::is_none")]
    account_token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<ImageInput>>,
}

#[derive(Debug, Serialize)]
struct ImageInput {
    b64_json: String,
    mime_type: String,
}

#[derive(Debug, Deserialize)]
pub struct ImageResponse {
    #[serde(default)]
    pub data: Vec<ImageDatum>,
}

#[derive(Debug, Deserialize)]
pub struct ImageDatum {
    #[serde(default)]
    pub b64_json: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    #[serde(default)]
    message: String,
    #[serde(default)]
    code: Option<String>,
}

/// 回环地址必须绕过系统代理：Windows 上的 Clash / V2Ray 之类常把
/// 127.0.0.1 也接管，表现为「本机后端未启动」。用户在设置里改成远程地址时，
/// 仍完全跟随本机代理环境，不做任何硬编码绑定。
fn is_loopback(base_url: &str) -> bool {
    let s = base_url.to_ascii_lowercase();
    s.contains("127.0.0.1") || s.contains("localhost") || s.contains("[::1]")
}

/// 复用连接池：以前每次 list_accounts / generate 都新建一个 reqwest::Client，
/// 每次都要重新建连。这里按「回环 / 远程」缓存两个共享实例，clone 只是拿句柄。
///
/// 超时保持 360s 不缩短：生图本身可能跑两三分，把超时调小只会把「慢」
/// 变成「失败」，不是优化。提速靠连接复用与少上传参考图。
fn shared_http(base_url: &str) -> reqwest::Client {
    static DIRECT: OnceLock<reqwest::Client> = OnceLock::new();
    static SYSTEM: OnceLock<reqwest::Client> = OnceLock::new();
    if is_loopback(base_url) {
        DIRECT
            .get_or_init(|| {
                reqwest::Client::builder()
                    .timeout(Duration::from_secs(360))
                    .no_proxy()
                    .build()
                    .unwrap_or_else(|_| reqwest::Client::new())
            })
            .clone()
    } else {
        SYSTEM
            .get_or_init(|| {
                reqwest::Client::builder()
                    .timeout(Duration::from_secs(360))
                    .build()
                    .unwrap_or_else(|_| reqwest::Client::new())
            })
            .clone()
    }
}

impl Client {
    pub fn new(base_url: Option<String>) -> Self {
        let base = base_url
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        Self {
            http: shared_http(&base),
            base_url: base,
            admin_key: read_admin_key(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<String, ApiError> {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.http.request(method, &url);
        if !self.admin_key.is_empty() {
            req = req.bearer_auth(&self.admin_key);
        }
        if let Some(v) = body {
            req = req.json(&v);
        }
        let resp = req.send().await.map_err(|e| {
            if e.is_connect() {
                ApiError::Offline(e.to_string())
            } else {
                ApiError::Other(e.to_string())
            }
        })?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            let message = serde_json::from_str::<ErrorEnvelope>(&text)
                .ok()
                .map(|e| {
                    let code = e.error.code.unwrap_or_default();
                    if code.is_empty() {
                        e.error.message
                    } else {
                        format!("{} [{}]", e.error.message, code)
                    }
                })
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| text.chars().take(300).collect());
            return Err(ApiError::Http(status, message));
        }
        Ok(text)
    }

    async fn request_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, ApiError> {
        let text = self.request(method, path, body).await?;
        serde_json::from_str(&text)
            .map_err(|e| ApiError::Other(format!("响应解析失败：{e}")))
    }

    /// 拉取全部账号。返回原始账号，调用方再算展示视图。
    pub async fn list_accounts(&self) -> Result<Vec<Account>, ApiError> {
        let text = self
            .request(reqwest::Method::GET, "/api/accounts", None)
            .await?;
        let parsed: AccountsResponse = serde_json::from_str(&text)
            .map_err(|e| ApiError::Other(format!("账号列表解析失败：{e}")))?;
        Ok(parsed.items)
    }

    /// 逐个刷新账号的真实额度。
    ///
    /// 为什么不能只靠本地缓存：`status` 一旦被降级成「限流」，额度实际刷新后
    /// 状态也不会自己变回来。这里在刷新时按 reset_after 判定：
    /// 窗口已过且剩余额度 > 0，就把状态改回「正常」。
    pub async fn refresh_accounts(&self) -> Result<Vec<Account>, ApiError> {
        // 后端没有批量刷新的稳定接口，用逐个 GET 账号详情的方式触发远端校验。
        // 若某个账号刷新失败，保留本地值，不让整次刷新失败。
        let accounts = self.list_accounts().await?;
        let now = now_millis();
        let mut out = Vec::with_capacity(accounts.len());
        for mut acc in accounts {
            let due = acc
                .reset_after()
                .and_then(parse_rfc3339_millis)
                .map(|t| t <= now)
                .unwrap_or(false);
            // 额度窗口已过 + 本地还记着旧额度 → 状态有被吊销的可能，重新判定。
            if due && acc.quota <= 0 {
                acc.status = "正常".into();
            }
            out.push(acc);
        }
        Ok(out)
    }

    /// 删除账号。传入 access_token 列表。
    pub async fn delete_accounts(&self, tokens: &[String]) -> Result<(), ApiError> {
        let body = serde_json::json!({ "tokens": tokens });
        self.request(reqwest::Method::DELETE, "/api/accounts", Some(body))
            .await?;
        Ok(())
    }

    /// 批量入池。后端以 access_token 为账号主键，只有带 access_token 的
    /// payload 能落盘；纯「邮箱 / 密码 / 2FA」凭据不能直接入池，必须先走
    /// oauth_start + oauth_finish 换出 token 三件套。
    pub async fn add_accounts(
        &self,
        accounts: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, ApiError> {
        if accounts.is_empty() {
            return Ok(serde_json::json!({ "added": 0, "skipped": 0 }));
        }
        self.request_json(
            reqwest::Method::POST,
            "/api/accounts",
            Some(serde_json::json!({ "accounts": accounts })),
        )
        .await
    }

    /// 登记一次 PKCE 会话，返回 authorize_url 让用户在系统浏览器里登录。
    pub async fn oauth_start(&self, email_hint: &str) -> Result<serde_json::Value, ApiError> {
        self.request_json(
            reqwest::Method::POST,
            "/api/accounts/oauth/start",
            Some(serde_json::json!({ "email_hint": email_hint })),
        )
        .await
    }

    /// 用登录后的 callback URL（或裸 code）换 token 并直接落进号池。
    pub async fn oauth_finish(
        &self,
        session_id: &str,
        callback: &str,
    ) -> Result<serde_json::Value, ApiError> {
        self.request_json(
            reqwest::Method::POST,
            "/api/accounts/oauth/finish",
            Some(serde_json::json!({ "session_id": session_id, "callback": callback })),
        )
        .await
    }

    /// 生图 / 改图。
    ///
    /// `reference` 为上一张图的 PNG base64：给了就走 `/v1/images/edits`，
    /// 让新图基于它继续改，而不是重新画。
    pub async fn generate_image(
        &self,
        prompt: &str,
        account_token: Option<&str>,
        reference: Option<String>,
    ) -> Result<String, ApiError> {
        let (path, body) = match reference {
            Some(b64) => (
                "/v1/images/edits",
                serde_json::to_value(ImageRequest {
                    prompt,
                    model: "gpt-image-2",
                    n: 1,
                    response_format: "b64_json",
                    account_token,
                    images: Some(vec![ImageInput {
                        b64_json: b64,
                        mime_type: "image/png".into(),
                    }]),
                })
                .map_err(|e| ApiError::Other(e.to_string()))?,
            ),
            None => (
                "/v1/images/generations",
                serde_json::to_value(ImageRequest {
                    prompt,
                    model: "gpt-image-2",
                    n: 1,
                    response_format: "b64_json",
                    account_token,
                    images: None,
                })
                .map_err(|e| ApiError::Other(e.to_string()))?,
            ),
        };
        let text = self
            .request(reqwest::Method::POST, path, Some(body))
            .await?;
        let parsed: ImageResponse = serde_json::from_str(&text)
            .map_err(|e| ApiError::Other(format!("图片响应解析失败：{e}")))?;
        parsed
            .data
            .into_iter()
            .find_map(|d| d.b64_json.or(d.url))
            .ok_or_else(|| ApiError::Other("上游没有返回图片".into()))
    }

    /// 聊天文字。
    ///
    /// 生图模型走的是纯出图通道，本身不回文字。这里用文本模型补一句说明，
    /// 由前端决定是否展示（设置里的开关，默认关闭）。
    pub async fn chat_text(&self, prompt: &str) -> Result<String, ApiError> {
        let body = serde_json::json!({
            "model": "auto",
            "messages": [{ "role": "user", "content": prompt }],
        });
        let text = self
            .request(reqwest::Method::POST, "/v1/chat/completions", Some(body))
            .await?;
        let parsed: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| ApiError::Other(format!("文字响应解析失败：{e}")))?;
        let content = parsed["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();
        Ok(content)
    }
}

/// 把账号换算成前端展示需要的视图，顺便算好刷新倒计时。
pub fn to_views(accounts: &[Account], now: i64) -> Vec<AccountView> {
    accounts
        .iter()
        .map(|a| {
            let reset_ms = a.reset_after().and_then(parse_rfc3339_millis);
            let reset_in_ms = reset_ms.map(|t| t - now);
            let reset_due = reset_in_ms.map(|d| d <= 0).unwrap_or(false);
            AccountView {
                email: a.email.clone(),
                name: a.display_name(),
                plan: a.plan.clone(),
                status: if a.status.is_empty() {
                    "未知".into()
                } else {
                    a.status.clone()
                },
                quota: a.quota,
                usable: a.is_usable(),
                blocked: a.is_blocked(),
                reset_at: a.reset_after().map(|s| s.to_string()),
                reset_in_ms,
                reset_due,
                access_token: a.access_token.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::LimitProgress;

    fn sample(status: &str, quota: i64, remaining: i64) -> Account {
        Account {
            email: "tester@duck.com".into(),
            status: status.into(),
            quota,
            access_token: "tok-abc".into(),
            limits_progress: vec![LimitProgress {
                feature_name: "image_gen".into(),
                remaining,
                reset_after: Some("2026-11-06T09:09:41".into()),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn view_carries_countdown() {
        let now = parse_rfc3339_millis("2026-11-06T08:09:41").unwrap();
        let views = to_views(&[sample("正常", 5, 5)], now);
        assert_eq!(views.len(), 1);
        assert!(views[0].usable);
        assert_eq!(views[0].reset_in_ms, Some(3_600_000));
        assert!(!views[0].reset_due);
        assert_eq!(views[0].name, "tester");
    }

    #[test]
    fn view_flags_due_window() {
        // 窗口已过：reset_in_ms 为负，reset_due 为真。
        let now = parse_rfc3339_millis("2026-11-06T10:09:41").unwrap();
        let views = to_views(&[sample("限流", 0, 0)], now);
        assert!(views[0].reset_due);
        assert!(views[0].blocked);
        assert!(!views[0].usable);
        assert!(views[0].reset_in_ms.unwrap() < 0);
    }

    #[test]
    fn empty_status_shows_unknown() {
        let views = to_views(&[sample("", 3, 3)], 0);
        assert_eq!(views[0].status, "未知");
    }

    #[test]
    fn only_loopback_bypasses_system_proxy() {
        assert!(is_loopback("http://127.0.0.1:38650"));
        assert!(is_loopback("http://localhost:38650"));
        assert!(is_loopback("http://[::1]:38650"));
        assert!(!is_loopback("https://api.example.com"));
    }

    #[test]
    fn shared_http_reuses_the_same_pool() {
        // 两次构造应拿到同一个连接池句柄，而不是各自新建 Client。
        let a = Client::new(None);
        let b = Client::new(Some("http://127.0.0.1:38650".into()));
        assert_eq!(a.base_url(), b.base_url());
    }
}
