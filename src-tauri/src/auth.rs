//! 批量凭据授权：把「邮箱 / 密码 / 2FA 密钥」换成本机号池能用的 token。
//!
//! 本机后端没有「邮箱+密码+2FA 换 token」的 HTTP 接口（它的 `_login_with_password`
//! 只服务于已有账号的重新登录，且遇到邮箱验证码就放弃）。所以这里复用后端
//! venv 里的 curl_cffi + utils/pkce + utils/sentinel，跑一个独立 Python worker
//! 完成完整 OAuth + TOTP 流程；换出的 token 再由 commands 层统一写入号池。
//!
//! worker 只在内存里持有凭据，不落盘；stdout 恒为一条 JSON 便于解析。

use crate::api;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// 编译期嵌入，运行时写到数据目录，dev 与打包产物行为一致，不用配 bundle.resources。
const WORKER_SOURCE: &str = include_str!("../../scripts/auth_worker.py");

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

#[derive(Debug, Deserialize, Serialize, Clone)]
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

#[derive(Debug, Deserialize)]
pub struct WorkerOutput {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub results: Vec<AuthResult>,
}

pub fn source_dir() -> PathBuf {
    api::data_dir().join("source")
}

fn worker_path() -> PathBuf {
    api::data_dir().join("auth_worker.py")
}

fn ensure_worker() -> Result<PathBuf, String> {
    let dir = api::data_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建数据目录 {}：{e}", dir.display()))?;
    let path = worker_path();
    // 每次覆盖，保证客户端升级后 worker 同步更新，不会残留旧脚本。
    std::fs::write(&path, WORKER_SOURCE)
        .map_err(|e| format!("无法写入授权脚本 {}：{e}", path.display()))?;
    Ok(path)
}

/// DSH 管理的后端 venv：Windows 在 Scripts/python.exe，其他平台在 bin/python。
fn resolve_python() -> Result<PathBuf, String> {
    let venv = source_dir().join(".venv");
    let python = if cfg!(target_os = "windows") {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    };
    if python.exists() {
        return Ok(python);
    }
    Err(format!(
        "未找到本机后端的 Python 环境（{}）。请确认 chatgpt2api-native 已安装并完成初始化；也可以改用页面下方的手动 OAuth 授权。",
        python.display()
    ))
}

fn run_worker_blocking(
    python: PathBuf,
    script: PathBuf,
    payload: String,
    timeout: Duration,
) -> Result<WorkerOutput, String> {
    let cwd = source_dir();
    let mut child = std::process::Command::new(&python)
        .arg(&script)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动授权进程 {}：{e}", python.display()))?;

    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法打开授权进程标准输入".to_string())?;
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| format!("写入凭据失败：{e}"))?;
        // drop 关闭 stdin，worker 才会开始读输入。
    }

    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_handle = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_handle = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("授权执行超时，请减少单次导入数量后重试".to_string());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("等待授权进程失败：{e}")),
        }
    };
    let out = out_handle.join().unwrap_or_default();
    let err = err_handle.join().unwrap_or_default();
    if !status.success() {
        let tail: String = err.chars().rev().take(400).collect::<String>().chars().rev().collect();
        return Err(format!("授权脚本异常退出（{}）：{}", status, tail));
    }
    let text = out.trim();
    if text.is_empty() {
        return Err("授权脚本没有返回数据".to_string());
    }
    // 只取最后一行，前面即便混入别的内容也不影响解析。
    let line = text.lines().last().unwrap_or(text);
    serde_json::from_str::<WorkerOutput>(line)
        .map_err(|e| format!("授权脚本返回无效数据：{e}；原始输出：{}", text.chars().take(300).collect::<String>()))
}

pub async fn authorize(
    accounts: Vec<Credential>,
    proxy: Option<String>,
) -> Result<WorkerOutput, String> {
    if accounts.is_empty() {
        return Ok(WorkerOutput { ok: true, error: String::new(), results: vec![] });
    }
    let python = resolve_python()?;
    let script = ensure_worker()?;
    let payload = serde_json::json!({
        "accounts": accounts,
        "source_dir": source_dir().to_string_lossy(),
        "proxy": proxy.unwrap_or_default(),
    })
    .to_string();
    // 每个账号给 45s 余量，最少 60s；与 DSH 插件的超时策略一致。
    let timeout = Duration::from_secs((accounts.len() as u64 * 45).max(60));

    let output = tokio::task::spawn_blocking(move || {
        run_worker_blocking(python, script, payload, timeout)
    })
    .await
    .map_err(|e| format!("授权任务异常：{e}"))??;

    if !output.ok {
        return Err(output.error);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_source_is_embedded() {
        assert!(WORKER_SOURCE.contains("def login_with_password_and_totp"));
        assert!(WORKER_SOURCE.contains("stdout"));
    }

    #[test]
    fn credential_deserialization_tolerates_missing_optional_fields() {
        let c: Credential = serde_json::from_str(r#"{"email":"a@b.com","password":"pw"}"#).unwrap();
        assert_eq!(c.totp_secret, "");
        assert_eq!(c.access_token, "");
    }

    #[test]
    fn worker_output_parses_results() {
        let raw = r#"{"ok":true,"results":[{"email":"a@b.com","ok":true,"access_token":"t"},{"email":"c@d.com","ok":false,"error":"invalid_password"}]}"#;
        let out: WorkerOutput = serde_json::from_str(raw).unwrap();
        assert_eq!(out.results.len(), 2);
        assert!(out.results[0].ok);
        assert_eq!(out.results[1].error, "invalid_password");
    }
}
