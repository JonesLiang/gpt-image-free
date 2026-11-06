//! 批量凭据授权：纯 Rust，不依赖用户机器上的 Python / curl_cffi。
//!
//! 早期版本复用本机后端 `source/.venv` 里的 Python worker 完成 OAuth + TOTP，
//! 但终端用户的 Windows 机器上通常没有这个 venv（后端可能是一键包或独立安装），
//! 结果整批账号都报「自动授权不可用」。这里改为在本进程内跑完整流程：
//!   authorize(PKCE) → password/verify → [TOTP mfa/verify] → oauth/token
//! 换出的 token 交给 commands 层统一写入号池。凭据只在内存里，不落盘。
//!
//! 依赖：reqwest（HTTP / 系统代理）、ring（SHA-256、HMAC-SHA1、安全随机数）、
//! base64、url。sentinel token 是尽力而为：生成失败时继续登录，与上游后端行为一致。

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ring::digest;
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::form_urlencoded;

const AUTH_BASE: &str = "https://auth.openai.com";
const PLATFORM_BASE: &str = "https://platform.openai.com";
const OAUTH_CLIENT_ID: &str = "app_2SKx67EdpoN0G6j64rFvigXD";
const OAUTH_AUDIENCE: &str = "https://api.openai.com/v1";
const OAUTH_REDIRECT: &str = "https://platform.openai.com/auth/callback";
const AUTH0_CLIENT: &str = "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const SEC_CH_UA: &str = "\"Chromium\";v=\"145\", \"Google Chrome\";v=\"145\", \"Not/A)Brand\";v=\"99\"";
const SENTINEL_SDK: &str = "https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js";
const MAX_AUTHORIZE_ACCOUNTS: usize = 100;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Credential {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub totp_secret: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct AuthResult {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub cached: bool,
}

pub struct AuthOutcome {
    pub ok: bool,
    pub error: String,
    pub results: Vec<AuthResult>,
}

struct Tokens {
    access_token: String,
    refresh_token: String,
    id_token: String,
}

/* ---------------------------------------------------------------- 基础工具 */

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn random_bytes(rng: &SystemRandom, n: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; n];
    rng.fill(&mut buf)
        .map_err(|_| "无法生成安全随机数".to_string())?;
    Ok(buf)
}

fn random_urlsafe(rng: &SystemRandom, n: usize) -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes(rng, n)?))
}

fn random_f64(rng: &SystemRandom) -> f64 {
    let mut b = [0u8; 8];
    if rng.fill(&mut b).is_err() {
        return 0.5;
    }
    (u64::from_be_bytes(b) as f64) / (u64::MAX as f64)
}

fn uuid_v4(rng: &SystemRandom) -> Result<String, String> {
    let b = random_bytes(rng, 16)?;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    ))
}

fn pkce(rng: &SystemRandom) -> Result<(String, String), String> {
    let verifier = URL_SAFE_NO_PAD.encode(random_bytes(rng, 64)?);
    let hash = digest::digest(&digest::SHA256, verifier.as_bytes());
    Ok((verifier, URL_SAFE_NO_PAD.encode(hash.as_ref())))
}

fn base32_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut bits: u32 = 0;
    let mut nbits: u32 = 0;
    let mut out = Vec::new();
    for ch in s.chars() {
        if ch == '=' {
            break;
        }
        let v = match ch {
            'A'..='Z' => (ch as u8 - b'A') as u32,
            '2'..='7' => 26 + (ch as u8 - b'2') as u32,
            _ => return Err("invalid_totp_secret_base32".to_string()),
        };
        bits = (bits << 5) | v;
        nbits += 5;
        if nbits >= 8 {
            nbits -= 8;
            out.push(((bits >> nbits) & 0xff) as u8);
        }
    }
    if out.is_empty() {
        return Err("invalid_totp_secret_base32".to_string());
    }
    Ok(out)
}

/// 从 Base32 密钥算当前 6 位 TOTP（RFC 6238，30s 步长，HMAC-SHA1）。
fn totp(secret: &str) -> Result<String, String> {
    if secret.trim().is_empty() {
        return Err("mfa_challenge_requires_totp_secret".to_string());
    }
    let clean: String = secret
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect::<String>()
        .to_uppercase();
    let padded = format!("{}{}", clean, "=".repeat((8 - clean.len() % 8) % 8));
    let key = base32_decode(&padded)?;
    let counter = (now_secs() / 30).to_be_bytes();
    let hkey = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, &key);
    let tag = hmac::sign(&hkey, &counter);
    let bytes = tag.as_ref();
    if bytes.len() < 20 {
        return Err("totp_generation_failed".to_string());
    }
    let offset = (bytes[19] & 0x0f) as usize;
    let code = u32::from_be_bytes([
        bytes[offset] & 0x7f,
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]) % 1_000_000;
    Ok(format!("{code:06}"))
}

