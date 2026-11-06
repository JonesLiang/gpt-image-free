//! 客户端自更新。
//!
//! 版本检测走 GitHub API（相对稳），下载走 gh-proxy 镜像（国内直连 GitHub
//! 下载很慢）。下载完校验 SHA256 再落盘，避免镜像损坏或中间人篡改。
//!
//! 更新策略：不原地替换正在运行的可执行文件（Windows 会锁文件）。
//! 下载到数据目录 updates/<版本>/，校验通过后由应用内安装命令覆盖安装：
//! macOS 挂载 dmg 覆盖 /Applications，Windows 走 NSIS /S 静默安装，
//! 完成后用户在提示条上点「立即重启」即可。

use crate::api;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub const REPO: &str = "JonesLiang/gpt-image-free";
/// GitHub 网页域名。查版本只读它的 302 跳转，不占用 API 配额。
pub const GITHUB: &str = "https://github.com";
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

/// 前端可能传直连地址，也可能传已经拼好的代理地址。统一还原成直连，
/// 否则 download() 会再包一层代理前缀，拿到双重前缀的错误页。
fn canonical_url(url: &str) -> &str {
    url.strip_prefix(GH_PROXY)
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or(url)
}

/// 下载到 404 页面 / 镜像错误页时不能当安装包写盘，否则后面挂载 dmg
/// 或静默安装会以完全看不懂的方式失败。按平台校验魔数和最小体积。
fn plausible_installer(bytes: &[u8]) -> bool {
    if bytes.len() < 64 * 1024 {
        return false;
    }
    let head = &bytes[..bytes.len().min(512)];
    let low = String::from_utf8_lossy(head).to_ascii_lowercase();
    if low.contains("<!doctype html") || low.contains("<html") || low.contains("404: not found") {
        return false;
    }
    #[cfg(target_os = "windows")]
    if !bytes.starts_with(b"MZ") {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        // UDIF dmg 的尾部 trailer 以 "koly" 开头。
        let tail = &bytes[bytes.len() - 512..];
        if !tail.starts_with(b"koly") {
            return false;
        }
    }
    true
}

/// 从指向 /releases/tag/vX.Y.Z 的地址里取出 tag。
///
/// 输入可能是 Location 头，也可能是整页 HTML。整页 HTML 里还会出现
/// GitHub 自己的路由模板 `/:user_id/:repository/releases/tag/*name`，
/// 所以必须跳过所有非版本号开头的命中，取第一个合法的。
fn tag_from_location(location: &str) -> Option<String> {
    const MARK: &str = "/releases/tag/";
    let mut from = 0usize;
    while let Some(rel) = location[from..].find(MARK) {
        let start = from + rel + MARK.len();
        let tag: String = location[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
            .collect();
        // 必须以数字开头（tag 形如 v1.2.3 或 1.2.3），且要看得到数字，
        // 这样能滤掉 `*name`、`%7B` 这类模板片段。
        if tag.starts_with(|c: char| c.is_ascii_digit())
            || (tag.len() > 1
                && matches!(tag.as_bytes()[0], b'v' | b'V')
                && tag.as_bytes()[1].is_ascii_digit())
        {
            return Some(tag);
        }
        from = start;
    }
    None
}

/// 从 HTML 里兜底找 tag（等价的另一个入口，语义上区分来源）。
fn tag_from_html(html: &str) -> Option<String> {
    tag_from_location(html)
}

/// 当前平台安装包的完整文件名后缀。
///
/// 文件名规则来自 release.yml 的产物：
///   Windows  GPT.Image.Free_<v>_x64-setup.exe
///   macOS    GPT.Image.Free_<v>_aarch64.dmg / _x64.dmg
///   Linux    GPT.Image.Free_<v>_amd64.AppImage
fn asset_suffix() -> &'static str {
    if cfg!(target_os = "windows") {
        "_x64-setup.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "_aarch64.dmg"
        } else {
            "_x64.dmg"
        }
    } else {
        "_amd64.AppImage"
    }
}

