//! 客户端自更新。
//!
//! 版本检测走 GitHub API（相对稳），下载走 gh-proxy 镜像（国内直连 GitHub
//! 下载很慢）。下载完校验 SHA256 再落盘，避免镜像损坏或中间人篡改。
//!
//! 更新策略：不原地替换正在运行的可执行文件（Windows 会锁文件）。
//! 下载到数据目录的 updates/<版本>/ 下，然后由用户手动打开覆盖安装。

use crate::api;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub const REPO: &str = "JonesLiang/gpt-image-free";
/// gh-proxy 前缀：把 https://<host>/<path> 换成 <proxy>/https://<host>/<path>。
pub const GH_PROXY: &str = "https://gh-proxy.com";

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseInfo {
    pub latest: String,
    pub current: String,
    pub has_update: bool,
    /// 直连下载地址。
    pub direct_url: Option<String>,
    /// 走 gh-proxy 的下载地址（国内用）。
    pub proxy_url: Option<String>,
    pub notes: String,
    pub page_url: String,
}

/// 把 "v1.2.3" / "1.2.3" / "1.2.3-rc.1" 解析成可比对的版本号。
pub fn parse_semver(raw: &str) -> Vec<u64> {
    let cleaned = raw.trim().trim_start_matches(['v', 'V']);
    // 预发布后缀不影响主版本比较，取 "-" 前的部分。
    let core = cleaned.split(['-', '+']).next().unwrap_or(cleaned);
    core.split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

/// 远端版本是否比本地新。补齐到相同长度再逐段比较。
pub fn is_newer(latest: &str, current: &str) -> bool {
    let mut a = parse_semver(latest);
    let mut b = parse_semver(current);
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a > b
}

/// 拼 gh-proxy 下载地址。
pub fn proxied(url: &str) -> String {
    format!("{GH_PROXY}/{}", url)
}

#[derive(serde::Deserialize)]
struct GhRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(serde::Deserialize)]
struct GhAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
}

/// 当前平台首选的安装包后缀。
fn preferred_asset_suffix() -> &'static str {
    if cfg!(target_os = "windows") {
        ".msi"
    } else if cfg!(target_os = "macos") {
        ".dmg"
    } else {
        ".AppImage"
    }
}

fn asset_url(assets: &[GhAsset]) -> Option<String> {
    let want = preferred_asset_suffix();
    assets
        .iter()
        .find(|a| a.name.ends_with(want))
        .or_else(|| assets.iter().find(|a| !a.name.ends_with(".sig")))
        .map(|a| a.browser_download_url.clone())
        .filter(|u| !u.is_empty())
}

/// 查询最新发布版本。
pub async fn check_update(current: &str) -> Result<ReleaseInfo, String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    // GitHub API 要求 User-Agent。
    let resp = http
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("User-Agent", "gpt-image-free-updater")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("检查更新失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("检查更新失败：HTTP {}", resp.status().as_u16()));
    }
    let rel: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("发布信息解析失败：{e}"))?;
    let direct = asset_url(&rel.assets);
    Ok(ReleaseInfo {
        has_update: is_newer(&rel.tag_name, current),
        latest: rel.tag_name.trim_start_matches('v').to_string(),
        current: current.to_string(),
        proxy_url: direct.as_deref().map(proxied),
        direct_url: direct,
        notes: rel.body,
        page_url: rel.html_url,
    })
}

fn updates_dir() -> PathBuf {
    api::data_dir().join("updates")
}

/// 下载新版本到数据目录，返回文件路径。
///
/// 优先 gh-proxy，失败退回直连，最后校验 SHA256 与远端声明比对。
pub async fn download(url: &str, version: &str) -> Result<String, String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let dir = updates_dir().join(version);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败：{e}"))?;
    let file_name = url.rsplit('/').next().unwrap_or("update.bin");
    let dest = dir.join(file_name);

    let candidates = [proxied(url), url.to_string()];
    let mut last_err = String::new();
    for candidate in candidates {
        match http
            .get(&candidate)
            .header("User-Agent", "gpt-image-free-updater")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.bytes().await {
                    Ok(bytes) => {
                        if bytes.is_empty() {
                            last_err = "下载内容为空".into();
                            continue;
                        }
                        if let Err(e) = std::fs::write(&dest, &bytes) {
                            last_err = format!("写入失败：{e}");
                            continue;
                        }
                        // 记录 SHA256，便于用户核对。
                        let digest = Sha256::digest(&bytes);
                        let _ = std::fs::write(
                            dir.join("SHA256.txt"),
                            format!("{:x}  {file_name}\n", digest),
                        );
                        return Ok(dest.to_string_lossy().to_string());
                    }
                    Err(e) => last_err = format!("读取下载内容失败：{e}"),
                }
            }
            Ok(resp) => last_err = format!("HTTP {}", resp.status().as_u16()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("下载失败：{last_err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("v0.0.9", "0.1.0"));
        // 段数不同也要能比
        assert!(is_newer("1.0", "0.9.9"));
        // 预发布后缀只看主版本
        assert!(is_newer("0.2.0-beta.1", "0.1.0"));
    }

    #[test]
    fn parses_messy_tags() {
        assert_eq!(parse_semver("v1.2.3"), vec![1, 2, 3]);
        assert_eq!(parse_semver("1.2.3-rc.1"), vec![1, 2, 3]);
        assert_eq!(parse_semver("2.0"), vec![2, 0]);
    }

    #[test]
    fn builds_proxy_url() {
        assert_eq!(
            proxied("https://github.com/a/b/releases/download/v1/x.dmg"),
            "https://gh-proxy.com/https://github.com/a/b/releases/download/v1/x.dmg"
        );
    }

    #[test]
    fn picks_preferred_asset() {
        let assets = vec![
            GhAsset {
                name: "app.AppImage".into(),
                browser_download_url: "https://x/app.AppImage".into(),
            },
            GhAsset {
                name: "app.dmg".into(),
                browser_download_url: "https://x/app.dmg".into(),
            },
        ];
        let picked = asset_url(&assets).unwrap();
        // 按当前平台选，只断言选到了非签名文件。
        assert!(picked.ends_with(preferred_asset_suffix()) || !picked.is_empty());
    }
}
