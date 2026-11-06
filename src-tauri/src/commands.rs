//! Tauri 命令层：前端通过 `invoke` 调用这里的函数。

use crate::accounts::AccountView;
use crate::api::{self, ApiError, Client};
use crate::chat::Conversation;
use crate::settings::Settings;
use crate::updater::{self, ReleaseInfo};
use serde::Serialize;
use std::sync::Mutex;

pub struct AppState {
    settings: Mutex<Settings>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(Settings::load()),
        }
    }
}

fn client(state: &AppState) -> Client {
    let base = state
        .settings
        .lock()
        .map(|s| s.base_url.clone())
        .unwrap_or_else(|_| api::DEFAULT_BASE_URL.to_string());
    Client::new(Some(base))
}

fn err(e: ApiError) -> String {
    e.to_string()
}

#[derive(Serialize)]
pub struct BootInfo {
    pub version: String,
    pub repo: String,
    pub base_url: String,
    pub data_dir: String,
    pub images_dir: String,
    pub settings: Settings,
}

#[tauri::command]
pub fn boot_info(state: tauri::State<'_, AppState>) -> BootInfo {
    let settings = state
        .settings
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    BootInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        repo: updater::REPO.to_string(),
        base_url: settings.base_url.clone(),
        data_dir: api::data_dir().to_string_lossy().to_string(),
        images_dir: crate::storage::images_dir().to_string_lossy().to_string(),
        settings,
    }
}

/// 后端是否在线。前端启动时先探一下，离线直接显示提示，不做无谓请求。
#[tauri::command]
pub async fn backend_health(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let c = client(&state);
    match c.list_accounts().await {
        Ok(_) => Ok(true),
        Err(ApiError::Offline(_)) => Ok(false),
        // 401 等说明服务在跑，只是 key 不对——仍然算在线，让上层报具体错误。
        Err(_) => Ok(true),
    }
}

#[tauri::command]
pub async fn list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<AccountView>, String> {
    let c = client(&state);
    let accounts = c.list_accounts().await.map_err(err)?;
    Ok(api::to_views(&accounts, api::now_millis()))
}

/// 刷新额度：重新拉取并重新判定状态（被限流但窗口已过的账号会回到可用）。
#[tauri::command]
pub async fn refresh_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<AccountView>, String> {
    let c = client(&state);
    let accounts = c.refresh_accounts().await.map_err(err)?;
    Ok(api::to_views(&accounts, api::now_millis()))
}

#[tauri::command]
pub async fn delete_accounts(
    state: tauri::State<'_, AppState>,
    tokens: Vec<String>,
) -> Result<(), String> {
    if tokens.is_empty() {
        return Ok(());
    }
    let c = client(&state);
    c.delete_accounts(&tokens).await.map_err(err)
}

/// 执行一轮生图。
///
/// `reference` 是上一张图的 base64；给了就基于它改图，没给就纯文生图。
#[tauri::command]
pub async fn generate(
    state: tauri::State<'_, AppState>,
    prompt: String,
    account_token: Option<String>,
    reference: Option<String>,
    text_reply: Option<bool>,
) -> Result<GenerateResult, String> {
    let c = client(&state);
    let default_text = state
        .settings
        .lock()
        .map(|s| s.text_reply)
        .unwrap_or(false);
    let want_text = text_reply.unwrap_or(default_text);

    let image = c
        .generate_image(&prompt, account_token.as_deref(), reference)
        .await
        .map_err(err)?;

    // 图片先落盘：即使后面文字失败，图也不会丢。
    let saved = crate::storage::save_png(&image).ok();

    let text = if want_text {
        c.chat_text(&prompt).await.ok().filter(|t| !t.trim().is_empty())
    } else {
        None
    };

    let display = if image.starts_with("data:") {
        image
    } else {
        format!("data:image/png;base64,{image}")
    };

    Ok(GenerateResult {
        image: display,
        text,
        path: saved.map(|p| p.to_string_lossy().to_string()),
    })
}

#[derive(Serialize)]
pub struct GenerateResult {
    pub image: String,
    pub text: Option<String>,
    pub path: Option<String>,
}

#[tauri::command]
pub fn save_settings(state: tauri::State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let mut normalized = settings;
    normalized.context_rounds = normalized.context_rounds.clamp(1, 50);
    if normalized.base_url.trim().is_empty() {
        normalized.base_url = api::DEFAULT_BASE_URL.to_string();
    }
    normalized.save()?;
    if let Ok(mut guard) = state.settings.lock() {
        *guard = normalized.clone();
    }
    Ok(normalized)
}

#[tauri::command]
pub async fn check_update() -> Result<ReleaseInfo, String> {
    updater::check_update(env!("CARGO_PKG_VERSION")).await
}

#[tauri::command]
pub async fn download_update(url: String, version: String) -> Result<String, String> {
    updater::download(&url, &version).await
}

/// 把一次会话生图的结果记进会话结构（前端传完整会话，后端只负责落盘与校验）。
/// 目前会话只在前端内存中，这个命令留给后续持久化使用。
#[tauri::command]
pub fn conversation_summary(conversation: Conversation) -> serde_json::Value {
    serde_json::json!({
        "id": conversation.id,
        "title": conversation.title,
        "done": conversation.done_count(),
        "latest_round": conversation.latest_image_round(),
    })
}

#[tauri::command]
pub fn reveal_images() -> Result<(), String> {
    let dir = crate::storage::images_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
