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
  busy: false,
  pendingInject: false,
  // 更新
  updateState: null,
  // DOM 缓存
  dom: null,
  stageRoute: null,
};

let tickTimer = null;
let genTimer = null;
let saveTimer = null;
let autoUpdateTimer = null;
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

async function loadAccounts(force) {
  state.loadingAccounts = true;
  render();
  try {
    state.accounts = await call(force ? "refresh_accounts" : "list_accounts");
    state.online = true;
    if (!state.boundToken) {
      const best = pickBestAccount();
      if (best) state.boundToken = best.access_token;
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("后端未连接")) state.online = false;
    else {
      state.online = true;
      toast(msg, true);
    }
  } finally {
    state.loadingAccounts = false;
    render();
  }
}

/* ------------------------------------------------------------------ 路由 */

const ROUTES = {
  home: ["◈", "对话"],
  overview: ["◔", "剩余额度"],
  pool: ["▤", "号池管理"],
  api: ["⌘", "API 接入"],
  import: ["↧", "高级导入"],
  settings: ["⚙", "设置"],
};

function setRoute(name) {
  state.route = name;
  closeMenu();
  state.accountPopOpen = false;
  render();
  const stage = $("#stage");
  if (stage) stage.scrollTop = 0;
}

function render() {
  renderRail();
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

function renderRail() {
  const nav = $("#railNav");
  if (!nav) return;
  nav.innerHTML = "";
  nav.appendChild(
    el("button", {
      class: "rail-btn" + (state.route === "home" ? " active" : ""),
      title: ROUTES.home[1],
      text: "◈",
      onclick: () => setRoute("home"),
    })
  );
  const chip = $("#versionBtn");
  if (chip) {
    chip.textContent = "v" + state.version;
    chip.className = "version-chip" + (state.update && state.update.has_update ? " has-update" : "");
    chip.title = state.update && state.update.has_update ? `发现新版本 v${state.update.latest}` : "检查更新";
  }
  const letter = (state.accounts[0] && state.accounts[0].name ? state.accounts[0].name[0] : "L").toUpperCase();
  $("#avatarLetter").textContent = letter;
  $("#menuAvatar").textContent = letter;
  $("#menuName").textContent = "ligang";
  $("#menuPlan").textContent = state.online === false ? "后端未连接" : "本地客户端";
}

/* ------------------------------------------------------------------ 首页骨架 */

function buildHome(stage) {
  const root = el("div", { class: "home" });

  const sidebar = el("aside", { class: "session-sidebar" });
  sidebar.appendChild(
    el("div", { class: "sidebar-head" }, [
      el("button", { class: "new-chat", text: "+ 新建对话", onclick: () => newConversation() }),
      el("div", { class: "sidebar-label", text: "历史会话" }),
    ])
  );
  const list = el("div", { class: "session-list" });
  sidebar.appendChild(list);

  const main = el("div", { class: "chat-main" });
  const title = el("div", { class: "chat-title", text: "图像" });
  const sub = el("div", { class: "chat-sub", text: "描述画面，或上传参考图继续修改" });
  const offline = el("div", { class: "notice", hidden: true });
  const head = el("div", { class: "chat-head" }, [
    el("div", { class: "chat-head-copy" }, [title, sub]),
    el("div", { class: "chat-head-actions" }, [offline]),
  ]);

  const scroll = el("div", { class: "chat-scroll" });
  const inner = el("div", { class: "chat-inner" });
  scroll.appendChild(inner);

  const composer = buildComposer();
  main.appendChild(head);
  main.appendChild(scroll);
  main.appendChild(composer.wrap);

  root.appendChild(sidebar);
  root.appendChild(main);
  stage.appendChild(root);

  scroll.addEventListener("scroll", () => {
    if (!state.dom) return;
    state.dom.atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 48;
  });

  state.dom = Object.assign({ root, sidebar, list, head, title, sub, offline, scroll, inner, msgSig: "", listSig: "", atBottom: true }, composer);
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
    wrap.appendChild(
      el("div", { class: "gen-card" }, [
        el("div", { class: "skel gen-skel" }),
        el("div", { class: "gen-row" }, [
          el("div", { class: "thinking" }, [el("i"), el("i"), el("i")]),
          el("span", { class: "gen-status", text: "正在理解你的描述…" }),
        ]),
      ])
    );
    return wrap;
  }
  if (t.status === "error") {
    wrap.appendChild(el("div", { class: "msg-error" }, [el("span", { text: "生成失败" }), el("span", { text: t.error || "未知错误" })]));
    wrap.appendChild(el("button", { class: "btn retry-btn", text: "重新编辑这条提示词", onclick: () => retryTurn(t.id) }));
    return wrap;
  }
  if (t.image) {
    wrap.appendChild(
      el("div", { class: "msg-img", title: "点击放大", onclick: () => openLightbox(t.image) }, [
        el("img", { src: t.image, alt: t.prompt }),
      ])
    );
    wrap.appendChild(
      el("div", { class: "msg-actions" }, [
        el("button", { class: "btn", text: "放大查看", onclick: () => openLightbox(t.image) }),
        el("a", { class: "btn", href: t.image, download: `image-${t.id}.png`, text: "下载" }),
      ])
    );
  }
  if (t.text) wrap.appendChild(el("div", { class: "msg-text", text: t.text }));
  const bits = [t.account || "本地", clock(t.createdAt)];
  if (t.injected) bits.push("已注入上下文");
  if (t.reference) bits.push("自定义参考图");
  else if (t.refRound) bits.push(`参考第 ${t.refRound} 轮`);
  wrap.appendChild(el("div", { class: "msg-meta", text: bits.join(" · ") }));
  return wrap;
}

