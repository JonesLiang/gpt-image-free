# GPT Image Free

Codex 风格的跨平台图片生成桌面客户端。Rust + Tauri 2 构建，复用本机
[chatgpt2api](https://github.com/basketikun/chatgpt2api) 账号池后端。

> 本项目仅用于学习与个人研究。使用第三方账号池存在违反上游服务条款的风险，
> 账号可能被封禁，请自行斟酌。请勿用于商业用途或批量滥用。

## 特性

- **首页干净**：热门画廊 + 输入框，所有设置收进左下角头像。
- **多账号独立额度**：每个账号有各自的下次刷新时间（滚动 24 小时窗口），
  总览页逐个展示额度、刷新时间和倒计时。
- **刷新即复活**：刷新额度会重新查询真实值，已到期的限流/冻结账号自动恢复可用。
- **一键清理**：总览页可一键删除所有限流/冻结账号。
- **换号不丢上下文**：点「换号继续」后，上一张图作为参考图、最近 N 轮文字
  带真实轮次编号注入新账号。
- **自动更新**：推送 tag 即触发 GitHub Action 多平台构建，客户端检查更新并
  通过 gh-proxy 镜像下载（国内友好）。

## 架构

```
ui/                 原生 JS + CSS，无构建步骤，直接作为 WebView 前端
src-tauri/src/
  api.rs            与本地后端通信（账号、生图、聊天）
  accounts.rs       账号与额度模型、时间解析
  chat.rs           会话与上下文注入
  settings.rs       本地设置持久化
  updater.rs        版本检测与 gh-proxy 下载
  storage.rs        生成图片落盘
  commands.rs       暴露给前端的 Tauri 命令
```

客户端**不重建账号体系**：号池、OAuth、生图流水线都在本机后端里。
客户端只负责界面与系统能力，因此必须保持后端运行。

## 开发

前端是纯静态文件，改完直接刷新即可；Rust 部分需要编译。
本仓库约定**本地不编译发布包**，构建全部交给 GitHub Action。

```bash
# 只跑单元测试
cargo test --manifest-path src-tauri/Cargo.toml --lib

# 本地调试（需要系统 WebView 与 tauri-cli）
cargo tauri dev
```

## 发版

```bash
git tag v0.1.0
git push origin v0.1.0
```

Action 会自动构建 macOS（arm64 / x64）、Windows、Linux 安装包并发布 Release。
客户端启动时会查询 `api.github.com` 获取最新版本，下载时把链接前缀替换为
`https://gh-proxy.com/`。

## 许可证

MIT