/// 只解 JWT payload 看 exp，不验签：判断导入行自带的 token 是否还有效。
fn jwt_exp(token: &str) -> i64 {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return 0;
    }
    let segment = parts[1].trim_end_matches('=');
    let decoded = URL_SAFE_NO_PAD.decode(segment).unwrap_or_default();
    serde_json::from_slice::<Value>(&decoded)
        .ok()
        .and_then(|v| v.get("exp").and_then(|x| x.as_i64()))
        .unwrap_or(0)
}

fn code_from(data: &Value) -> Option<String> {
    let url = data.get("continue_url")?.as_str()?;
    let query = url.split_once('?')?.1;
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        if k.as_ref() == "code" && !v.is_empty() {
            return Some(v.into_owned());
        }
    }
    None
}

fn field<'a>(data: &'a Value, path: &str) -> Option<&'a str> {
    data.pointer(path).and_then(|v| v.as_str())
}

/// 把内部错误码翻译成用户能行动的原因，同时保留原始码方便排查。
fn friendly(error: &str) -> String {
    let text = match error {
        "invalid_password" => "密码错误",
        "need_email_verification_code" => "上游要求邮箱验证码，自动登录无法完成，请改用手动 OAuth 授权",
        "invalid_totp_secret_base32" => "2FA 密钥不是有效的 Base32，请检查第三字段",
        "mfa_challenge_requires_totp_secret" => "账号开启了 2FA，但这一行没有第三字段",
        "mfa_challenge_no_factor_id" => "上游未返回 2FA 验证因子",
        "no_auth_code" | "no_auth_code_obtained" => "登录后未拿到授权码（可能是风控或账号状态异常）",
        "empty_access_token" => "上游没有返回 access_token",
        _ if error.starts_with("authorize_failed_") => "授权页被拒绝，通常是网络/代理不通或被风控拦截，请检查代理设置",
        _ if error.starts_with("password_verify_failed_") => "密码验证请求被拒绝，请检查网络/代理后重试",
        _ if error.starts_with("mfa_verify_failed_") => "2FA 验证码被拒绝，请确认密钥正确且本机时间准确",
        _ if error.starts_with("token_exchange_failed_") => "换取 token 失败，请稍后重试",
        _ if error.contains("error sending request") || error.contains("dns") => "网络连接失败，请检查代理或网络",
        _ => error,
    };
    if text == error {
        text.to_string()
    } else {
        format!("{text}（{error}）")
    }
}

/* ------------------------------------------------------------------ HTTP */

/// 代理优先用显式传入，其次环境变量，最后探测常见本地代理端口。
/// Windows 的系统代理常常不在环境变量里，探测这一步很关键。
fn resolve_proxy(custom: &str) -> Option<String> {
    if !custom.trim().is_empty() {
        return Some(custom.trim().to_string());
    }
    for key in [
        "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
        "https_proxy", "http_proxy", "all_proxy",
    ] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    for port in [7890u16, 7897, 10809, 10808] {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok() {
            return Some(format!("http://127.0.0.1:{port}"));
        }
    }
    None
}

fn build_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent(USER_AGENT)
        .danger_accept_invalid_certs(true);
    if let Some(p) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(p).map_err(|e| format!("代理地址无效（{p}）：{e}"))?,
        );
    }
    builder
        .build()
        .map_err(|e| format!("创建授权 HTTP 客户端失败：{e}"))
}

/// reqwest 未开启 cookie_store feature，这里手动维护 Cookie 头。
struct Session<'a> {
    http: &'a reqwest::Client,
    cookies: HashMap<String, String>,
}

impl<'a> Session<'a> {
    fn new(http: &'a reqwest::Client) -> Self {
        Self { http, cookies: HashMap::new() }
    }

    fn set_cookie(&mut self, k: &str, v: &str) {
        self.cookies.insert(k.to_string(), v.to_string());
    }