function syncGenAnimation() {
  const running = state.conversation && state.conversation.turns.some((t) => t.status === "running");
  if (running && !genTimer) {
    const texts = ["正在理解你的描述…", "正在绘制画面…", "正在收尾，马上就好…", "还在生成，请稍等…"];
    let i = 0;
    genTimer = setInterval(() => {
      i = (i + 1) % texts.length;
      const node = $(".gen-status", state.dom && state.dom.inner);
      if (node) node.textContent = texts[i];
    }, 4500);
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

function normalizeConversation(raw) {
  const c = raw || {};
  const conv = {
    id: c.id || uid("c"),
    title: c.title || "新会话",
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now(),
    turns: Array.isArray(c.turns) ? c.turns : [],
  };
  conv.turns.forEach((t) => {
    if (t.status === "running" || t.status === "pending") {
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
  if (state.conversation && state.conversation.turns.length === 0) {
    focusComposer();
    return;
  }
  const now = Date.now();
  state.conversation = { id: uid("c"), title: "新会话", createdAt: now, updatedAt: now, turns: [] };
  state.input = "";
  state.reference = null;
  state.busy = false;
  state.pendingInject = false;
  state.accountPopOpen = false;
  if (state.dom) {
    state.dom.textarea.value = "";
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
    state.conversation = normalizeConversation(data || { id, turns: [] });
    state.input = "";
    state.reference = null;
    state.busy = false;
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

function buildComposer() {
  const wrap = el("div", { class: "composer-wrap" });

  const refChip = el("div", { class: "reference-chip", hidden: true });
  const composer = el("div", { class: "composer" });

  const refInput = el("input", { type: "file", accept: "image/*", style: "display:none" });
  refInput.addEventListener("change", onReferencePicked);

  const plus = el("button", {
    class: "composer-plus",
    title: "选择参考图（可基于图片继续修改）",
    text: "+",
    onclick: () => refInput.click(),
  });

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

  const pill = el("button", { class: "model-pill", title: "选择账号", onclick: toggleAccountPop });
  const sendBtn = el("button", { class: "composer-send", title: "生成（Enter）", text: "↑", onclick: sendPrompt });
  const right = el("div", { class: "composer-right" }, [pill, sendBtn]);
  composer.appendChild(plus);
  composer.appendChild(refInput);
  composer.appendChild(textarea);
  composer.appendChild(right);

  const hint = el("div", { class: "composer-hint", text: "Enter 发送 · Shift+Enter 换行 · + 添加参考图" });
  const popHolder = el("div", { class: "pop-holder" });
  wrap.appendChild(refChip);
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

  d.offline.hidden = state.online !== false;
  if (state.online === false) {
    d.offline.innerHTML = "";
    d.offline.appendChild(el("span", { text: "本机后端未启动，生图不可用。请先启动 chatgpt2api 服务。" }));
    d.offline.appendChild(el("button", { class: "btn", text: "重新连接", onclick: () => loadAccounts(false) }));
  }

  d.popHolder.innerHTML = "";
  if (state.accountPopOpen) d.popHolder.appendChild(buildAccountPop());
}

function canSend() {
  if (state.busy || !state.conversation) return false;
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
    pop.appendChild(el("div", { class: "pop-title", text: "没有账号，请在头像菜单 → 号池管理中导入" }));
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
          onclick: () => {
            state.boundToken = a.access_token;
            state.accountPopOpen = false;
            state.pendingInject = true;
            toast("已切换到 " + a.name);
            render();
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

function toggleAccountPop() {
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
    refRound: !refDataUrl && prev ? state.conversation.turns.indexOf(prev) + 1 : 0,
    injected: false,
    createdAt: Date.now(),
  };
  state.conversation.turns.push(turn);
  if (state.conversation.title === "新会话") {
    state.conversation.title = prompt.length > 18 ? prompt.slice(0, 18) + "…" : prompt;
  }
  state.input = "";
  state.reference = null;
  state.busy = true;

  const d = state.dom;
  if (d) {
    d.textarea.value = "";
    d.msgSig = "";
    autoGrow();
    renderReferenceChip();
  }
  persistConversation();
  render();
  focusComposer();

  // 手动上传的参考图优先；否则沿用上一张成功的图继续改（保持画面连贯）。
  let reference = refDataUrl ? stripDataUrl(refDataUrl) : null;
  if (!reference && prev) reference = stripDataUrl(prev.image);

  let finalPrompt = prompt;
  if (state.pendingInject && state.conversation.turns.length > 1) {
    finalPrompt = composeInjectedPrompt(state.conversation.turns.slice(0, -1), prompt, state.settings.context_rounds);
    turn.injected = true;
    state.pendingInject = false;
  }

  try {
    const result = await call("generate", {
      prompt: finalPrompt,
      accountToken: acct.access_token,
      reference,
      textReply: state.settings.text_reply,
    });
    turn.status = "done";
    turn.image = result.image;
    turn.text = result.text || null;
    turn.path = result.path || null;
    loadAccounts(false);
  } catch (e) {
    turn.status = "error";
    turn.error = String(e && e.message ? e.message : e);
  } finally {
    state.busy = false;
    if (d) d.msgSig = "";
    persistConversation(true);
    render();
    syncSendBtn();
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
    section.appendChild(el("div", { class: "empty", html: "<strong>还没有账号</strong>在「号池管理」中导入账号。" }));
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

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast("已复制"), () => toast("复制失败", true));
}

/* ------------------------------------------------------------------ 导入 */

function renderImport(stage) {
  const page = el("div", { class: "page" });
  page.appendChild(el("h1", { class: "page-title", text: "高级导入" }));
  page.appendChild(el("p", { class: "page-sub", text: "批量导入账号。每行一个，格式为「邮箱密码凭据」，由后端解析。" }));
  const section = el("div", { class: "section" });
  const ta = el("textarea", { class: "input", style: "width:100%;min-height:180px;padding:12px;resize:vertical;font-family:monospace", placeholder: "每行一个账号凭据…" });
  section.appendChild(el("div", { style: "padding:16px 18px" }, [ta]));
  page.appendChild(section);
  stage.appendChild(page);
}

/* ------------------------------------------------------------------ 设置 */

function renderSettings(stage) {
  const page = el("div", { class: "page" });
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
    el("div", {}, [el("div", { class: "field-label", text: "启动时自动检查并更新" }), el("div", { class: "field-hint", text: "发现新版本时会在应用内自动下载并安装，完成后只需点一次重启。" })]),
    el("button", { class: "switch" + (state.settings.auto_check_update ? " on" : ""), role: "switch", onclick: () => saveSettings({ auto_check_update: !state.settings.auto_check_update }) }),
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

async function checkUpdate(manual) {
  try {
    const info = await call("check_update");
    state.update = info;
    renderRail();
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
    if (manual) toast(String(e && e.message ? e.message : e), true);
  }
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
  $("#avatarBtn").setAttribute("aria-expanded", "true");
}
function closeMenu() {
  $("#avatarMenu").hidden = true;
  $("#avatarBtn").setAttribute("aria-expanded", "false");
}

function bindChrome() {
  $("#avatarBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#avatarMenu").hidden ? openMenu() : closeMenu();
  });
  $("#logoBtn").addEventListener("click", () => newConversation());
  $("#versionBtn").addEventListener("click", () => checkUpdate(true));
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
    if (state.accountPopOpen) {
      state.accountPopOpen = false;
      render();
    }
  });
  document.addEventListener("click", (e) => {
    if (!$("#avatarMenu").hidden && !e.target.closest("#avatarMenu,#avatarBtn")) closeMenu();
  });
  tickTimer = setInterval(() => render(), 30000);
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