/// 查询最新发布版本。
///
/// 不用 api.github.com：匿名调用每小时只有 60 次配额，用户点几次「检查更新」
/// 就会 403。这里请求 releases/latest，只读它的 302 跳转地址
/// （/releases/tag/vX.Y.Z）来拿版本号，完全不计入 API 配额。
pub async fn check_update(current: &str) -> Result<ReleaseInfo, String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        // 必须手动关掉重定向，才能读到 Location 头。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let candidates = [
        proxied(&format!("{GITHUB}/{REPO}/releases/latest")),
        format!("{GITHUB}/{REPO}/releases/latest"),
    ];
    let mut last_err = String::new();
    for url in candidates {
        let resp = match http
            .get(&url)
            .header("User-Agent", "gpt-image-free-updater")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                // 某个镜像不通就换下一个。
                last_err = e.to_string();
                continue;
            }
        };
        let status = resp.status();
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        // 有发布时 GitHub 返回 302（可能多跳一次到同一 tag）。
        if let Some(tag) = tag_from_location(&location) {
            return Ok(build_info(&tag, current));
        }
        // 镜像吃掉了跳转、直接回 200：从页面内容里再找一次。
        if status.is_success() {
            if let Ok(body) = resp.text().await {
                if let Some(tag) = tag_from_location(&body).or_else(|| tag_from_html(&body)) {
                    return Ok(build_info(&tag, current));
                }
            }
            last_err = "HTTP 200（页面里没找到版本号）".into();
            continue;
        }
        last_err = format!("HTTP {}", status.as_u16());
        if !location.is_empty() {
            last_err.push_str(&format!("，Location={location}"));
        }
    }
    Err(format!(
        "检查更新失败：{last_err}。仓库还没有发布版本时这是正常的"
    ))
}

/// 由 tag 推出下载地址。文件名规则由 release.yml 的产物决定：
/// `GPT.Image.Free_<版本>_<架构>.<后缀>`。
fn build_info(tag: &str, current: &str) -> ReleaseInfo {
    let version = tag.trim_start_matches('v').to_string();
    let direct = format!(
        "{GITHUB}/{REPO}/releases/download/{tag}/GPT.Image.Free_{version}{}",
        asset_suffix()
    );
    ReleaseInfo {
        has_update: is_newer(tag, current),
        latest: version,
        current: current.to_string(),
        proxy_url: Some(proxied(&direct)),
        direct_url: Some(direct),
        notes: String::new(),
        page_url: format!("{GITHUB}/{REPO}/releases/tag/{tag}"),
    }
}

fn updates_dir() -> PathBuf {
    api::data_dir().join("updates")
}

/// 下载新版本到数据目录，返回文件路径。
///
/// 优先 gh-proxy，失败退回直连；落盘前校验安装包魔数，避免把错误页
/// 当成 dmg / exe，落盘后记一份 SHA256 便于人工核对。
pub async fn download(url: &str, version: &str) -> Result<String, String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let canonical = canonical_url(url);
    let dir = updates_dir().join(version);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败：{e}"))?;
    let file_name = canonical.rsplit('/').next().unwrap_or("update.bin");
    let dest = dir.join(file_name);

    let candidates = [proxied(canonical), canonical.to_string()];
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
                        if !plausible_installer(&bytes) {
                            last_err = "下载内容不是有效的安装包（可能拿到了错误页）".into();
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

/// 安装已经下载好的安装包，返回安装后的应用路径。
///
/// macOS：挂载 dmg → 把 .app 覆盖到 /Applications → 去掉隔离属性。
/// 覆盖前先把旧 app 移到 updates/ 下的备份位置，失败可原样回滚，
/// 不会留下一个「半新半旧」无法启动的应用。
pub fn install(path: &str, version: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        install_macos(path, version)
    }
    #[cfg(target_os = "windows")]
    {
        install_windows(path, version)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (path, version);
        Err("当前平台暂不支持自动安装，请手动打开安装包".into())
    }
}

#[cfg(target_os = "macos")]
fn install_macos(path: &str, version: &str) -> Result<String, String> {
    use std::process::Command;

    let dmg = PathBuf::from(path);
    if !dmg.is_file() {
        return Err("安装包不存在，请先下载".into());
    }
    let work = updates_dir().join(version);
    std::fs::create_dir_all(&work).map_err(|e| format!("创建更新目录失败：{e}"))?;
    let mount = work.join("mnt");
    if mount.exists() {
        // 只清理自己数据目录里的临时挂载点。
        let _ = std::fs::remove_dir_all(&mount);
    }
    std::fs::create_dir_all(&mount).map_err(|e| format!("创建挂载点失败：{e}"))?;

    let attached = Command::new("hdiutil")
        .args(["attach", dmg.to_string_lossy().as_ref(), "-nobrowse", "-readonly", "-mountpoint", mount.to_string_lossy().as_ref()])
        .output()
        .map_err(|e| format!("挂载安装包失败：{e}"))?;
    if !attached.status.success() {
        return Err(format!(
            "挂载安装包失败：{}",
            String::from_utf8_lossy(&attached.stderr).trim()
        ));
    }

    let result = (|| -> Result<String, String> {
        let app_src = std::fs::read_dir(&mount)
            .map_err(|e| format!("读取安装包失败：{e}"))?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().and_then(|s| s.to_str()) == Some("app"))
            .ok_or_else(|| "安装包里没有找到 .app".to_string())?;

        let dest = PathBuf::from("/Applications/GPT Image Free.app");
        // 备份点放在 /Applications 内部：同一卷内 rename 才是原子操作，
        // 挪到数据目录可能跨卷，rename 会以 EXDEV 直接失败。
        let staging = PathBuf::from("/Applications/.GPT Image Free.old.app");
        if staging.exists() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        if dest.exists() {
            std::fs::rename(&dest, &staging).map_err(|e| format!("备份旧版本失败：{e}"))?;
        }

        let copied = Command::new("cp")
            .arg("-R")
            .arg(&app_src)
            .arg(&dest)
            .output()
            .map_err(|e| format!("复制新版本失败：{e}"))?;
        if !copied.status.success() {
            if staging.exists() {
                let _ = std::fs::rename(&staging, &dest);
            }
            return Err(format!(
                "安装失败，已回滚：{}",
                String::from_utf8_lossy(&copied.stderr).trim()
            ));
        }

        // 网络下载来的包可能带 com.apple.quarantine，去掉才能直接启动。
        let _ = Command::new("xattr")
            .args(["-cr", dest.to_string_lossy().as_ref()])
            .output();
        if staging.exists() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        Ok(dest.to_string_lossy().to_string())
    })();

    let _ = Command::new("hdiutil")
        .args(["detach", mount.to_string_lossy().as_ref(), "-force"])
        .output();
    result
}

