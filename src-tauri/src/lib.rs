//! GPT Image Free —— 桌面客户端入口。
//!
//! 架构：Rust 负责系统能力（HTTP、文件、更新），UI 走 WebView。
//! 账号池与生图逻辑复用本机 chatgpt2api 后端，不重复实现 OAuth 与流水线。

pub mod accounts;
pub mod api;
pub mod chat;
pub mod commands;
pub mod settings;
pub mod storage;
pub mod updater;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::boot_info,
            commands::backend_health,
            commands::list_accounts,
            commands::refresh_accounts,
            commands::delete_accounts,
            commands::generate,
            commands::save_settings,
            commands::check_update,
            commands::download_update,
            commands::conversation_summary,
            commands::reveal_images,
        ])
        .run(tauri::generate_context!())
        .expect("启动 GPT Image Free 失败");
}