    fn cookie_header(&self) -> String {
        self.cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn absorb(&mut self, headers: &reqwest::header::HeaderMap) {
        for raw in headers.get_all(reqwest::header::SET_COOKIE).iter() {
            let Ok(s) = raw.to_str() else { continue };
            let Some(pair) = s.split(';').next() else { continue };
            let Some((k, v)) = pair.split_once('=') else { continue };
            self.set_cookie(k.trim(), v.trim());
        }
    }

    async fn request(
        &mut self,
        method: reqwest::Method,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<(&str, String)>,
    ) -> Result<(u16, String), String> {
        let mut req = self
            .http
            .request(method, url.clone())
            .header(reqwest::header::COOKIE, self.cookie_header());
        for (k, v) in headers {
            if let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(&v),
            ) {
                req = req.header(name, value);
            }
        }
        if let Some((content_type, raw)) = body {
            req = req
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .body(raw);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("请求 {} 失败：{e}", short_url(&url)))?;
        self.absorb(resp.headers());
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        Ok((status, text))
    }
}

fn short_url(url: &str) -> String {
    url.split('?').next().unwrap_or(url).to_string()
}

fn browser_headers(referer: &str, device_id: &str) -> Vec<(String, String)> {
    vec![
        ("accept".into(), "application/json".into()),
        ("accept-language".into(), "zh-CN,zh;q=0.9".into()),
        ("origin".into(), AUTH_BASE.into()),
        ("priority".into(), "u=1, i".into()),
        ("sec-ch-ua".into(), SEC_CH_UA.into()),
        ("sec-ch-ua-mobile".into(), "?0".into()),
        ("sec-ch-ua-platform".into(), "\"Windows\"".into()),
        ("sec-fetch-dest".into(), "empty".into()),
        ("sec-fetch-mode".into(), "cors".into()),
        ("sec-fetch-site".into(), "same-origin".into()),
        ("referer".into(), referer.into()),
        ("oai-device-id".into(), device_id.into()),
    ]
}

/* -------------------------------------------------------------- Sentinel */

fn fnv1a32(text: &str) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for c in text.chars() {
        h ^= c as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h ^= h >> 16;
    h = h.wrapping_mul(2_246_822_507);
    h ^= h >> 13;
    h = h.wrapping_mul(3_266_489_909);
    h ^= h >> 16;
    h
}

fn pick<'a>(rng: &SystemRandom, options: &[&'a str]) -> &'a str {
    let i = (random_f64(rng) * options.len() as f64).floor() as usize;
    options[i.min(options.len() - 1)]
}

fn sentinel_config(rng: &SystemRandom, sid: &str) -> Value {
    let now = now_millis();
    let perf_now = 1000.0 + random_f64(rng) * 49_000.0;
    let choices = [4, 8, 12, 16];
    let chosen = choices[(random_f64(rng) * 4.0).floor() as usize & 3];
    json!([
        "1920x1080",
        format!("{now}"),
        4_294_705_152u64,
        random_f64(rng),
        USER_AGENT,
        SENTINEL_SDK,
        Value::Null,
        Value::Null,
        "en-US",
        random_f64(rng),
        pick(rng, &["vendorSub-undefined", "plugins-undefined", "mimeTypes-undefined", "hardwareConcurrency-undefined"]),
        pick(rng, &["location", "implementation", "URL", "documentURI", "compatMode"]),
        pick(rng, &["Object", "Function", "Array", "Number", "parseFloat", "undefined"]),
        perf_now,
        sid,
        "",
        chosen,
        now as f64 - perf_now,
    ])
}

fn b64_json(data: &Value) -> String {
    STANDARD.encode(serde_json::to_string(data).unwrap_or_default().as_bytes())
}

fn requirements_token(rng: &SystemRandom, sid: &str) -> String {
    let mut cfg = sentinel_config(rng, &sid);
    if let Some(arr) = cfg.as_array_mut() {
        arr[3] = json!(1);
        arr[9] = json!((5.0 + random_f64(rng) * 45.0).round() as i64);
    }
    format!("gAAAAAC{}", b64_json(&cfg))
}

fn pow_token(config: &Value, seed: &str, difficulty: &str) -> String {
    let n = difficulty.len().min(8);
    let target = &difficulty[..n];
    let start = now_millis();
    for i in 0..500_000u64 {
        let mut cfg = config.clone();
        if let Some(arr) = cfg.as_array_mut() {
            arr[3] = json!(i);
            arr[9] = json!((now_millis().saturating_sub(start)) as i64);
        }
        let payload = b64_json(&cfg);
        let hash = format!("{:08x}", fnv1a32(&format!("{seed}{payload}")));
        if &hash[..n] <= target {
            return format!("gAAAAAB{payload}~S");
        }
    }
    format!("gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D{}", b64_json(&Value::Null))
}