#[cfg(target_os = "windows")]
fn install_windows(path: &str, _version: &str) -> Result<String, String> {
    use std::process::Command;
    let setup = PathBuf::from(path);
    if !setup.is_file() {
        return Err("安装包不存在，请先下载".into());
    }
    Command::new(&setup)
        .arg("/S")
        .spawn()
        .map_err(|e| format!("启动安装程序失败：{e}"))?;
    Ok("静默安装已启动，完成后重启应用即可生效".into())
}

/// 启动新版本并退出当前进程。
pub fn restart() -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-n", "/Applications/GPT Image Free.app"])
            .spawn()
            .map_err(|e| format!("重启失败：{e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let exe = std::env::current_exe().map_err(|e| format!("找不到当前程序：{e}"))?;
        Command::new(exe).spawn().map_err(|e| format!("重启失败：{e}"))?;
    }
    std::process::exit(0);
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
    fn canonicalizes_proxy_urls() {
        let direct = "https://github.com/a/b/releases/download/v1/x.dmg";
        assert_eq!(canonical_url(direct), direct);
        // 前端万一传了代理地址，也要还原成直连再拼前缀。
        assert_eq!(canonical_url(&proxied(direct)), direct);
        assert_eq!(canonical_url(&proxied(&proxied(direct))), proxied(direct));
    }

    #[test]
    fn rejects_error_pages_as_installer() {
        let html = format!("<!DOCTYPE html><html>404: Not Found</html>{}", "x".repeat(70 * 1024));
        assert!(!plausible_installer(html.as_bytes()));
        assert!(!plausible_installer(b"tiny"));
    }

    #[test]
    fn reads_tag_from_redirect() {
        assert_eq!(
            tag_from_location("https://github.com/a/b/releases/tag/v1.2.3"),
            Some("v1.2.3".into())
        );
        // 多跳一层或带查询串也要能认出来。
        assert_eq!(
            tag_from_location("https://gh-proxy.com/https://github.com/a/b/releases/tag/v0.4.1?x=1"),
            Some("v0.4.1".into())
        );
        assert_eq!(tag_from_location("https://github.com/a/b/releases"), None);
        assert_eq!(tag_from_location(""), None);
    }

    #[test]
    fn reads_tag_from_html_when_proxy_swallows_redirect() {
        // gh-proxy 直接回 200，只能从页面里捞链接。
        let html = r#"<a href="https://github.com/a/b/releases/tag/v0.3.2">v0.3.2</a>"#;
        assert_eq!(tag_from_html(html).as_deref(), Some("v0.3.2"));
        assert_eq!(tag_from_html("<html>nothing</html>"), None);
    }

    #[test]
    fn skips_route_template_in_page_head() {
        // 真实页面前半段有 GitHub 自己的路由模板，不能当版本号。
        let page = concat!(
            r#"<meta name="route-pattern" content="/:user_id/:repository/releases/tag/*name">"#,
            r#"<a href="https://github.com/a/b/releases/tag/v0.1.0">"#,
        );
        assert_eq!(tag_from_location(page).as_deref(), Some("v0.1.0"));
        assert_eq!(tag_from_location("/releases/tag/*name"), None);
        assert_eq!(tag_from_location("/releases/tag/%7Bname%7D"), None);
    }

    #[test]
    fn builds_download_url_from_tag() {
        let info = build_info("v0.2.0", "0.1.0");
        assert!(info.has_update);
        assert_eq!(info.latest, "0.2.0");
        let url = info.direct_url.unwrap();
        assert!(url.contains("/releases/download/v0.2.0/GPT.Image.Free_0.2.0"));
        assert!(url.ends_with(asset_suffix()));
        // 代理地址一定是代理前缀 + 原始直连地址。
        assert_eq!(info.proxy_url.unwrap(), proxied(&url));
    }
}
