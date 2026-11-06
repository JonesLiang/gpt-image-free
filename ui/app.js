/* =========================================================================
   GPT Image Free — 前端应用
   纯原生 JS，无构建步骤：ui/ 直接作为 Tauri 的 frontendDist。

   界面形态：ChatGPT 式对话（左侧会话列表 + 消息流 + 常驻输入框）。
   关键约定：输入框 DOM 一旦创建就不随状态刷新重建，否则中文输入法
   组合、光标位置和焦点都会被打断。所有刷新只更新消息区 / 侧栏 / 按钮状态。
   ========================================================================= */

const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || null;

/* ------------------------------------------------------------------ 工具 */

function humanize(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms <= 0) return "已到期";
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${Math.max(1, m)} 分钟`;
}

function localWhen(iso, nowMs) {
  if (!iso) return "—";
  const t = parseIsoUtc(iso);
  if (t === null) return "—";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const base = new Date(nowMs || Date.now());
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tomorrow = new Date(base.getTime() + 86400000);
  if (sameDay(d, base)) return `今天 ${hm}`;
  if (sameDay(d, tomorrow)) return `明天 ${hm}`;
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
}

/** 解析后端给的不带时区时间戳（实测为 UTC）。 */
function parseIsoUtc(iso) {
  const s = String(iso).trim();
  if (!s) return null;
  if (/Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s + "Z");
  return Number.isNaN(t) ? null : t;
}

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function uid(prefix) {
  return (prefix || "t") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
    }
  }
  (children || []).forEach((c) => c && node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return node;
}

function toast(message, bad) {
  const box = $("#toast");
  box.textContent = message;
  box.className = "toast" + (bad ? " bad" : "");
  box.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (box.hidden = true), 2600);
}

async function call(command, args) {
  if (!invoke) throw new Error("请通过桌面客户端运行（当前是浏览器预览模式）");
  return invoke(command, args);
}

function clock(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const same = d.toDateString() === new Date().toDateString();
  return same ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

/* ------------------------------------------------------------------ 状态 */

const state = {
  route: "home",
  version: "—",
  repo: "",
  baseUrl: "",
  dataDir: "",
  imagesDir: "",
  online: null,
  accounts: [],
  loadingAccounts: false,
  settings: { text_reply: false, context_rounds: 5, base_url: "", auto_check_update: true },
  update: null,
  boundToken: null,
  accountPopOpen: false,
  // 会话
  conversations: [],
  conversation: null,
  // 输入
  input: "",
  reference: null,
  pendingInject: false,
  // 生成任务：按会话 id 跟踪，切会话不打断，结果回写发起它的会话
  jobs: [],
  // 更新
  updateState: null,
  updateChecked: false,
  // 侧栏折叠
  sidebarCollapsed: false,
  // 后端诊断
  onlineError: "",
  adminKeyReady: true,
  diagnostic: null,
  // DOM 缓存
  dom: null,
  stageRoute: null,
};

let tickTimer = null;
let genTimer = null;
let saveTimer = null;
let autoUpdateTimer = null;
let updateInFlight = null;
let composing = false;

/* ------------------------------------------------------------------ 账号 */

function sortedAccounts() {
  return state.accounts.slice().sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    return (b.quota || 0) - (a.quota || 0);
  });
}

function accountByToken(token) {
  return state.accounts.find((a) => a.access_token === token) || null;
}

function activeAccount() {
  const bound = accountByToken(state.boundToken);
  if (bound) return bound;
  return sortedAccounts().find((a) => a.usable) || null;
}

function pickBestAccount() {
  return sortedAccounts().find((a) => a.usable) || null;
}

async function loadAccounts(force, silent) {
  state.loadingAccounts = true;
  // silent：导入页提交后只刷数据，不重建整页（会打断 textarea 的输入焦点）。
  if (!silent) render();
  try {
    state.accounts = await call(force ? "refresh_accounts" : "list_accounts");
    state.online = true;
    state.onlineError = "";
    if (!state.boundToken) {
      const best = pickBestAccount();
      if (best) state.boundToken = best.access_token;
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    state.onlineError = msg;
    if (msg.includes("后端未连接")) {
      state.online = false;
      runDiagnostic();
    } else {
      state.online = true;
      toast(msg, true);
    }
  } finally {
    state.loadingAccounts = false;
    if (!silent) render();
  }
}

/** 离线时补一层端口探测，区分「后端没启动」和「代理/防火墙拦截」。 */
async function runDiagnostic() {
  try {
    const d = await call("diagnose_backend");
    state.diagnostic = d;
    if (d.data_dir) state.dataDir = d.data_dir;
    state.adminKeyReady = !!d.admin_key_ready;
    // 导入页有表单，别让异步诊断回来时全量重建 textarea。
    if (state.route === "home") render();
  } catch (e) {
    // 浏览器预览模式没有 Tauri，忽略即可。
  }
}

/* ------------------------------------------------------------------ 路由 */

function setRoute(name) {
  state.route = name;
  closeMenu();
  state.accountPopOpen = false;
  render();
  const stage = $("#stage");
  if (stage) stage.scrollTop = 0;
}

function render() {
  renderChrome();
  const stage = $("#stage");
  if (!stage) return;

  if (state.route !== "home") {
    // 设置类页面没有常驻输入框，全量重建最省心。
    stage.innerHTML = "";
    state.dom = null;
    state.stageRoute = state.route;
    switch (state.route) {
      case "overview": renderOverview(stage); break;
      case "pool": renderPool(stage); break;
      case "api": renderApi(stage); break;
      case "import": renderImport(stage); break;
      case "settings": renderSettings(stage); break;
    }
  } else {
    if (state.stageRoute !== "home" || !state.dom || !state.dom.root.isConnected) {
      stage.innerHTML = "";
      buildHome(stage);
      state.stageRoute = "home";
    }
    refreshHome();
  }
  renderUpdateBar();
}

/* ------------------------------------------------------------------ 图标（feather 风格线性 SVG） */

const svgIcon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICON_EXPAND = svgIcon('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>');
const ICON_DOWNLOAD = svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>');
const ICON_FOLDER = svgIcon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>');
const ICON_WARN = svgIcon('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const ICON_RETRY = svgIcon('<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>');
const ICON_COLLAPSE = svgIcon('<path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/>');
const ICON_SIDEBAR = svgIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>');
const ICON_BACK = svgIcon('<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>');

/** 无文字的图形按钮：简约、统一 15px 线性图标。 */
function iconBtn(icon, title, onclick) {
  return el("button", { class: "icon-btn", title, html: icon, onclick });
}

/* ------------------------------------------------------------------ 通用 chrome（头像 / 版本号 / 侧栏折叠） */

function avatarButton() {
  return el(
    "button",
    {
      class: "avatar avatar-btn",
      title: "账号与设置",
      onclick: (e) => {
        e.stopPropagation();
        $("#avatarMenu").hidden ? openMenu() : closeMenu();
      },
    },
    [el("span", { class: "avatar-letter", text: "L" })]
  );
}

function versionChip() {
  return el("button", { class: "version-chip", title: "检查更新", onclick: () => checkUpdate(true) });
}

/** 更新所有头像字母 / 版本号 / 菜单信息（home 侧栏与设置页共用同一套）。 */
function renderChrome() {
  const letter = (state.accounts[0] && state.accounts[0].name ? state.accounts[0].name[0] : "L").toUpperCase();
  $$(".avatar-letter").forEach((n) => (n.textContent = letter));
  const menuAvatar = $("#menuAvatar");
  if (menuAvatar) menuAvatar.textContent = letter;
  const hasUpdate = !!(state.update && state.update.has_update);
  $$(".version-chip").forEach((chip) => {
    chip.textContent = "v" + state.version;
    chip.classList.toggle("has-update", hasUpdate);
    chip.title = hasUpdate ? `发现新版本 v${state.update.latest}` : "检查更新";
  });
  const plan = $("#menuPlan");
  if (plan) plan.textContent = state.online === false ? "后端未连接" : "本地客户端";
}

/** 侧栏折叠状态持久化（不需要后端，localStorage 足够）。 */
function sidebarCollapsed() {
  try {
    return localStorage.getItem("gif:sidebar") === "1";
  } catch (e) {
    return false;
  }
}

function toggleSidebar() {
  const next = !state.sidebarCollapsed;
  state.sidebarCollapsed = next;
  try {
    localStorage.setItem("gif:sidebar", next ? "1" : "0");
  } catch (e) {}
  const d = state.dom;
  if (d) {
    d.sidebar.classList.toggle("collapsed", next);
    d.expandBtn.hidden = !next;
  }
}

/** 非 home 页面顶部的通用条：返回对话 + 版本 + 头像。 */
function pageChrome() {
  return el("div", { class: "page-chrome" }, [
    iconBtn(ICON_BACK, "返回对话", () => setRoute("home")),
    el("span", { class: "spacer" }),
    versionChip(),
    avatarButton(),
  ]);
}

/* ------------------------------------------------------------------ 首页骨架 */

function buildHome(stage) {
  const root = el("div", { class: "home" });
  const collapsed = sidebarCollapsed();
  state.sidebarCollapsed = collapsed;

  const sidebar = el("aside", { class: "session-sidebar" + (collapsed ? " collapsed" : "") });
  // 侧栏头部：应用图标即「新建对话」，右侧折叠按钮。
  sidebar.appendChild(
    el("div", { class: "sidebar-head" }, [
      el("button", { class: "sidebar-logo", title: "新建对话", "aria-label": "新建对话", onclick: () => newConversation() }),
      el("button", { class: "new-chat", title: "新建对话", text: "+ 新建对话", onclick: () => newConversation() }),
      iconBtn(ICON_COLLAPSE, "折叠侧栏", toggleSidebar),
    ])
  );
  sidebar.appendChild(el("div", { class: "sidebar-label", text: "历史会话" }));
  const list = el("div", { class: "session-list" });
  sidebar.appendChild(list);
  // 侧栏底部：版本号 + 头像（账号 / 设置入口）。
  sidebar.appendChild(
    el("div", { class: "sidebar-foot" }, [versionChip(), avatarButton()])
  );

  const main = el("div", { class: "chat-main" });
  const expandBtn = iconBtn(ICON_SIDEBAR, "展开侧栏", toggleSidebar);
  expandBtn.className = "icon-btn chat-expand";
  expandBtn.hidden = !collapsed;
  const title = el("div", { class: "chat-title", text: "图像" });
  const sub = el("div", { class: "chat-sub", text: "描述画面，或上传参考图继续修改" });
  // 诊断横幅独占一整行：塞进 chat-head-actions 会被标题栏挤成竖排单字。
  const offline = el("div", { class: "notice notice-wide", hidden: true });
  const head = el("div", { class: "chat-head" }, [
    expandBtn,
    el("div", { class: "chat-head-copy" }, [title, sub]),
  ]);

  const scroll = el("div", { class: "chat-scroll" });
  const inner = el("div", { class: "chat-inner" });
  scroll.appendChild(inner);

  const composer = buildComposer();
  main.appendChild(head);
  main.appendChild(offline);
  main.appendChild(scroll);
  main.appendChild(composer.wrap);

  root.appendChild(sidebar);
  root.appendChild(main);
  stage.appendChild(root);

  scroll.addEventListener("scroll", () => {
    if (!state.dom) return;
    state.dom.atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 48;
  });

  state.dom = Object.assign({ root, sidebar, list, expandBtn, head, title, sub, offline, scroll, inner, msgSig: "", listSig: "", atBottom: true }, composer);
  autoGrow();
  syncSendBtn();
  return state.dom;
}

function refreshHome() {
  const d = state.dom;
  if (!d) return;
  renderSidebar();
  renderMessages();
  updateComposer();
}

/* ------------------------------------------------------------------ 会话列表 */

function renderSidebar() {
  const d = state.dom;
  if (!d) return;
  const sig = state.conversations.map((m) => `${m.id}:${m.title}:${m.turns}`).join("|") + "|" + (state.conversation && state.conversation.id);
  if (sig === d.listSig) return;
  d.listSig = sig;
  d.list.innerHTML = "";
  if (state.conversations.length === 0) {
    d.list.appendChild(el("div", { class: "session-empty", text: "还没有历史会话" }));
  }
  state.conversations.forEach((m) => {
    const active = state.conversation && state.conversation.id === m.id;
    const item = el("div", {
      class: "session-item" + (active ? " active" : ""),
      role: "button",
      tabindex: "0",
      title: m.title,
      onclick: () => switchConversation(m.id),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchConversation(m.id); } },
    }, [
      el("span", { class: "session-icon", text: "◇" }),
      el("span", { class: "session-name", text: m.title || "新会话" }),
      el("button", {
        class: "session-del",
        title: "删除会话",
        text: "×",
        onclick: (e) => { e.stopPropagation(); deleteConversation(m.id); },
      }),
    ]);
    d.list.appendChild(item);
  });
}

/* ------------------------------------------------------------------ 消息流 */

function renderMessages() {
  const d = state.dom;
  if (!d || !state.conversation) return;
  const turns = state.conversation.turns;
  const sig = turns
    .map((t) => [t.id, t.status, (t.image || "").length, (t.text || "").length, (t.error || "")].join("|"))
    .join("~") + "|" + state.online;
  if (sig === d.msgSig) return;
  d.msgSig = sig;
  d.inner.innerHTML = "";

  if (turns.length === 0) {
    d.inner.appendChild(buildEmptyState());
  } else {
    turns.forEach((t) => {
      d.inner.appendChild(renderUserTurn(t));
      d.inner.appendChild(renderAiTurn(t));
    });
  }
  syncGenAnimation();
  scrollToBottom(true);
}

function buildEmptyState() {
  const examples = [
    "一只橘猫坐在雨后的木窗台，电影感侧光",
    "极简产品海报，米白背景，柔和长阴影",
    "水墨山水，大面积留白，远处一叶扁舟",
    "赛博朋克城市夜景，湿地面上的霓虹倒影",
  ];
  const box = el("div", { class: "hero" }, [
    el("div", { class: "hero-mark" }),
    el("h1", { text: "想画点什么？" }),
    el("p", { text: "描述画面即可生成；带 + 上传参考图，可以基于图片继续修改。" }),
  ]);
  const chips = el("div", { class: "hero-chips" });
  examples.forEach((text) => {
    chips.appendChild(el("button", { class: "hero-chip", text, onclick: () => fillComposer(text) }));
  });
  box.appendChild(chips);
  if (state.online === false) {
    box.appendChild(el("div", { class: "hero-warn", text: "本机后端未启动，生图暂不可用" }));
  }
  return box;
}

function renderUserTurn(t) {
  const box = el("div", { class: "msg-user" });
  if (t.reference) {
    box.appendChild(
      el("img", {
        class: "msg-ref",
        src: t.reference,
        title: "本轮参考图（点击放大）",
        onclick: () => openLightbox(t.reference),
      })
    );
  }
  box.appendChild(el("div", { class: "msg-user-text", text: t.prompt }));
  return box;
}

function renderAiTurn(t) {
  const wrap = el("div", { class: "msg-ai" });
  if (t.status === "running") {
    // ChatGPT 同款：居中细描边旋转圆环 + 一行状态文案，不占多余空间。
    wrap.appendChild(
      el("div", { class: "gen-card" }, [
        el("div", { class: "gen-spinner" }),
        el("div", { class: "gen-status", "data-start": String(t.createdAt || Date.now()), text: "正在生成图像…" }),
      ])
    );
    return wrap;
  }
  if (t.status === "error") {
    wrap.appendChild(
      el("div", { class: "msg-error" }, [
        el("span", { class: "msg-error-icon", html: ICON_WARN }),
        el("div", { class: "msg-error-body" }, [
          el("div", { class: "msg-error-title", text: "生成失败" }),
          el("div", { class: "msg-error-detail", text: t.error || "未知错误" }),
        ]),
        el("button", { class: "msg-error-retry", title: "重新编辑这条提示词", onclick: () => retryTurn(t.id) }, [
          el("span", { class: "msg-error-retry-icon", html: ICON_RETRY }),
          el("span", { text: "重试" }),
        ]),
      ])
    );
    return wrap;
  }
  if (t.image) {
    wrap.appendChild(
      el("div", { class: "msg-img", title: "点击放大", onclick: () => openLightbox(t.image) }, [
        el("img", { src: t.image, alt: t.prompt }),
      ])
    );
    // 操作行：图形按钮（放大 / 下载 / 定位文件）+ 右侧元信息，一行搞定。
    const actions = el("div", { class: "msg-actions" });
    actions.appendChild(iconBtn(ICON_EXPAND, "放大查看", () => openLightbox(t.image)));
    actions.appendChild(
      el("a", { class: "icon-btn", href: t.image, download: `image-${t.id}.png`, title: "下载图片", html: ICON_DOWNLOAD })
    );
    if (t.path) {
      actions.appendChild(
        iconBtn(ICON_FOLDER, "在文件夹中显示", () => {
          call("reveal_image", { path: t.path }).catch((e) => toast(String(e && e.message ? e.message : e), true));
        })
      );
    }
    const bits = [t.account || "本地", clock(t.createdAt)];
    if (t.injected) bits.push("已注入上下文");
    if (t.reference) bits.push("自定义参考图");
    else if (t.refRound) bits.push(`参考第 ${t.refRound} 轮`);
    wrap.appendChild(
      el("div", { class: "msg-aside" }, [
        actions,
        el("span", { class: "spacer" }),
        el("span", { class: "msg-meta", text: bits.join(" · ") }),
      ])
    );
  }
  if (t.text) wrap.appendChild(el("div", { class: "msg-text", text: t.text }));
  return wrap;
}

function syncGenAnimation() {
  const running = state.conversation && state.conversation.turns.some((t) => t.status === "running" || t.status === "pending");
  if (running && !genTimer) {
    // 生图本来就要几十秒到一两分钟，显示已用时能让人确认「还在跑」而不是卡死。
    const texts = ["正在理解你的描述…", "正在绘制画面…", "正在收尾，马上就好…", "还在生成，请稍等…"];
    genTimer = setInterval(() => {
      const node = $(".gen-status", state.dom && state.dom.inner);
      if (!node) return;
      const start = Number(node.dataset.start) || Date.now();
      const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const idx = Math.min(texts.length - 1, Math.floor(sec / 15));
      node.textContent = `${texts[idx]} · 已用时 ${sec} 秒`;
    }, 1000);
  } else if (!running && genTimer) {
    clearInterval(genTimer);
    genTimer = null;
  }
}

function scrollToBottom(force) {
  const d = state.dom;
  if (!d) return;
  if (force || d.atBottom !== false) {
    requestAnimationFrame(() => { d.scroll.scrollTop = d.scroll.scrollHeight; });
  }
}

/* ------------------------------------------------------------------ 会话持久化 */

function normalizeConversation(raw, opts) {
  const c = raw || {};
  const keepRunning = !!(opts && opts.keepRunning);
  const conv = {
    id: c.id || uid("c"),
    title: c.title || "新会话",
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now(),
    turns: Array.isArray(c.turns) ? c.turns : [],
  };
  conv.turns.forEach((t) => {
    if (!keepRunning && (t.status === "running" || t.status === "pending")) {
      t.status = "error";
      t.error = "上次生成未完成，可重新编辑后重发";
    }
  });
  return conv;
}

async function refreshConversations() {
  try {
    state.conversations = (await call("list_conversations")) || [];
    if (state.dom) state.dom.listSig = "";
    if (state.route === "home") render();
    return state.conversations;
  } catch (e) {
    return state.conversations;
  }
}

function persistConversation(immediate) {
  if (!state.conversation) return Promise.resolve();
  state.conversation.updatedAt = Date.now();
  const snapshot = JSON.parse(JSON.stringify(state.conversation));
  const run = async () => {
    try {
      await call("save_conversation", { conversation: snapshot });
      await refreshConversations();
    } catch (e) {
      toast("会话保存失败：" + String(e && e.message ? e.message : e), true);
    }
  };
  clearTimeout(saveTimer);
  if (immediate) return run();
  saveTimer = setTimeout(run, 500);
  return Promise.resolve();
}

async function newConversation() {
  const current = state.conversation;
  // 之前在空会话里点「新建」会直接 return，看起来像按钮坏了。现在始终新建；
  // 已落盘的空会话先删掉，避免侧栏堆一串「新会话」。有后台任务时不动它。
  if (current && current.turns.length === 0 && !hasJobsFor(current.id)) {
    if (state.conversations.some((m) => m.id === current.id)) {
      try { await call("delete_conversation", { id: current.id }); } catch (e) {}
    }
  }
  const now = Date.now();
  state.conversation = { id: uid("c"), title: "新会话", createdAt: now, updatedAt: now, turns: [] };
  state.input = "";
  state.reference = null;
  state.pendingInject = false;
  state.accountPopOpen = false;
  if (state.dom) {
    state.dom.textarea.value = "";
    state.dom.msgSig = "";
    state.dom.listSig = "";
    autoGrow();
  }
  closeMenu();
  if (state.route !== "home") setRoute("home");
  else render();
  await persistConversation(true);
  focusComposer();
}

async function switchConversation(id) {
  if (state.conversation && state.conversation.id === id) return;
  try {
    const data = await call("load_conversation", { id });
    // 该会话还有后台生成任务时，切回来别把 running 误判成「上次生成失败」。
    state.conversation = normalizeConversation(data || { id, turns: [] }, { keepRunning: hasJobsFor(id) });
    state.input = "";
    state.reference = null;
    state.accountPopOpen = false;
    if (state.dom) {
      state.dom.textarea.value = "";
      state.dom.msgSig = "";
      autoGrow();
    }
    closeMenu();
    if (state.route !== "home") setRoute("home");
    else render();
    scrollToBottom(true);
  } catch (e) {
    toast(String(e && e.message ? e.message : e), true);
  }
}

async function deleteConversation(id) {
  try {
    await call("delete_conversation", { id });
    const list = await refreshConversations();
    if (state.conversation && state.conversation.id === id) {
      if (list.length) await switchConversation(list[0].id);
      else await newConversation();
    } else if (state.route === "home") render();
  } catch (e) {
    toast(String(e && e.message ? e.message : e), true);
  }
}

function retryTurn(id) {
  const t = state.conversation && state.conversation.turns.find((x) => x.id === id);
  if (!t) return;
  state.conversation.turns = state.conversation.turns.filter((x) => x.id !== id);
  state.input = t.prompt;
  state.reference = t.reference ? { name: "参考图", dataUrl: t.reference } : null;
  if (state.dom) {
    state.dom.textarea.value = state.input;
    state.dom.msgSig = "";
  }
  render();
  focusComposer();
}

/* ------------------------------------------------------------------ 输入框 */

/** ChatGPT 式输入区：参考图条在卡片内顶部，文本独占中间（自身滚动），
    + / 账号 / 发送固定在底部工具行——多行输入时空间全部让给文本。 */
function buildComposer() {
  const wrap = el("div", { class: "composer-wrap" });
  const composer = el("div", { class: "composer" });

  // 参考图预览条：输入框卡片内部第一行，有图才出现。
  const refChip = el("div", { class: "reference-chip", hidden: true });
  const refInput = el("input", { type: "file", accept: "image/*", style: "display:none" });
  refInput.addEventListener("change", onReferencePicked);

  const textarea = el("textarea", { placeholder: "描述你想生成的图像…", rows: "1" });
  textarea.value = state.input;
  textarea.addEventListener("compositionstart", () => { composing = true; });
  textarea.addEventListener("compositionend", () => { composing = false; syncSendBtn(); });
  textarea.addEventListener("input", () => {
    state.input = textarea.value;
    autoGrow();
    syncSendBtn();
  });
  textarea.addEventListener("keydown", (e) => {
    // 中文输入法选字时按下的 Enter 不能当发送。
    if (e.isComposing || composing || e.keyCode === 229) return;
    const cmdEnter = (e.metaKey || e.ctrlKey) && e.key === "Enter";
    const plainEnter = e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    if (cmdEnter || plainEnter) {
      e.preventDefault();
      sendPrompt();
    }
  });

  // 底部工具行：左边 +，右边账号与发送。
  const plus = el("button", {
    class: "composer-plus",
    title: "选择参考图（可基于图片继续修改）",
    text: "+",
    onclick: () => refInput.click(),
  });
  const pill = el("button", { class: "model-pill", title: "选择账号", onclick: toggleAccountPop });
  const sendBtn = el("button", { class: "composer-send", title: "生成（Enter）", text: "↑", onclick: sendPrompt });
  const toolbar = el("div", { class: "composer-toolbar" }, [
    plus,
    el("span", { class: "spacer" }),
    pill,
    sendBtn,
  ]);

  composer.appendChild(refChip);
  composer.appendChild(refInput);
  composer.appendChild(textarea);
  composer.appendChild(toolbar);

  const hint = el("div", { class: "composer-hint", text: "Enter 发送 · Shift+Enter 换行 · + 添加参考图" });
  const popHolder = el("div", { class: "pop-holder" });
  wrap.appendChild(composer);
  wrap.appendChild(hint);
  wrap.appendChild(popHolder);

  return { wrap, refChip, refInput, plus, textarea, pill, sendBtn, composer, hint, popHolder };
}

function autoGrow() {
  const d = state.dom;
  if (!d) return;
  d.textarea.style.height = "auto";
  d.textarea.style.height = Math.min(d.textarea.scrollHeight, 180) + "px";
}

function focusComposer() {
  const d = state.dom;
  if (!d) return;
  d.textarea.focus();
  const end = d.textarea.value.length;
  d.textarea.setSelectionRange(end, end);
}

function fillComposer(text) {
  state.input = text;
  if (state.dom) {
    state.dom.textarea.value = text;
    autoGrow();
  }
  syncSendBtn();
  focusComposer();
}

function syncSendBtn() {
  const d = state.dom;
  if (!d) return;
  d.sendBtn.disabled = !canSend();
}

function renderReferenceChip() {
  const d = state.dom;
  if (!d) return;
  const chip = d.refChip;
  chip.innerHTML = "";
  if (!state.reference) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.appendChild(el("img", { class: "reference-thumb", src: state.reference.dataUrl, title: state.reference.name }));
  chip.appendChild(el("span", { class: "reference-name", text: state.reference.name }));
  chip.appendChild(el("span", { class: "reference-tag", text: "参考图" }));
  chip.appendChild(el("button", { class: "reference-remove", title: "移除参考图", text: "×", onclick: () => {
    state.reference = null;
    renderReferenceChip();
    syncSendBtn();
  } }));
}

function onReferencePicked(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => toast("文件读取失败", true);
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => toast("这不是一张可读取的图片", true);
    img.onload = () => {
      // 统一转成 PNG（后端 edits 通道按 image/png 组装），顺手压到 2048px 以内。
      const max = 2048;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      state.reference = { name: file.name, dataUrl: canvas.toDataURL("image/png") };
      renderReferenceChip();
      syncSendBtn();
      focusComposer();
    };
    img.src = String(reader.result);
  };
  reader.readAsDataURL(file);
  e.target.value = "";
}

function updateComposer() {
  const d = state.dom;
  if (!d) return;
  const acct = activeAccount();
  d.pill.innerHTML = "";
  const dotClass = !acct ? "bad" : acct.blocked ? "warn" : "ok";
  d.pill.appendChild(el("span", { class: "dot " + dotClass }));
  d.pill.appendChild(el("span", { class: "name", text: acct ? acct.name : "无可用账号" }));
  d.pill.appendChild(
    el("span", { class: "acct-quota " + ((acct && acct.quota <= 0) ? "zero" : (acct && acct.quota <= 3) ? "low" : ""), text: String(acct ? acct.quota : 0) })
  );
  renderReferenceChip();
  syncSendBtn();

  const conv = state.conversation;
  d.title.textContent = conv ? conv.title : "新会话";
  d.sub.textContent = conv && conv.turns.length ? `共 ${conv.turns.length} 轮 · 对话会自动保存在本机` : "描述画面，或上传参考图继续修改";

  // 不只是「连不上」才提示：Windows 上 401（admin-key 不对）、404（端口不对）
  // 同样会让账号列表为空，用户容易误判成「没有账号」。把底层错误一并写出来。
  const showNotice = state.online === false || !!state.onlineError;
  d.offline.hidden = !showNotice;
  if (showNotice) {
    d.offline.innerHTML = "";
    const offline = state.online === false;
    const auth = /40[13]/.test(state.onlineError);
    const diag = state.diagnostic;
    const noListener = !!(diag && !diag.port_listening);
    const title = offline
      ? noListener
        ? `本机后端未启动（${diag.endpoint} 无人监听），生图与导入入池都不可用。`
        : "本机后端未启动，生图不可用。请先启动 chatgpt2api 服务。"
      : auth
        ? "后端在线，但 admin-key 校验失败。账号列表为空不是「没有账号」。"
        : "后端已连通，但账号信息读取失败。";
    // 把「正在查找的完整路径」写出来：只说「检查后端数据目录」用户根本
    // 无从下手，Windows 上后端装到别处时也能一眼看出该改哪个环境变量。
    const keyPath = (diag && diag.admin_key_path) || `${state.dataDir || "(未知数据目录)"}/admin-key`;
    const details = [
      el("div", { class: "notice-title", text: title }),
      el("div", {
        class: "notice-detail",
        text: [
          `连接地址 ${state.baseUrl || "http://127.0.0.1:38650"}`,
          state.adminKeyReady ? "admin-key 已找到" : `admin-key 未找到：${keyPath}`,
        ].join(" · "),
      }),
      el("div", { class: "notice-detail", text: `底层错误：${state.onlineError || "连接被拒绝"}` }),
    ];
    if (diag) {
      details.push(el("div", { class: "notice-detail", text: `端口探测：${diag.port_detail}` }));
      details.push(el("div", { class: "notice-advice", text: `建议：${diag.advice}` }));
    }
    d.offline.appendChild(el("div", { class: "notice-copy" }, details));
    d.offline.appendChild(
      el("div", { class: "notice-actions" }, [
        el("button", { class: "btn", text: "重新连接", onclick: () => { state.diagnostic = null; loadAccounts(false); } }),
        el("button", {
          class: "btn",
          text: "打开数据目录",
          onclick: () => call("open_data_dir").catch((e) => toast(String(e), true)),
        }),
        el("button", {
          class: "btn",
          text: "复制诊断",
          onclick: async () => {
            let dg = state.diagnostic;
            if (!dg) {
              try { dg = await call("diagnose_backend"); state.diagnostic = dg; } catch (e) {}
            }
            const diagText = [
              `GPT Image Free v${state.version}`,
              `连接地址：${state.baseUrl || "http://127.0.0.1:38650"}`,
              `数据目录：${state.dataDir || "未知"}`,
              `admin-key：${state.adminKeyReady ? "已找到" : `未找到（${keyPath}）`}`,
              `底层错误：${state.onlineError || "连接被拒绝"}`,
              dg ? `端口探测：${dg.port_detail}` : "端口探测：未执行",
              dg ? `数据目录存在：${dg.data_dir_exists ? "是" : "否"}` : "",
              dg ? `source/ 存在：${dg.source_dir_exists ? "是" : "否"}` : "",
              dg ? `建议：${dg.advice}` : "",
              `平台：${navigator.userAgent}`,
            ].filter(Boolean).join("\n");
            copy(diagText);
          },
        }),
      ])
    );
  }

  // 账号弹层只在状态/账号数据变化时重建，避免定时 render 打断滚动和点击。
  const popSig = state.accountPopOpen
    ? `${state.accounts.length}:${state.loadingAccounts}:${state.boundToken}`
    : "closed";
  if (d.popSig !== popSig) {
    d.popSig = popSig;
    d.popHolder.innerHTML = "";
    if (state.accountPopOpen) d.popHolder.appendChild(buildAccountPop());
  }
}

/** 同一会话串行（上下文有依赖），不同会话可以并行后台生成。 */
function hasJobsFor(convId) {
  return state.jobs.some((j) => j.convId === convId);
}

function canSend() {
  if (!state.conversation) return false;
  if (hasJobsFor(state.conversation.id)) return false;
  if (!state.input.trim() && !state.reference) return false;
  const acct = activeAccount();
  return !!acct && !!acct.usable;
}

/** 账号下拉：展示名称 / 剩余额度 / 下次刷新；不可用的排到底部并置灰。 */
function buildAccountPop() {
  const pop = el("div", { class: "account-pop" });
  const list = sortedAccounts();
  if (state.loadingAccounts && list.length === 0) {
    pop.appendChild(el("div", { class: "pop-title", text: "加载中…" }));
    return pop;
  }
  if (list.length === 0) {
    pop.appendChild(el("div", { class: "pop-title", text: "没有账号，请在「高级导入」中导入" }));
    return pop;
  }
  const addGroup = (title, items) => {
    if (items.length === 0) return;
    pop.appendChild(el("div", { class: "pop-title", text: title }));
    items.forEach((a) => {
      const countdown = a.reset_due ? "可刷新额度" : humanize(a.reset_in_ms);
      const meta = el("div", { class: "acct-meta" }, [
        el("span", { text: "剩余 " + a.quota }),
        el("span", { text: "下次刷新 " + countdown }),
        a.blocked ? el("span", { text: a.status }) : null,
      ]);
      pop.appendChild(
        el("button", {
          class: "acct-row" + (a.access_token === state.boundToken ? " selected" : "") + (a.usable ? "" : " disabled"),
          disabled: a.usable ? null : "disabled",
          onclick: (e) => {
            // 阻止冒泡：document 的「点外部关闭」不能在选中后又触发一次。
            e.stopPropagation();
            state.boundToken = a.access_token;
            state.pendingInject = true;
            toast("已切换到 " + a.name);
            closeAccountPop();
          },
        }, [
          el("div", { class: "acct-main" }, [el("div", { class: "acct-name", text: a.name }), meta]),
          el("div", { class: "acct-quota " + (a.quota <= 0 ? "zero" : a.quota <= 3 ? "low" : ""), text: String(a.quota) }),
        ])
      );
    });
  };
  addGroup("可用账号", list.filter((a) => a.usable));
  addGroup("不可用（限流 / 冻结）", list.filter((a) => !a.usable));
  return pop;
}

/** 统一关闭入口：选中账号、点空白、Esc 都走这里，状态一定收敛。 */
function closeAccountPop() {
  if (!state.accountPopOpen) return;
  state.accountPopOpen = false;
  render();
}

function toggleAccountPop(e) {
  // 不让 document 的「点外部关闭」把刚打开的弹层立刻关掉。
  if (e) e.stopPropagation();
  state.accountPopOpen = !state.accountPopOpen;
  render();
}

/* ------------------------------------------------------------------ 生图 */

function stripDataUrl(s) {
  const i = s.indexOf(",");
  return s.startsWith("data:") && i >= 0 ? s.slice(i + 1) : s;
}

function lastDoneImage() {
  if (!state.conversation) return null;
  for (let i = state.conversation.turns.length - 1; i >= 0; i--) {
    const t = state.conversation.turns[i];
    if (t.status === "done" && t.image) return t;
  }
  return null;
}

function composeInjectedPrompt(turns, current, limit) {
  const n = Math.max(1, limit || 5);
  const kept = turns.slice(Math.max(0, turns.length - n));
  if (kept.length === 0) return current.trim();
  const start = turns.length - kept.length;
  const ctx = kept.map((t, i) => `第 ${start + i + 1} 轮：${t.prompt.trim()}`).join("\n");
  return `【这是一个续接的会话，之前的内容如下】\n${ctx}\n\n【本轮要求】\n${current.trim()}`;
}

async function sendPrompt() {
  if (!canSend()) return;
  const acct = activeAccount();
  if (!acct) return toast("没有可用账号", true);

  // 从这一刻起所有引用都锁定到「发起这次生成的会话」，切会话不会改写别处。
  const conv = state.conversation;
  const convId = conv.id;
  const prompt = state.input.trim() || "请根据参考图生成相似风格的图片";
  const refDataUrl = state.reference ? state.reference.dataUrl : null;
  const prev = lastDoneImage();
  const turn = {
    id: uid(),
    prompt,
    status: "running",
    image: null,
    text: null,
    error: null,
    account: acct.name,
    reference: refDataUrl,
    refRound: 0,
    injected: false,
    createdAt: Date.now(),
  };
  conv.turns.push(turn);
  if (conv.title === "新会话") {
    conv.title = prompt.length > 18 ? prompt.slice(0, 18) + "…" : prompt;
  }
  state.input = "";
  state.reference = null;

  const d = state.dom;
  if (d) {
    d.textarea.value = "";
    d.msgSig = "";
    d.listSig = "";
    autoGrow();
    renderReferenceChip();
  }
  // 手动上传的参考图优先。「自动沿用上一张图」默认关闭：它要改走 edits
  // 并上传整张 PNG，是连续对话里最明显的耗时来源；需要连贯性可在设置里开启。
  let reference = refDataUrl ? stripDataUrl(refDataUrl) : null;
  if (!reference && state.settings.auto_reference && prev) {
    reference = stripDataUrl(prev.image);
    turn.refRound = conv.turns.indexOf(prev) + 1;
  }

  let finalPrompt = prompt;
  if (state.pendingInject && conv.turns.length > 1) {
    finalPrompt = composeInjectedPrompt(conv.turns.slice(0, -1), prompt, state.settings.context_rounds);
    turn.injected = true;
    state.pendingInject = false;
  }

  state.jobs.push({ convId, turnId: turn.id, startedAt: Date.now() });
  // 立即落盘：这样中途切走时从磁盘读回来的会话里已经有这条完整的 running
  // turn（含上下文标记），后台任务完成后才找得到它并回写结果。
  await persistConversation(true);
  render();
  focusComposer();
  try {
    const result = await call("generate", {
      prompt: finalPrompt,
      accountToken: acct.access_token,
      reference,
      textReply: state.settings.text_reply,
    });
    await finishJob(convId, turn.id, result, null);
    loadAccounts(false);
  } catch (e) {
    await finishJob(convId, turn.id, null, e);
  } finally {
    state.jobs = state.jobs.filter((j) => j.turnId !== turn.id);
    if (state.dom) {
      state.dom.msgSig = "";
      state.dom.listSig = "";
    }
    render();
    syncSendBtn();
  }
}

/** 把结果写回发起它的那个会话，而不是当前显示的会话。
    切走后原会话已不在内存里，按 id 从磁盘读回来改完再存，任务全程后台跑。 */
async function finishJob(convId, turnId, result, error) {
  const current = state.conversation && state.conversation.id === convId;
  let target = current ? state.conversation : null;
  if (!target) {
    try { target = await call("load_conversation", { id: convId }); } catch (e) { target = null; }
  }
  if (!target || !Array.isArray(target.turns)) return;
  const t = target.turns.find((x) => x.id === turnId);
  if (!t) return;
  if (result) {
    t.status = "done";
    t.image = result.image;
    t.text = result.text || null;
    t.path = result.path || null;
    t.error = null;
  } else {
    t.status = "error";
    t.error = String(error && error.message ? error.message : error);
  }
  target.updatedAt = Date.now();
  try {
    await call("save_conversation", { conversation: target });
    await refreshConversations();
    if (!current) toast("另一个会话的图片已生成完成");
  } catch (e) {
    toast("生成结果保存失败：" + String(e && e.message ? e.message : e), true);
  }
}

/* ------------------------------------------------------------------ 图片查看 */

const viewer = { zoom: 1, src: "", baseW: 0, baseH: 0 };

/** 按视口等比算出基准尺寸。之后所有缩放都在这个尺寸上乘系数，
    直接改 width/height 而不是 transform：transform 不改变布局尺寸，
    flex 居中时放大的部分会被四周对称裁掉且滚动条也滚不到。 */
function fitLightbox() {
  const img = $("#lightboxImg");
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const availW = Math.max(160, window.innerWidth - 80);
  const availH = Math.max(160, window.innerHeight - 148);
  const scale = Math.min(1, availW / img.naturalWidth, availH / img.naturalHeight);
  viewer.baseW = Math.max(1, Math.round(img.naturalWidth * scale));
  viewer.baseH = Math.max(1, Math.round(img.naturalHeight * scale));
  viewer.zoom = 1;
  applyZoom();
}

function applyZoom() {
  const img = $("#lightboxImg");
  if (!viewer.baseW) return;
  img.style.width = Math.round(viewer.baseW * viewer.zoom) + "px";
  img.style.height = Math.round(viewer.baseH * viewer.zoom) + "px";
}

function openLightbox(src) {
  if (!src) return;
  viewer.src = src;
  viewer.zoom = 1;
  viewer.baseW = 0;
  viewer.baseH = 0;
  const img = $("#lightboxImg");
  img.style.width = "";
  img.style.height = "";
  img.onload = fitLightbox;
  img.src = src;
  // 同一张图命中缓存时 onload 可能不再触发，用同步尺寸兜底。
  if (img.complete && img.naturalWidth) fitLightbox();
  $("#lightboxDownload").href = src;
  $("#lightbox").hidden = false;
}

function closeLightbox() {
  const box = $("#lightbox");
  if (box.hidden) return;
  box.hidden = true;
  const img = $("#lightboxImg");
  img.onload = null;
  img.style.width = "";
  img.style.height = "";
  img.removeAttribute("src");
  viewer.src = "";
  viewer.zoom = 1;
  viewer.baseW = 0;
  viewer.baseH = 0;
}

function setZoom(next) {
  viewer.zoom = Math.max(0.4, Math.min(4, next));
  applyZoom();
}

/* ------------------------------------------------------------------ 总览 */

function renderOverview(stage) {
  const page = el("div", { class: "page" });
  page.appendChild(pageChrome());
  page.appendChild(el("h1", { class: "page-title", text: "剩余额度" }));
  page.appendChild(
    el("p", {
      class: "page-sub",
      text: "每个账号的额度窗口互相独立，按各自的下次刷新时间滚动重置。刷新会重新向 OpenAI 查询真实额度，已到期的限流/冻结账号会自动恢复可用。",
    })
  );
  const usable = state.accounts.filter((a) => a.usable);
  const total = state.accounts.reduce((s, a) => s + (a.quota || 0), 0);
  page.appendChild(
    el("div", { class: "row", style: "margin-bottom:16px;gap:10px" }, [
      el("span", { class: "badge ok", text: `可用 ${usable.length} / ${state.accounts.length}` }),
      el("span", { class: "badge mute", text: `总额度 ${total} 张` }),
      el("span", { class: "spacer" }),
      el("button", { class: "btn", text: state.loadingAccounts ? "刷新中…" : "刷新额度", disabled: state.loadingAccounts ? "disabled" : null, onclick: () => loadAccounts(true) }),
      el("button", { class: "btn danger", text: "一键删除限流/冻结", onclick: () => deleteBlocked() }),
    ])
  );
  const section = el("div", { class: "section" });
  if (state.accounts.length === 0) {
    section.appendChild(el("div", { class: "empty", html: "<strong>还没有账号</strong>在「高级导入」中批量导入账号。" }));
  } else {
    const table = el("table", { class: "table" });
    table.appendChild(el("tr", {}, [
      el("th", { text: "账号" }), el("th", { text: "状态" }), el("th", { text: "剩余额度" }),
      el("th", { text: "下次刷新" }), el("th", { text: "倒计时" }), el("th", { text: "" }),
    ]));
    sortedAccounts().forEach((a) => {
      const badgeClass = a.blocked ? "bad" : a.quota <= 0 ? "warn" : "ok";
      const pct = Math.max(4, Math.min(100, Math.round((a.quota / 24) * 100)));
      const barColor = a.blocked || a.quota <= 0 ? "bad" : a.quota <= 3 ? "warn" : "";
      table.appendChild(el("tr", {}, [
        el("td", {}, [el("div", { style: "color:var(--text)", text: a.name }), el("div", { style: "font-size:11px;color:var(--text-faint)", text: a.email })]),
        el("td", {}, [el("span", { class: "badge " + badgeClass, text: a.status || "未知" })]),
        el("td", {}, [el("div", { class: "row", style: "gap:8px" }, [el("span", { class: "mono", style: "color:var(--text);min-width:24px", text: String(a.quota) }), el("div", { class: "bar" }, [el("i", { class: barColor, style: `width:${a.blocked ? 4 : pct}%` })])])]),
        el("td", { class: "mono", text: localWhen(a.reset_at, Date.now()) }),
        el("td", { class: "mono", style: a.reset_due ? "color:var(--ok)" : "", text: a.reset_due ? "已到期，可刷新" : humanize(a.reset_in_ms) }),
        el("td", {}, [el("button", { class: "btn", style: "height:24px;padding:0 8px;font-size:11.5px", text: "删除", onclick: async () => {
          try { await call("delete_accounts", { tokens: [a.access_token] }); toast("已删除 " + a.name); loadAccounts(false); }
          catch (e) { toast(String(e), true); }
        } })]),
      ]));
    });
    section.appendChild(table);
  }
  page.appendChild(section);
  stage.appendChild(page);
}

async function deleteBlocked() {
  const targets = state.accounts.filter((a) => a.blocked || a.quota <= 0);
  if (targets.length === 0) return toast("没有限流或冻结的账号");
  if (!confirm(`确定删除 ${targets.length} 个限流/冻结账号？此操作不可撤销。`)) return;
  try {
    await call("delete_accounts", { tokens: targets.map((a) => a.access_token) });
    toast(`已删除 ${targets.length} 个账号`);
    loadAccounts(false);
  } catch (e) { toast(String(e), true); }
}

/* ------------------------------------------------------------------ 号池 */

function renderPool(stage) {
  const page = el("div", { class: "page" });
  page.appendChild(pageChrome());
  page.appendChild(el("h1", { class: "page-title", text: "号池管理" }));
  page.appendChild(el("p", { class: "page-sub", text: "查看本机账号池中的所有账号。账号的登录与凭据刷新由后端负责。" }));
  const section = el("div", { class: "section" });
  if (state.accounts.length === 0) {
    section.appendChild(el("div", { class: "empty", html: "<strong>号池是空的</strong>前往「高级导入」批量导入账号。" }));
  } else {
    const table = el("table", { class: "table" });
    table.appendChild(el("tr", {}, [el("th", { text: "账号" }), el("th", { text: "类型" }), el("th", { text: "状态" }), el("th", { text: "额度" }), el("th", { text: "" })]));
    sortedAccounts().forEach((a) => {
      table.appendChild(el("tr", {}, [
        el("td", { style: "color:var(--text)", text: a.email }),
        el("td", { text: a.plan || "free" }),
        el("td", {}, [el("span", { class: "badge " + (a.blocked ? "bad" : "ok"), text: a.status })]),
        el("td", { class: "mono", text: String(a.quota) }),
        el("td", {}, [el("button", { class: "btn", style: "height:24px;padding:0 8px;font-size:11.5px", text: "删除", onclick: async () => {
          try { await call("delete_accounts", { tokens: [a.access_token] }); toast("已删除 " + a.name); loadAccounts(false); }
          catch (e) { toast(String(e), true); }
        } })]),
      ]));
    });
    section.appendChild(table);
  }
  page.appendChild(section);
  stage.appendChild(page);
}

/* ------------------------------------------------------------------ API */

function renderApi(stage) {
  const page = el("div", { class: "page" });
  page.appendChild(pageChrome());
  page.appendChild(el("h1", { class: "page-title", text: "API 接入" }));
  page.appendChild(el("p", { class: "page-sub", text: "本机后端提供 OpenAI 兼容接口，可直接用于第三方客户端。" }));
  const base = state.baseUrl || "http://127.0.0.1:38650";
  const section = el("div", { class: "section" });
  section.appendChild(el("div", { class: "field" }, [
    el("div", {}, [el("div", { class: "field-label", text: "接口地址" }), el("div", { class: "field-hint", text: "填到第三方客户端的 Base URL，模型名填 gpt-image-2。" })]),
    el("button", { class: "btn", text: "复制", onclick: () => copy(base + "/v1") }),
  ]));
  section.appendChild(el("div", { style: "padding:14px 18px" }, [
    el("div", { class: "code-block", text: `POST ${base}/v1/images/generations\nAuthorization: Bearer <admin-key>\nContent-Type: application/json\n\n{\n  "model": "gpt-image-2",\n  "prompt": "一只橘猫坐在木窗台上",\n  "n": 1,\n  "response_format": "b64_json"\n}` }),
  ]));
  page.appendChild(section);
  stage.appendChild(page);
}

/** WebView（尤其 Windows）里 clipboard API 常被权限拦住，保留 execCommand 兜底。 */
async function copy(text) {
  const legacy = () => {
    const tmp = document.createElement("textarea");
    tmp.value = String(text || "");
    tmp.setAttribute("readonly", "readonly");
    tmp.style.position = "fixed";
    tmp.style.top = "-1000px";
    tmp.style.opacity = "0";
    document.body.appendChild(tmp);
    tmp.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    tmp.remove();
    return ok;
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(String(text || ""));
      toast("已复制");
      return;
    }
  } catch (e) {}
  if (legacy()) toast("已复制");
  else toast("复制失败，请手动选中内容", true);
}

/* ------------------------------------------------------------------ 导入 */

/** 导入页状态放模块级：非首页路由会被 render() 全量重建（loadAccounts 和定时
    刷新都会触发），输入框内容、解析结果、OAuth 会话都必须能恢复。 */
const imp = {
  text: "",
  rows: null,
  parse: null,
  result: null,
  busy: false,
  proxy: "",
  showManual: false,
  oauth: null,
  callback: "",
  oauthBusy: false,
  oauthResult: null,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JWTISH_RE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/;

function isTotpSecret(s) {
  const clean = String(s || "").replace(/[\s=-]/g, "").toUpperCase();
  return clean.length >= 16 && /^[A-Z2-7]+$/.test(clean);
}

function shortToken(s) {
  const v = String(s || "");
  return v.length > 18 ? v.slice(0, 10) + "…" + v.slice(-6) : v;
}

/* 解析规则对齐 chatgpt2api 号池管理的「邮箱 / 密码 / 第三字段」批量导入。 */
const IMPORT_MAX_BYTES = 1024 * 1024;
const IMPORT_MAX_LINES = 1000;

/** 优先按 ---- 切，其次 ---，最后才是任意 3+ 连字符。
    密码里常带连字符和标点，一上来就用 /-{3,}/ 全切会把密码切断。 */
function splitCredential(line) {
  let parts = line.split("----");
  if (parts.length < 3) {
    const p3 = line.split("---");
    if (p3.length >= 3) parts = p3;
    else {
      const pn = line.split(/-{3,}/);
      if (pn.length >= 3) parts = pn;
    }
  }
  return parts;
}

/** 只解 JWT payload 看 exp，不验签：用于判断这行自带的 token 是否还有效。 */
function jwtExpiresAt(token) {
  try {
    const p = String(token).split(".");
    if (p.length !== 3) return 0;
    const b64 = p[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return Number(JSON.parse(atob(padded)).exp || 0) * 1000;
  } catch (e) {
    return 0;
  }
}

/** 三字段必填，可选第 4 字段 access_token、第 5 字段 refresh_token。
    密码保留原样（不做 trim），邮箱统一小写。 */
function credentialFromParts(parts) {
  if (parts.length < 3) return { error: "应为 邮箱----密码----第三字段（至少三个字段）" };
  const email = String(parts[0]).trim().toLowerCase();
  const password = String(parts[1]);
  const aux = String(parts[2]).trim();
  const token = parts.length > 3 ? String(parts[3]).trim() : "";
  const refresh = parts.length > 4 ? String(parts[4]).trim() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) return { error: "邮箱格式不正确" };
  if (!password.length || password.length > 512 || /[\r\n\0]/.test(password)) return { error: "密码为空或长度超限" };
  if (!aux.length || aux.length > 512 || /[\r\n\0]/.test(aux)) return { error: "第三字段为空或长度超限" };
  if (token && (token.length > 8192 || /[\r\n\0]/.test(token))) return { error: "Token 格式不正确或长度超限" };
  if (refresh && (refresh.length > 8192 || /[\r\n\0]/.test(refresh))) return { error: "RefreshToken 格式不正确或长度超限" };
  return { account: { email, password, auxiliary: aux, accessToken: token, refreshToken: refresh } };
}

/** 自带未过期 token 的行可直接入池；否则记为待 OAuth 授权的凭据行。 */
function rowFromAccount(a) {
  const cred = {
    kind: "credential",
    email: a.email,
    password: a.password,
    totp: a.auxiliary || "",
    accessToken: a.accessToken || "",
    refreshToken: a.refreshToken || "",
  };
  if (a.accessToken && jwtExpiresAt(a.accessToken) > Date.now() + 60000) {
    return {
      kind: "token",
      payload: {
        email: a.email,
        password: a.password,
        totp_secret: a.auxiliary || "",
        access_token: a.accessToken,
        refresh_token: a.refreshToken || "",
        source_type: "oauth_password_2fa",
        type: "oauth",
      },
      credential: cred,
    };
  }
  return cred;
}

function accountFromObject(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  const token = String(o.access_token || o.accessToken || "").trim();
  const email = String(o.email || "").trim().toLowerCase();
  const password = String(o.password || "").trim();
  const totp = String(o.totp_secret || o.totpSecret || o.otp_secret || o.auxiliary || o["2fa"] || "").trim();
  const refresh = String(o.refresh_token || o.refreshToken || "").trim();
  if (token) {
    const payload = Object.assign({}, o, { access_token: token });
    delete payload.accessToken;
    return { kind: "token", payload };
  }
  if (EMAIL_RE.test(email) && password) {
    return rowFromAccount({ email, password, auxiliary: totp, refreshToken: refresh });
  }
  return null;
}

function pushInvalid(out, line, raw, reason) {
  out.rows.push({ kind: "invalid", line, raw: shortToken(raw), reason });
  out.errors.push({ line, reason });
}

function pushEntry(out, entry, line, raw) {
  if (!entry) {
    pushInvalid(out, line, raw, "缺少 access_token 或 邮箱+密码");
    return;
  }
  entry.line = line;
  entry.label = entry.kind === "token" ? shortToken(entry.payload.access_token) : entry.email;
  entry.raw = raw;
  const key = entry.kind === "token" ? entry.payload.access_token : entry.email.toLowerCase();
  if (out.seen.has(key)) {
    out.duplicates++;
    entry.duplicate = true;
  } else {
    out.seen.add(key);
  }
  out.rows.push(entry);
}

/** 返回 { rows, errors, duplicates, truncated }；rows 中每行保留 raw 便于失败回填。 */
function parseImportText(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const out = { rows: [], errors: [], duplicates: 0, truncated: false, seen: new Set() };
  const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(raw).length : raw.length;
  if (bytes > IMPORT_MAX_BYTES) {
    pushInvalid(out, 0, "整段文本", "文本超过 1 MB，请分批导入");
    return out;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed);
      const arr = Array.isArray(data)
        ? data
        : Array.isArray(data.accounts) ? data.accounts : [data];
      arr.forEach((o, i) => pushEntry(out, accountFromObject(o), i + 1, "JSON 对象"));
      return out;
    } catch (e) {
      // 多行 JSON 粘贴时可能只是换行，落到逐行解析兜底。
    }
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length > IMPORT_MAX_LINES) {
    lines.length = IMPORT_MAX_LINES;
    out.truncated = true;
  }
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const v = line.trim();
    if (!v || v.startsWith("#") || v.startsWith("===")) return;
    let entry = null;
    if (v.startsWith("{")) {
      try { entry = accountFromObject(JSON.parse(v)); } catch (e) {}
      if (!entry) {
        pushInvalid(out, lineNo, v, "JSON 解析失败或字段不足");
        return;
      }
    } else if (JWTISH_RE.test(v)) {
      entry = { kind: "token", payload: { access_token: v } };
    } else {
      const parts = /-{3,}/.test(v)
        ? splitCredential(v)
        : v.includes("\t") ? v.split(/\t+/) : v.split("|");
      const parsed = credentialFromParts(parts);
      if (parsed.error) {
        pushInvalid(out, lineNo, v, parsed.error);
        return;
      }
      entry = rowFromAccount(parsed.account);
    }
    pushEntry(out, entry, lineNo, v);
  });
  return out;
}

function importableRows() {
  return (imp.rows || []).filter((r) => r.kind === "token" && !r.duplicate);
}

function pendingCredentials() {
  return (imp.rows || []).filter((r) => r.kind === "credential" && !r.duplicate && !r.authorized);
}

/** 把失败/未处理的凭据行拼回输入框，方便改完直接重试。 */
function rowsToText(rows) {
  return rows.map((r) => {
    if (r.raw && r.kind !== "invalid") return r.raw;
    if (r.kind === "credential") {
      return [r.email, r.password, r.totp, r.accessToken, r.refreshToken]
        .filter((x) => x !== "" && x !== undefined && x !== null)
        .join("----");
    }
    return String(r.raw || "");
  }).filter(Boolean).join("\n");
}

/** 入池失败时把已经换出的 token 回填成「第 4 字段带 token」的行：
    下次解析会走「自带未过期 token → 直接入池」，不用再登录一次。 */
function refillAuthorizedTokens(results) {
  const ok = (Array.isArray(results) ? results : []).filter((x) => x && x.ok && x.access_token);
  const byEmail = new Map();
  (imp.rows || []).forEach((row) => {
    if (row && row.kind === "credential") byEmail.set(String(row.email || "").toLowerCase(), row);
  });
  const lines = ok.map((x) => {
    const row = byEmail.get(String(x.email || "").toLowerCase());
    if (!row || !row.password) return "";
    // 第三字段必须非空（格式要求），token 有效时它的内容不再参与登录。
    return [row.email, row.password, row.totp || "NONE", x.access_token, x.refresh_token || ""].join("----");
  }).filter(Boolean);
  if (!lines.length) return toast("没有可回填的 token", true);
  imp.text = lines.join("\n");
  imp.rows = null;
  imp.parse = null;
  imp.result = null;
  render();
  toast(`已回填 ${lines.length} 条带 token 的行，后端启动后可直接入池`);
}

function renderImportStats(host) {
  host.innerHTML = "";
  const rows = imp.rows || [];
  const p = imp.parse || {};
  if (!rows.length && !String(imp.text || "").trim()) return;
  const tokens = importableRows().length;
  const creds = pendingCredentials().length;
  const bad = rows.filter((r) => r.kind === "invalid").length;
  const parts = [`共 ${rows.length} 行`];
  if (tokens) parts.push(`可直接入池 ${tokens}`);
  if (creds) parts.push(`待授权 ${creds}`);
  if (bad) parts.push(`格式错误 ${bad}`);
  if (p.duplicates) parts.push(`重复跳过 ${p.duplicates}`);
  if (p.truncated) parts.push("仅处理前 1000 行");
  host.appendChild(el("div", { class: "imp-stats" + (bad ? " warn" : ""), text: parts.join(" · ") }));
  if (bad && Array.isArray(p.errors)) {
    const list = p.errors.slice(0, 5).map((x) => x.line ? `第 ${x.line} 行：${x.reason}` : x.reason);
    if (list.length) host.appendChild(el("div", { class: "imp-result-errors", text: list.join(" · ") }));
  }
}

function renderImportRows(host) {
  host.innerHTML = "";
  const rows = imp.rows || [];
  if (!rows.length) {
    host.appendChild(el("div", { class: "imp-empty", text: "粘贴内容后点「解析并预览」，或直接点「导入并授权入池」。" }));
    return;
  }
  host.appendChild(el("div", { class: "imp-row imp-head" }, [
    el("span", { text: "#" }), el("span", { text: "类型" }), el("span", { text: "标识" }),
    el("span", { text: "2FA" }), el("span", { text: "状态" }),
  ]));
  rows.slice(0, 60).forEach((r) => {
    const kind = r.kind === "token" ? "Token" : r.kind === "credential" ? "邮箱密码" : "无效";
    const totp = r.kind === "credential"
      ? (isTotpSecret(r.totp) ? "有效密钥" : r.totp ? "格式存疑" : "未提供")
      : "—";
    const status = r.kind === "invalid"
      ? (r.reason || "无法识别")
      : r.authorized ? "已授权入池"
      : r.duplicate ? "重复，已跳过"
      : r.kind === "token" ? "可直接入池"
      : "待自动授权";
    host.appendChild(el("div", { class: "imp-row" + (r.kind === "invalid" ? " bad" : "") }, [
      el("span", { class: "imp-num", text: String(r.line) }),
      el("span", { class: "imp-kind", text: kind }),
      el("span", { class: "imp-label", title: r.kind === "token" ? "" : r.email, text: r.label || String(r.raw || "") }),
      el("span", { text: totp }),
      el("span", { class: r.kind === "invalid" || r.duplicate ? "imp-bad" : "imp-ok", text: status }),
    ]));
  });
  if (rows.length > 60) {
    host.appendChild(el("div", { class: "imp-empty", text: `还有 ${rows.length - 60} 行未展示，导入时会一并处理。` }));
  }
}

function renderImportResult(host) {
  host.innerHTML = "";
  const r = imp.result;
  if (!r) return;
  const box = el("div", { class: "imp-result" });
  const token = r.tokenResult || {};
  const auth = r.authResult || {};
  const enrolled = auth.enrolled || {};
  const lines = [];
  if (r.tokenCount) {
    lines.push(`Token / JSON ${r.tokenCount} 条：新增 ${Number(token.added) || 0}，跳过 ${Number(token.skipped) || 0}`);
  }
  if (r.credCount) {
    lines.push(auth.unavailable
      ? `凭据 ${r.credCount} 条：自动授权未执行`
      : `凭据 ${r.credCount} 条：成功 ${Number(auth.succeeded) || 0}，失败 ${Number(auth.failed) || 0}，入池新增 ${Number(enrolled.added) || 0}`);
  }
  box.appendChild(el("div", { class: "imp-result-title", text: lines.join("　|　") || "本次没有可处理的数据" }));
  if (auth.unavailable) {
    box.appendChild(el("div", { class: "imp-result-errors", text: String(auth.unavailable) }));
  }
  if (auth.enroll_error) {
    box.appendChild(el("div", {
      class: "imp-result-errors",
      text: `token 已换出，但写入号池失败：${auth.enroll_error}。通常是本机后端没启动；启动后把下面回填的行再导入一次即可。`,
    }));
    box.appendChild(el("button", {
      class: "btn", text: "回填已换出的 token（可直接入池）",
      onclick: () => refillAuthorizedTokens(auth.results),
    }));
  }
  const tokenErrors = Array.isArray(token.errors) ? token.errors : [];
  if (tokenErrors.length) {
    box.appendChild(el("div", { class: "imp-result-errors", text: tokenErrors.slice(0, 5).map((x) => JSON.stringify(x)).join(" · ") }));
  }
  const failures = Array.isArray(r.failures) ? r.failures : [];
  if (failures.length) {
    const list = el("div", { class: "imp-result-errors" });
    failures.slice(0, 8).forEach((f) => list.appendChild(el("div", { text: `${f.email}：${f.error}` })));
    if (failures.length > 8) list.appendChild(el("div", { text: `…还有 ${failures.length - 8} 条` }));
    box.appendChild(list);
    box.appendChild(el("button", {
      class: "btn", text: "把失败行放回输入框", onclick: () => {
        const failed = new Set(failures.map((f) => String(f.email || "").toLowerCase()));
        const rows = (imp.rows || []).filter((x) => x.kind === "credential" && failed.has(x.email.toLowerCase()));
        imp.text = rowsToText(rows.length ? rows : pendingCredentials());
        imp.rows = null;
        imp.parse = null;
        imp.result = null;
        render();
        toast("失败行已回填，可修改后重试");
      },
    }));
  }
  host.appendChild(box);
}

function renderOAuth(host) {
  host.innerHTML = "";
  if (!imp.showManual) return;
  const pending = pendingCredentials();

  const box = el("div", { class: "imp-oauth" });
  box.appendChild(el("div", { class: "imp-section-title", text: `手动 OAuth 授权（备用，待处理 ${pending.length} 条）` }));
  if (!imp.oauth) {
    box.appendChild(el("p", {
      class: "imp-hint",
      text: "当自动授权被风控拦截、或上游要求邮箱验证码时，可以在这里逐个用系统浏览器完成登录，再把 callback URL 贴回来换 token。一次只处理一个账号。",
    }));
    if (!pending.length) {
      box.appendChild(el("p", { class: "imp-hint", text: "当前没有待授权的凭据行。" }));
      host.appendChild(box);
      return;
    }
    box.appendChild(el("button", {
      class: "btn primary",
      text: `为 ${pending[0].email} 开始授权`,
      disabled: imp.oauthBusy ? "disabled" : null,
      onclick: () => startOAuth(pending[0].email),
    }));
  } else {
    box.appendChild(el("div", { class: "imp-hint", text: `当前授权账号：${imp.oauth.email} · 会话有效期有限，请一次完成。` }));
    const url = String(imp.oauth.authorize_url || "");
    box.appendChild(el("div", { class: "imp-oauth-actions" }, [
      el("a", { class: "btn primary", href: url, target: "_blank", rel: "noopener noreferrer", text: "打开授权页面" }),
      el("button", { class: "btn", text: "复制链接", onclick: () => copy(url) }),
      el("button", { class: "btn", text: "取消", onclick: () => { imp.oauth = null; imp.callback = ""; render(); } }),
    ]));
    const urlInput = el("input", { class: "input imp-url", readonly: "readonly" });
    urlInput.value = url;
    urlInput.addEventListener("focus", () => urlInput.select());
    box.appendChild(urlInput);
    box.appendChild(el("p", {
      class: "imp-hint",
      text: "登录成功后浏览器会跳到 platform.openai.com/auth/callback?... 页面（页面本身可能报错，属正常）。把地址栏完整 URL 粘贴到下面，或直接粘 code。",
    }));
    const cb = el("textarea", {
      class: "input imp-callback",
      placeholder: "粘贴 callback URL 或 code…",
      oninput: (e) => { imp.callback = e.target.value; },
    });
    cb.value = imp.callback;
    box.appendChild(cb);
    box.appendChild(el("button", {
      class: "btn primary",
      text: imp.oauthBusy ? "正在换取 token…" : "完成授权并入池",
      disabled: imp.oauthBusy ? "disabled" : null,
      onclick: finishOAuth,
    }));
  }
  if (imp.oauthResult) {
    box.appendChild(el("div", { class: "imp-result" }, [
      el("div", { class: "imp-result-title", text: String(imp.oauthResult) }),
    ]));
  }
  host.appendChild(box);
}

async function startOAuth(email) {
  imp.oauthBusy = true;
  imp.oauthResult = null;
  render();
  try {
    const info = await call("oauth_start", { emailHint: email });
    const url = String(info && info.authorize_url || "");
    if (!url) throw new Error("后端没有返回授权地址");
    imp.oauth = { email, session_id: String(info.session_id || ""), authorize_url: url };
    imp.callback = "";
  } catch (e) {
    toast("发起授权失败：" + String(e && e.message ? e.message : e), true);
  } finally {
    imp.oauthBusy = false;
    render();
  }
}

async function finishOAuth() {
  if (!imp.oauth) return;
  const callback = String(imp.callback || "").trim();
  if (!callback) return toast("请先粘贴 callback URL 或 code", true);
  imp.oauthBusy = true;
  render();
  try {
    const email = imp.oauth.email;
    const result = await call("oauth_finish", {
      sessionId: imp.oauth.session_id,
      callback,
    });
    const added = Number(result && result.added) || 0;
    imp.oauthResult = added > 0
      ? `${email} 授权成功，已入池 ${added} 个账号`
      : `${email} 授权完成，账号可能已存在（跳过）`;
    imp.rows = (imp.rows || []).map((r) =>
      r.kind === "credential" && r.email === email ? Object.assign({}, r, { authorized: true }) : r
    );
    imp.oauth = null;
    imp.callback = "";
    toast("账号已入池");
    loadAccounts(true, true);
  } catch (e) {
    imp.oauthResult = "授权失败：" + String(e && e.message ? e.message : e);
    toast("授权失败", true);
  } finally {
    imp.oauthBusy = false;
    render();
  }
}

function renderImport(stage) {
  const page = el("div", { class: "page" });
  page.appendChild(pageChrome());
  page.appendChild(el("h1", { class: "page-title", text: "高级导入" }));
  page.appendChild(el("p", {
    class: "page-sub",
    text: "邮箱 / 密码 / 第三字段批量导入（每行一条）；也支持裸 access_token 与完整账号 JSON。",
  }));

  const note = el("div", { class: "imp-note" });
  note.appendChild(el("div", { class: "imp-note-title", text: "格式与入池方式" }));
  note.appendChild(el("div", {
    class: "imp-note-body",
    text: "每行：邮箱----密码----2FA密钥（3 或 4 个连字符都识别），可选第 4 字段 access_token、第 5 字段 refresh_token。支持粘贴或选择 UTF-8 TXT 文件，# 开头的行会被忽略。",
  }));
  note.appendChild(el("div", {
    class: "imp-note-body",
    text: "自带未过期 token 的行直接写入号池；只有邮箱密码的行由客户端内置的 OAuth + TOTP 自动换 token 后入池，不需要 Python 或任何额外运行时。密码保留原样、重复邮箱自动跳过，失败行可一键回填重试。",
  }));
  note.appendChild(el("div", {
    class: "imp-note-body",
    text: "自动授权会访问 auth.openai.com，需要能连通上游的网络；代理一栏留空时会自动读取系统代理并探测常见本地端口。上游若要求邮箱验证码，自动登录无法完成，可展开下方手动 OAuth 授权。",
  }));
  page.appendChild(note);

  const section = el("div", { class: "section" });
  const ta = el("textarea", {
    id: "impText",
    class: "input imp-input",
    placeholder: "xxx@duck.com----6ZyL13214123PXy5e^----INRUA4HAVHPT5XXXXXXXX5TVH4NU2\nsecond@duck.com---your-password---BASE32SECRET\neyJhbGciOi...（或粘贴完整账号 JSON 数组）",
    oninput: (e) => {
      imp.text = e.target.value;
      imp.rows = null;
      imp.parse = null;
      imp.result = null;
      refreshSections();
    },
  });
  ta.value = imp.text;

  const fileInput = el("input", {
    type: "file", accept: ".txt,text/plain", class: "imp-file", "aria-label": "选择账号 TXT 文件",
    onchange: (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > 1024 * 1024) { toast("TXT 文件超过 1 MB，请分批导入", true); return; }
      const reader = new FileReader();
      reader.onload = () => {
        imp.text = String(reader.result || "");
        ta.value = imp.text;
        parseNow();
      };
      reader.readAsText(f, "utf-8");
      e.target.value = "";
    },
  });

  const proxyInput = el("input", {
    class: "input imp-proxy",
    placeholder: "代理（可选，如 http://127.0.0.1:7890；留空自动探测本机代理）",
    "aria-label": "授权代理",
    oninput: (e) => { imp.proxy = e.target.value; },
  });
  proxyInput.value = imp.proxy;

  const actions = el("div", { class: "imp-actions" }, [
    el("button", { class: "btn", text: "解析并预览", onclick: () => parseNow() }),
    el("button", {
      class: "btn primary", id: "impSubmit",
      text: imp.busy ? "正在授权并入池…" : "导入并授权入池",
      disabled: imp.busy ? "disabled" : null,
      onclick: submitImport,
    }),
    el("button", {
      class: "btn", text: "清空输入", onclick: () => {
        imp.text = "";
        imp.rows = null;
        imp.parse = null;
        imp.result = null;
        imp.oauth = null;
        imp.callback = "";
        render();
      },
    }),
  ]);
  section.appendChild(el("div", { class: "imp-pad" }, [fileInput, ta, proxyInput, actions]));
  page.appendChild(section);

  const statsHost = el("div");
  page.appendChild(statsHost);
  const preview = el("div", { class: "imp-table" });
  page.appendChild(preview);
  const resultHost = el("div");
  page.appendChild(resultHost);
  page.appendChild(el("button", {
    class: "btn imp-manual-toggle",
    text: imp.showManual ? "收起手动 OAuth 授权（备用）" : "手动 OAuth 授权（备用）",
    onclick: () => { imp.showManual = !imp.showManual; render(); },
  }));
  const oauthHost = el("div");
  page.appendChild(oauthHost);

  stage.appendChild(page);
  refreshSections();
  syncImportButtons();

  function refreshSections() {
    renderImportStats(statsHost);
    renderImportRows(preview);
    renderImportResult(resultHost);
    renderOAuth(oauthHost);
    syncImportButtons();
  }

  function parseNow() {
    const parsed = parseImportText(imp.text);
    imp.rows = parsed.rows;
    imp.parse = parsed;
    imp.result = null;
    refreshSections();
  }

  async function submitImport() {
    if (imp.busy) return;
    if (!imp.rows) parseNow();
    const tokens = importableRows();
    const creds = pendingCredentials();
    if (!tokens.length && !creds.length) {
      const bad = imp.parse && imp.parse.errors ? imp.parse.errors.length : 0;
      toast(bad ? "所有行格式都不正确，请看下方逐行错误" : "没有可导入的数据，请先检查格式", true);
      return;
    }
    imp.busy = true;
    syncImportButtons();
    const failures = [];
    const tokenCount = tokens.length;
    const credCount = creds.length;
    let tokenResult = null;
    let authResult = null;
    try {
      if (tokens.length) {
        try {
          tokenResult = await call("import_accounts", { accounts: tokens.map((r) => r.payload) });
        } catch (e) {
          const msg = String(e && e.message ? e.message : e);
          tokenResult = { added: 0, skipped: 0, errors: [{ error: msg }] };
          tokens.forEach((r) => failures.push({ email: r.label, error: "直接入池失败" }));
        }
      }
      if (creds.length) {
        try {
          authResult = await call("authorize_credentials", {
            credentials: creds.map((r) => ({
              email: r.email,
              password: r.password,
              totp_secret: r.totp || "",
              access_token: r.accessToken || "",
              refresh_token: r.refreshToken || "",
            })),
            proxy: String(imp.proxy || "").trim(),
          });
          const results = Array.isArray(authResult.results) ? authResult.results : [];
          const okEmails = new Set(results.filter((x) => x.ok).map((x) => String(x.email || "").toLowerCase()));
          imp.rows = (imp.rows || []).map((r) =>
            r.kind === "credential" && okEmails.has(r.email.toLowerCase())
              ? Object.assign({}, r, { authorized: true }) : r
          );
          results.filter((x) => !x.ok).forEach((x) =>
            failures.push({ email: String(x.email || "—"), error: String(x.error || "授权失败") })
          );
        } catch (e) {
          authResult = { unavailable: String(e && e.message ? e.message : e), results: [] };
          creds.forEach((r) => failures.push({ email: r.email, error: "自动授权未执行" }));
        }
      }
      imp.result = { tokenResult, authResult, failures, tokenCount, credCount };
      try { await loadAccounts(true, true); } catch (e) {}
      toast(failures.length ? `完成，但有 ${failures.length} 条失败` : "导入完成", !!failures.length);
    } finally {
      imp.busy = false;
      render();
    }
  }

  function syncImportButtons() {
    const btn = $("#impSubmit");
    if (!btn) return;
    btn.disabled = imp.busy || !String(imp.text || "").trim();
    btn.textContent = imp.busy ? "正在授权并入池…" : "导入并授权入池";
  }
}

/* ------------------------------------------------------------------ 设置 */

function renderSettings(stage) {
  const page = el("div", { class: "page" });
  page.appendChild(pageChrome());
  page.appendChild(el("h1", { class: "page-title", text: "插件设置" }));
  page.appendChild(el("p", { class: "page-sub", text: "设置会立即保存到本地配置。" }));
  const section = el("div", { class: "section" });
  section.appendChild(el("div", { class: "field" }, [
    el("div", {}, [el("div", { class: "field-label", text: "输出文字说明" }), el("div", { class: "field-hint", text: "开启后每轮会在图片之外再生成一段文字描述。生图模型本身只出图，文字由额外的文本请求补上，会多消耗一次额度。" })]),
    el("button", { class: "switch" + (state.settings.text_reply ? " on" : ""), role: "switch", "aria-checked": state.settings.text_reply ? "true" : "false", onclick: () => saveSettings({ text_reply: !state.settings.text_reply }) }),
  ]));
  section.appendChild(el("div", { class: "field" }, [
    el("div", {}, [el("div", { class: "field-label", text: "换号上下文轮数" }), el("div", { class: "field-hint", text: "换号后注入最近多少轮文字，编号保留真实轮次。" })]),
    el("input", { class: "input", type: "number", min: "1", max: "50", value: String(state.settings.context_rounds), onchange: (e) => saveSettings({ context_rounds: Number(e.target.value) || 5 }) }),
  ]));
  section.appendChild(el("div", { class: "field" }, [
    el("div", {}, [el("div", { class: "field-label", text: "自动沿用上一张图" }), el("div", { class: "field-hint", text: "开启后每轮会带上上一张成品图继续改，画面更连贯，但要多上传几 MB 并改走改图通道，生成明显更慢。默认关闭以优先速度。" })]),
    el("button", { class: "switch" + (state.settings.auto_reference ? " on" : ""), role: "switch", "aria-checked": state.settings.auto_reference ? "true" : "false", onclick: () => saveSettings({ auto_reference: !state.settings.auto_reference }) }),
  ]));
  section.appendChild(el("div", { class: "field" }, [
    el("div", {}, [el("div", { class: "field-label", text: "启动时自动检查并更新" }), el("div", { class: "field-hint", text: "发现新版本时会在应用内自动下载并安装，完成后只需点一次重启。" })]),
    el("button", { class: "switch" + (state.settings.auto_check_update ? " on" : ""), role: "switch", onclick: () => saveSettings({ auto_check_update: !state.settings.auto_check_update }) }),
  ]));
  section.appendChild(el("div", { class: "field" }, [
    el("div", {}, [
      el("div", { class: "field-label", text: "后端连接地址" }),
      el("div", { class: "field-hint", text: "默认 http://127.0.0.1:38650。若后端在别的端口、另一台机器或用其它方式部署，改成实际地址后会自动重连。" }),
    ]),
    el("input", {
      class: "input",
      value: state.settings.base_url || "",
      placeholder: "http://127.0.0.1:38650",
      onchange: async (e) => {
        const v = String(e.target.value || "").trim() || "http://127.0.0.1:38650";
        await saveSettings({ base_url: v });
        state.diagnostic = null;
        loadAccounts(false);
      },
    }),
  ]));
  section.appendChild(el("div", { class: "field" }, [
    el("div", {}, [el("div", { class: "field-label", text: "图片保存目录" }), el("div", { class: "field-hint", text: state.imagesDir || "" })]),
    el("button", { class: "btn", text: "打开文件夹", onclick: () => call("reveal_images").catch((e) => toast(String(e), true)) }),
  ]));
  page.appendChild(section);

  const about = el("div", { class: "section", style: "margin-top:16px" });
  about.appendChild(el("div", { class: "field" }, [
    el("div", {}, [el("div", { class: "field-label", text: "当前版本 v" + state.version }), el("div", { class: "field-hint", text: state.update && state.update.has_update ? `发现新版本 v${state.update.latest}` : "已是最新版本" })]),
    el("button", { class: "btn", text: "检查更新", onclick: () => checkUpdate(true) }),
  ]));
  page.appendChild(about);
  stage.appendChild(page);
}

async function saveSettings(patch) {
  const next = Object.assign({}, state.settings, patch);
  state.settings = next;
  if (next.base_url) state.baseUrl = next.base_url;
  try {
    state.settings = await call("save_settings", { settings: next });
    toast("已保存");
  } catch (e) {
    toast(String(e), true);
  }
  render();
}

/* ------------------------------------------------------------------ 应用内更新 */

function renderUpdateBar() {
  const bar = $("#updateBar");
  const s = state.updateState;
  if (!s || s.stage === "idle" || s.stage === "dismissed") {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const title = $("#updateTitle");
  const desc = $("#updateDesc");
  const later = $("#updateLater");
  const action = $("#updateAction");
  const v = s.info ? "v" + s.info.latest : "";
  later.hidden = true;
  action.hidden = true;
  later.onclick = () => {
    clearTimeout(autoUpdateTimer);
    state.updateState = { stage: "dismissed" };
    renderUpdateBar();
  };
  if (s.stage === "found") {
    title.textContent = `发现新版本 ${v}`;
    desc.textContent = "8 秒后自动下载并安装，无需手动打开安装包；不想现在更新可点「稍后」";
    later.hidden = false;
    action.hidden = false;
    action.textContent = "立即更新";
    action.onclick = () => { clearTimeout(autoUpdateTimer); startAutoUpdate(); };
  } else if (s.stage === "downloading") {
    title.textContent = `正在下载 ${v}…`;
    desc.textContent = "走 gh-proxy 镜像，下载完成后会自动安装";
    later.hidden = false;
  } else if (s.stage === "installing") {
    title.textContent = `正在安装 ${v}…`;
    desc.textContent = "请勿关闭应用，安装完成后点一下重启即可";
  } else if (s.stage === "done") {
    title.textContent = `已更新到 ${v}`;
    desc.textContent = "新版本已安装，重启应用后生效";
    action.hidden = false;
    action.textContent = "立即重启";
    action.onclick = () => call("restart_app").catch(() => {});
  } else if (s.stage === "error") {
    title.textContent = "更新失败";
    desc.textContent = s.message || "可以在设置里重新检查更新";
    later.hidden = false;
    action.hidden = false;
    action.textContent = "重试";
    action.onclick = () => startAutoUpdate();
  }
}

const UPDATE_CACHE_KEY = "gif:update-cache";
const UPDATE_TTL = 6 * 60 * 60 * 1000;

/** 只缓存「已是最新」的结果；有新版本时绝不缓存，避免漏掉更新提示。 */
function cachedNoUpdate() {
  try {
    const raw = JSON.parse(localStorage.getItem(UPDATE_CACHE_KEY) || "null");
    if (raw && raw.ts && Date.now() - raw.ts < UPDATE_TTL && raw.info && !raw.info.has_update) {
      return raw.info;
    }
  } catch (e) {}
  return null;
}

function cacheUpdate(info) {
  try {
    localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify({ ts: Date.now(), info }));
  } catch (e) {}
}

/** 自动检查一个进程只做一次，「已是最新」再缓存 6 小时。
    切会话、回首页、定时 render 都不会再向 GitHub 发请求；只有手动点
    版本号 / 设置页「检查更新」才强制查，并用 updateInFlight 防连点。 */
async function checkUpdate(manual) {
  if (!manual) {
    if (state.updateChecked || updateInFlight) return;
    state.updateChecked = true;
    const cached = cachedNoUpdate();
    if (cached) {
      state.update = cached;
      renderChrome();
      return;
    }
  }
  if (updateInFlight) return updateInFlight;
  updateInFlight = (async () => {
    try {
      const info = await call("check_update");
      state.update = info;
      cacheUpdate(info);
      renderChrome();
      if (info.has_update) {
        state.updateState = { stage: "found", info };
        renderUpdateBar();
        if (!manual && state.settings.auto_check_update) {
          clearTimeout(autoUpdateTimer);
          // 留出足够时间让用户看到提示并点「稍后」；不点就全自动完成。
          autoUpdateTimer = setTimeout(() => startAutoUpdate(), 8000);
        }
      } else if (manual) {
        state.updateState = { stage: "idle" };
        renderUpdateBar();
        toast("已是最新版本");
      }
    } catch (e) {
      // 自动检查失败不写缓存，下次启动还能重试。
      if (manual) toast(String(e && e.message ? e.message : e), true);
    }
  })().finally(() => { updateInFlight = null; });
  return updateInFlight;
}

async function startAutoUpdate() {
  const s = state.updateState;
  const info = s && s.info ? s.info : state.update;
  if (!info) return;
  // 必须传直连地址：后端 download() 自己会拼 gh-proxy 前缀并依次回退。
  // 传 proxy_url 会被再代理一次，拿到双重前缀的错误页还被当成安装包写盘。
  const url = info.direct_url || info.proxy_url;
  if (!url) {
    state.updateState = { stage: "error", info, message: "该版本没有可下载的安装包" };
    return renderUpdateBar();
  }
  try {
    state.updateState = { stage: "downloading", info };
    renderUpdateBar();
    const path = await call("download_update", { url, version: info.latest });
    state.updateState = { stage: "installing", info, path };
    renderUpdateBar();
    await call("install_update", { path, version: info.latest });
    state.updateState = { stage: "done", info, path };
    renderUpdateBar();
  } catch (e) {
    state.updateState = { stage: "error", info, message: String(e && e.message ? e.message : e) };
    renderUpdateBar();
  }
}

/* ------------------------------------------------------------------ 浮层 */

function openMenu() {
  $("#avatarMenu").hidden = false;
}
function closeMenu() {
  $("#avatarMenu").hidden = true;
}

function bindChrome() {
  $$("#avatarMenu .menu-item").forEach((b) => b.addEventListener("click", () => setRoute(b.dataset.route)));

  const box = $("#lightbox");
  const img = $("#lightboxImg");
  $("#lightboxClose").addEventListener("click", (e) => { e.stopPropagation(); closeLightbox(); });
  $("#lightboxInner").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeLightbox(); });
  box.addEventListener("click", (e) => { if (e.target === box) closeLightbox(); });
  img.addEventListener("click", (e) => e.stopPropagation());
  img.addEventListener("dblclick", (e) => { e.stopPropagation(); setZoom(1); });
  box.addEventListener("wheel", (e) => {
    if (box.hidden) return;
    // 未放大时滚轮缩放；一旦超出视口，普通滚轮交还给容器做平移，
    // 否则放大后的边缘永远滚不到。按住 Ctrl/⌘ 则任何时候都是缩放。
    if (viewer.zoom > 1 && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(viewer.zoom + (e.deltaY < 0 ? 0.15 : -0.15));
  }, { passive: false });
  const stop = (e) => e.stopPropagation();
  $("#lightboxZoomIn").addEventListener("click", (e) => { stop(e); setZoom(viewer.zoom + 0.25); });
  $("#lightboxZoomOut").addEventListener("click", (e) => { stop(e); setZoom(viewer.zoom - 0.25); });
  $("#lightboxFit").addEventListener("click", (e) => { stop(e); setZoom(1); });
  $(".lightbox-toolbar").addEventListener("click", stop);

  window.addEventListener("resize", () => {
    if (!$("#lightbox").hidden && viewer.baseW) fitLightbox();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeLightbox();
    closeMenu();
    closeAccountPop();
  });
  document.addEventListener("click", (e) => {
    if (!$("#avatarMenu").hidden && !e.target.closest("#avatarMenu,.avatar-btn")) closeMenu();
    if (!state.accountPopOpen) return;
    // composedPath 在事件派发时就固定了：账号行的 onclick 可能已经 render()
    // 把弹层从 DOM 里移除，此时 closest() 会误判成「点到了外面」。
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const inside = path.some(
      (n) => n && n.classList && (n.classList.contains("account-pop") || n.classList.contains("model-pill"))
    );
    if (!inside) closeAccountPop();
  });
  // 定时刷新只用于倒计时；账号弹层打开时跳过，避免打断滚动和点击。
  // 导入页有输入框与进行中的 OAuth 会话，全量重建会清掉草稿，同样跳过。
  tickTimer = setInterval(() => {
    if (state.accountPopOpen || state.route === "import") return;
    render();
  }, 60000);
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  bindChrome();
  try {
    const info = await call("boot_info");
    state.version = info.version;
    state.repo = info.repo;
    state.baseUrl = info.base_url;
    state.dataDir = info.data_dir;
    state.imagesDir = info.images_dir;
    state.adminKeyReady = info.admin_key_ready !== false;
    state.settings = info.settings;
  } catch (e) {
    // 浏览器预览时没有 Tauri，界面照常渲染，只是不能生图。
    state.version = "0.0.0-preview";
  }

  try {
    state.conversations = (await call("list_conversations")) || [];
    if (state.conversations.length) {
      const data = await call("load_conversation", { id: state.conversations[0].id });
      state.conversation = normalizeConversation(data || {});
    }
  } catch (e) {
    state.conversations = [];
  }
  if (!state.conversation) {
    const now = Date.now();
    state.conversation = { id: uid("c"), title: "新会话", createdAt: now, updatedAt: now, turns: [] };
  }

  render();
  await loadAccounts(false);
  if (state.settings.auto_check_update) checkUpdate(false);
}

boot();

/* 供回归测试使用：纯函数挂到 window。 */
window.__gif = { humanize, localWhen, parseIsoUtc, composeInjectedPrompt, sortedAccounts, stripDataUrl, normalizeConversation };