/// 尽力而为地生成 openai-sentinel-token；失败时返回 None，登录流程继续。
async fn sentinel_token(
    session: &mut Session<'_>,
    device_id: &str,
    flow: &str,
    rng: &SystemRandom,
) -> Option<(String, String)> {
    let sid = uuid_v4(rng).ok()?;
    let cfg = sentinel_config(rng, &sid);
    let body = json!({
        "p": requirements_token(rng, &sid),
        "id": device_id,
        "flow": flow,
    })
    .to_string();
    let headers = vec![
        ("Referer".into(), "https://sentinel.openai.com/backend-api/sentinel/frame.html".into()),
        ("Origin".into(), "https://sentinel.openai.com".into()),
        ("User-Agent".into(), USER_AGENT.into()),
        ("sec-ch-ua".into(), SEC_CH_UA.into()),
        ("sec-ch-ua-mobile".into(), "?0".into()),
        ("sec-ch-ua-platform".into(), "\"Windows\"".into()),
    ];
    let (status, text) = session
        .request(
            reqwest::Method::POST,
            "https://sentinel.openai.com/backend-api/sentinel/req".into(),
            headers,
            Some(("text/plain;charset=UTF-8", body)),
        )
        .await
        .ok()?;
    let data: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    if status != 200 {
        return None;
    }
    let token = field(&data, "/token").unwrap_or("").to_string();
    if token.is_empty() {
        return None;
    }
    let pow = data.get("proofofwork");
    let p = match pow.and_then(|p| p.get("required")).and_then(|v| v.as_bool()) {
        Some(true) => {
            let seed = pow.and_then(|p| field(p, "/seed")).unwrap_or("");
            let diff = pow.and_then(|p| field(p, "/difficulty")).unwrap_or("0");
            pow_token(&cfg, seed, diff)
        }
        _ => requirements_token(rng, &sid),
    };
    let value = json!({
        "p": p, "t": "", "c": token, "id": device_id, "flow": flow,
    })
    .to_string();
    Some((value, format!("0{token}")))
}

/* ------------------------------------------------------------- 登录主流程 */

async fn login(http: &reqwest::Client, cred: &Credential) -> Result<Tokens, String> {
    let rng = SystemRandom::new();
    let device_id = uuid_v4(&rng)?;
    let (code_verifier, code_challenge) = pkce(&rng)?;
    let mut session = Session::new(http);
    session.set_cookie("oai-did", &device_id);

    // 1. authorize
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("issuer", AUTH_BASE)
        .append_pair("client_id", OAUTH_CLIENT_ID)
        .append_pair("audience", OAUTH_AUDIENCE)
        .append_pair("redirect_uri", OAUTH_REDIRECT)
        .append_pair("device_id", &device_id)
        .append_pair("screen_hint", "login_or_signup")
        .append_pair("max_age", "0")
        .append_pair("login_hint", &cred.email)
        .append_pair("scope", "openid profile email offline_access")
        .append_pair("response_type", "code")
        .append_pair("response_mode", "query")
        .append_pair("state", &random_urlsafe(&rng, 32)?)
        .append_pair("nonce", &random_urlsafe(&rng, 32)?)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("auth0Client", AUTH0_CLIENT)
        .finish();
    let nav_headers = vec![
        ("accept".into(), "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8".into()),
        ("accept-language".into(), "zh-CN,zh;q=0.9".into()),
        ("sec-fetch-dest".into(), "document".into()),
        ("sec-fetch-mode".into(), "navigate".into()),
        ("sec-fetch-site".into(), "cross-site".into()),
        ("sec-fetch-user".into(), "?1".into()),
        ("upgrade-insecure-requests".into(), "1".into()),
        ("referer".into(), format!("{PLATFORM_BASE}/")),
    ];
    let (status, _) = session
        .request(
            reqwest::Method::GET,
            format!("{AUTH_BASE}/api/accounts/authorize?{query}"),
            nav_headers,
            None,
        )
        .await?;
    if status != 200 && status != 302 {
        return Err(format!("authorize_failed_{status}"));
    }

    // 2. password/verify
    let mut headers = browser_headers(&format!("{AUTH_BASE}/email-verification"), &device_id);
    if let Some((sentinel, oai_sc)) =
        sentinel_token(&mut session, &device_id, "password_verify", &rng).await
    {
        headers.push(("openai-sentinel-token".into(), sentinel));
        session.set_cookie("oai-sc", &oai_sc);
    }
    let (status, text) = session
        .request(
            reqwest::Method::POST,
            format!("{AUTH_BASE}/api/accounts/password/verify"),
            headers,
            Some((
                "application/json",
                json!({ "password": cred.password }).to_string(),
            )),
        )
        .await?;
    let data: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    if status != 200 {
        let msg = field(&data, "/error/message").unwrap_or("");
        if msg.contains("Invalid credentials") || msg.to_lowercase().contains("wrong password") {
            return Err("invalid_password".into());
        }
        return Err(format!("password_verify_failed_{status}"));
    }

    let mut auth_code = code_from(&data);
    if auth_code.is_none() {
        let page_type = field(&data, "/page/type").unwrap_or("");
        if page_type == "email_otp_verification" {
            return Err("need_email_verification_code".into());
        }
        if page_type != "mfa_challenge" {
            return Err("no_auth_code".into());
        }
        let payload = data
            .pointer("/page/payload")
            .cloned()
            .unwrap_or(Value::Null);
        let factor_id = field(&payload, "/factor_id")
            .map(|s| s.to_string())
            .or_else(|| {
                payload
                    .pointer("/factors/0/id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();
        if factor_id.is_empty() {
            return Err("mfa_challenge_no_factor_id".into());
        }
        let otp = totp(&cred.totp_secret)?;
        let mut mfa_headers =
            browser_headers(&format!("{AUTH_BASE}/mfa-challenge/{factor_id}"), &device_id);
        if let Some((sentinel, oai_sc)) =
            sentinel_token(&mut session, &device_id, "verify_mfa", &rng).await
        {
            mfa_headers.push(("openai-sentinel-token".into(), sentinel));
            session.set_cookie("oai-sc", &oai_sc);
        }
        let (mfa_status, mfa_text) = session
            .request(
                reqwest::Method::POST,
                format!("{AUTH_BASE}/api/accounts/mfa/verify"),
                mfa_headers,
                Some((
                    "application/json",
                    json!({ "id": factor_id, "type": "totp", "code": otp }).to_string(),
                )),
            )
            .await?;
        if mfa_status != 200 {
            return Err(format!("mfa_verify_failed_{mfa_status}"));
        }
        let mfa_data: Value = serde_json::from_str(&mfa_text).unwrap_or(json!({}));
        auth_code = code_from(&mfa_data);
    }
    let auth_code = auth_code.ok_or_else(|| "no_auth_code_obtained".to_string())?;

    // 3. oauth/token
    let token_headers = vec![
        ("accept".into(), "*/*".into()),
        ("accept-language".into(), "zh-CN,zh;q=0.9".into()),
        ("auth0-client".into(), AUTH0_CLIENT.into()),
        ("cache-control".into(), "no-cache".into()),
        ("origin".into(), PLATFORM_BASE.into()),
        ("pragma".into(), "no-cache".into()),
        ("referer".into(), format!("{PLATFORM_BASE}/")),
        ("sec-ch-ua".into(), SEC_CH_UA.into()),
        ("sec-ch-ua-mobile".into(), "?0".into()),
        ("sec-ch-ua-platform".into(), "\"Windows\"".into()),
        ("sec-fetch-dest".into(), "empty".into()),
        ("sec-fetch-mode".into(), "cors".into()),
        ("sec-fetch-site".into(), "same-site".into()),
    ];
    let token_payload = json!({
        "client_id": OAUTH_CLIENT_ID,
        "code_verifier": code_verifier,
        "grant_type": "authorization_code",
        "code": auth_code,
        "redirect_uri": OAUTH_REDIRECT,
    })
    .to_string();
    let (status, text) = session
        .request(
            reqwest::Method::POST,
            format!("{AUTH_BASE}/api/accounts/oauth/token"),
            token_headers,
            Some(("application/json", token_payload)),
        )
        .await?;
    if status != 200 {
        return Err(format!("token_exchange_failed_{status}"));
    }
    let data: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    let access_token = field(&data, "/access_token").unwrap_or("").to_string();
    if access_token.is_empty() {
        return Err("empty_access_token".into());
    }
    Ok(Tokens {
        access_token,
        refresh_token: field(&data, "/refresh_token").unwrap_or("").to_string(),
        id_token: field(&data, "/id_token").unwrap_or("").to_string(),
    })
}

pub async fn authorize(
    accounts: Vec<Credential>,
    proxy: Option<String>,
) -> Result<AuthOutcome, String> {
    if accounts.is_empty() {
        return Ok(AuthOutcome { ok: true, error: String::new(), results: vec![] });
    }
    if accounts.len() > MAX_AUTHORIZE_ACCOUNTS {
        return Err(format!("单次最多授权 {MAX_AUTHORIZE_ACCOUNTS} 个账号，请分批导入"));
    }
    let resolved = resolve_proxy(proxy.as_deref().unwrap_or(""));
    let http = build_client(resolved.as_deref())?;
    let now = now_secs() as i64;
    let mut results = Vec::new();

    for cred in accounts {
        let email = cred.email.clone();
        if email.is_empty() || cred.password.is_empty() {
            results.push(AuthResult {
                email,
                error: "邮箱或密码为空".into(),
                ..Default::default()
            });
            continue;
        }
        // 自带且未过期的 token 直接复用，不再打扰上游登录。
        if !cred.access_token.is_empty() && jwt_exp(&cred.access_token) > now + 60 {
            results.push(AuthResult {
                email,
                ok: true,
                access_token: cred.access_token.clone(),
                refresh_token: cred.refresh_token.clone(),
                cached: true,
                ..Default::default()
            });
            continue;
        }
        match login(&http, &cred).await {
            Ok(t) => results.push(AuthResult {
                email,
                ok: true,
                access_token: t.access_token,
                refresh_token: t.refresh_token,
                id_token: t.id_token,
                ..Default::default()
            }),
            Err(e) => results.push(AuthResult {
                email,
                error: friendly(&e),
                ..Default::default()
            }),
        }
    }
    Ok(AuthOutcome { ok: true, error: String::new(), results })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_sha256_of_verifier() {
        let rng = SystemRandom::new();
        let (verifier, challenge) = pkce(&rng).unwrap();
        let hash = digest::digest(&digest::SHA256, verifier.as_bytes());
        assert_eq!(challenge, URL_SAFE_NO_PAD.encode(hash.as_ref()));
        assert!(!verifier.contains('='));
    }

    #[test]
    fn totp_matches_rfc6238_test_vector() {
        // RFC 6238 的 8 位结果 94287082，取模 1e6 后应为 287082。
        let key = b"12345678901234567890";
        let counter = 1u64.to_be_bytes();
        let hkey = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, key);
        let tag = hmac::sign(&hkey, &counter);
        let b = tag.as_ref();
        let off = (b[19] & 0x0f) as usize;
        let code = u32::from_be_bytes([b[off] & 0x7f, b[off + 1], b[off + 2], b[off + 3]]) % 1_000_000;
        assert_eq!(code, 287082);
    }

    #[test]
    fn base32_decode_handles_padded_secret() {
        assert_eq!(base32_decode("ABCDEFGHIJKLMNOP").unwrap().len(), 10);
        assert!(base32_decode("NOT!VALID").is_err());
    }

    #[test]
    fn fnv1a32_matches_python_reference() {
        assert_eq!(format!("{:08x}", fnv1a32("hello")), "888d766e");
    }

    #[test]
    fn code_from_parses_continue_url() {
        let v = json!({ "continue_url": "https://platform.openai.com/auth/callback?code=abc%2Fdef&state=x" });
        assert_eq!(code_from(&v).as_deref(), Some("abc/def"));
        assert!(code_from(&json!({})).is_none());
    }

    #[test]
    fn jwt_exp_reads_unpadded_payload() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"exp":1793958285}"#);
        let token = format!("aaa.{payload}.sig");
        assert_eq!(jwt_exp(&token), 1_793_958_285);
        assert_eq!(jwt_exp("not-a-jwt"), 0);
    }

    #[test]
    fn friendly_errors_are_actionable() {
        assert!(friendly("invalid_password").contains("密码错误"));
        assert!(friendly("authorize_failed_403").contains("代理"));
        assert!(friendly("need_email_verification_code").contains("手动 OAuth"));
    }

    #[test]
    fn credential_deserialization_tolerates_missing_optional_fields() {
        let c: Credential = serde_json::from_str(r#"{"email":"a@b.com","password":"pw"}"#).unwrap();
        assert_eq!(c.totp_secret, "");
        assert_eq!(c.access_token, "");
    }
}
