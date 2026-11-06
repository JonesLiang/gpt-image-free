/* =========================================================================
   GPT Image Free — 前端应用
   纯原生 JS，无构建步骤：ui/ 直接作为 Tauri 的 frontendDist。
   设计原则：首页干净、留白优先；所有次要功能收进左下角头像菜单。
   ========================================================================= */

const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || null;

/* ------------------------------------------------------------------ 工具 */

/** 毫秒差 → 「7 小时 23 分」这类中文倒计时。 */
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

/** UTC 时间戳 → 本地「今天 17:09」/「明天 09:30」/「11-08 02:00」。 */
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
  // 会话
  turns: [],
  boundToken: null,
  input: "",
  busy: false,
  error: null,
  // 首页画廊：生成过的图
  gallery: [],
  selected: new Set(),
};

let tickTimer = null;

/* ------------------------------------------------------------------ 账号 */

/** 排序：可用号按额度降序在前；限流/冻结一律沉底。 */
function sortedAccounts() {
  return state.accounts
    .slice()
    .sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      if (a.usable !== b.usable) return a.usable ? -1 : 1;
      return (b.quota || 0) - (a.quota || 0);
    });
}

function accountByToken(token) {
  return state.accounts.find((a) => a.access_token === token) || null;
}

/** 当前绑定账号：绑定失效时回退到「额度最多的可用号」。 */
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
  renderIfRoute("home");
  renderIfRoute("overview");
  renderIfRoute("pool");
  try {
    state.accounts = await call(force ? "refresh_accounts" : "list_accounts");
    state.online = true;
    if (!state.boundToken) {
      const best = pickBestAccount();
      if (best) state.boundToken = best.access_token;
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("后端未连接")) {
      state.online = false;
    } else {
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
  home: ["image", "首页"],
  overview: ["◔", "剩余额度"],
  pool: ["▤", "号池管理"],
  api: ["⌘", "API 接入"],
  import: ["↧", "高级导入"],
  settings: ["⚙", "设置"],
};

function setRoute(name) {
  state.route = name;
  closeMenu();
  render();
  const stage = $("#stage");
  if (stage) stage.scrollTop = 0;
}

function renderIfRoute(name) {
  if (state.route === name) render();
}

function render() {
  renderRail();
  const stage = $("#stage");
  if (!stage) return;
  stage.innerHTML = "";
  switch (state.route) {
    case "home":
      renderHome(stage);
      break;
    case "overview":
      renderOverview(stage);
      break;
    case "pool":
      renderPool(stage);
      break;
    case "api":
      renderApi(stage);
      break;
    case "import":
      renderImport(stage);
      break;
    case "settings":
      renderSettings(stage);
      break;
  }
}

function renderRail() {
  const nav = $("#railNav");
  if (!nav) return;
  nav.innerHTML = "";
  // 窄栏只放入口图标；具体功能都在头像菜单里，避免导航膨胀。
  for (const key of ["home"]) {
    const active = state.route === key;
    nav.appendChild(
      el("button", {
        class: "rail-btn" + (active ? " active" : ""),
        title: ROUTES[key][1],
        text: "◈",
        onclick: () => setRoute(key),
      })
    );
  }
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

/* ------------------------------------------------------------------ 首页 */

function renderHome(stage) {
  const wrap = el("div", { class: "chat" });

  // ---- 头部
  const head = el("div", { class: "page", style: "padding-bottom:0" });
  head.appendChild(el("h1", { class: "page-title", text: "图像" }));

  const tabs = el("div", { class: "gallery-tabs" }, [
    el("button", { class: "tab active", text: "热门" }),
    el("button", { class: "tab", text: "模板", disabled: "disabled", title: "即将推出" }),
  ]);
  head.appendChild(tabs);

  if (state.online === false) {
    head.appendChild(
      el("div", { class: "notice", html: "本机后端未启动，生图不可用。请先启动 chatgpt2api 服务后点击刷新。" })
    );
    const refresh = el("button", { class: "btn", text: "重新连接", onclick: () => loadAccounts(false) });
    head.lastChild.appendChild(refresh);
  }
  wrap.appendChild(head);

  // ---- 画廊
  const scroll = el("div", { class: "chat-scroll" });
  const inner = el("div", { class: "page", style: "padding-top:20px" });

  if (state.gallery.length === 0) {
    inner.appendChild(
      el("div", {
        class: "empty",
        html: "<strong>还没有生成过图片</strong>在下面的输入框里描述你想要的画面，第一张图会出现在这里。",
      })
    );
  } else {
    const grid = el("div", { class: "gallery" });
    state.gallery.forEach((g) => {
      grid.appendChild(
        el("div", { class: "tile", onclick: () => openLightbox(g.image) }, [
          el("img", { src: g.image, alt: g.prompt }),
          el("div", { class: "tile-label", text: g.prompt }),
        ])
      );
    });
    inner.appendChild(grid);
  }
  scroll.appendChild(inner);
  wrap.appendChild(scroll);

  // ---- 输入区
  wrap.appendChild(buildComposer());
  stage.appendChild(wrap);
}

/** Codex 式输入框：左侧 +、中间多行输入、右侧账号选择与发送。 */
function buildComposer() {
  const acct = activeAccount();
  const quota = acct ? acct.quota : 0;
  const dotClass = !acct ? "bad" : acct.blocked ? "warn" : "ok";

  const pill = el("button", { class: "model-pill", title: "选择账号", onclick: toggleAccountPop }, [
    el("span", { class: "dot " + dotClass }),
    el("span", { class: "name", text: acct ? acct.name : "无可用账号" }),
    el("span", { class: "acct-quota " + (quota <= 0 ? "zero" : quota <= 3 ? "low" : ""), text: String(quota) }),
  ]);

  const textarea = el("textarea", {
    placeholder: "描述你想生成的图像…",
    rows: "1",
  });
  textarea.value = state.input;
  textarea.addEventListener("input", () => {
    state.input = textarea.value;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
    sendBtn.disabled = !canSend();
  });
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      sendPrompt();
    }
  });

  const sendBtn = el("button", {
    class: "composer-send",
    title: "生成（⌘/Ctrl + Enter）",
    text: "↑",
    disabled: canSend() ? null : "disabled",
    onclick: sendPrompt,
  });

  const wrap = el("div", { class: "composer-wrap" });
  const composer = el("div", { class: "composer" }, [
    el("button", { class: "composer-plus", title: "上传参考图（暂未开放）", text: "+", disabled: "disabled" }),
    textarea,
    el("div", { class: "composer-right" }, [pill, sendBtn]),
  ]);
  wrap.appendChild(composer);

  // 账号下拉挂在这里，位置相对 wrap 固定
  if (state.accountPopOpen) wrap.appendChild(buildAccountPop());
  requestAnimationFrame(() => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
  });
  return wrap;
}

function canSend() {
  if (state.busy) return false;
  if (!state.input.trim()) return false;
  const acct = activeAccount();
  if (!acct || !acct.usable) return false;
  return true;
}

/** 账号下拉：展示名称 / 剩余额度 / 下次刷新；不可用的排到底部并置灰。 */
function buildAccountPop() {
  const pop = el("div", { class: "account-pop" });
  const active = activeAccount();
  const list = sortedAccounts();

  if (state.loadingAccounts && list.length === 0) {
    pop.appendChild(el("div", { class: "pop-title", text: "加载中…" }));
    return pop;
  }
  if (list.length === 0) {
    pop.appendChild(el("div", { class: "pop-title", text: "没有账号，请在头像菜单 → 号池管理中导入" }));
    return pop;
  }

  const usable = list.filter((a) => a.usable);
  const blocked = list.filter((a) => !a.usable);

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
      const row = el(
        "button",
        {
          class: "acct-row" + (a.access_token === state.boundToken ? " selected" : "") + (a.usable ? "" : " disabled"),
          disabled: a.usable ? null : "disabled",
          onclick: () => {
            state.boundToken = a.access_token;
            state.accountPopOpen = false;
            toast("已切换到 " + a.name);
            render();
          },
        },
        [
          el("div", { class: "acct-main" }, [el("div", { class: "acct-name", text: a.name }), meta]),
          el("div", {
            class: "acct-quota " + (a.quota <= 0 ? "zero" : a.quota <= 3 ? "low" : ""),
            text: String(a.quota),
          }),
        ]
      );
      pop.appendChild(row);
    });
  };

  addGroup("可用账号", usable);
  addGroup("不可用（限流 / 冻结）", blocked);
  return pop;
}

function toggleAccountPop() {
  state.accountPopOpen = !state.accountPopOpen;
  render();
}

/* ------------------------------------------------------------------ 生图 */

async function sendPrompt() {
  if (!canSend()) return;
  const acct = activeAccount();
  if (!acct) return toast("没有可用账号", true);

  const prompt = state.input.trim();
  state.input = "";
  state.busy = true;
  state.error = null;

  const turn = {
    id: "t" + Date.now(),
    prompt,
    status: "running",
    image: null,
    text: null,
    error: null,
    account: acct.name,
  };
  state.turns.push(turn);

  // 上一张成功的图作为参考图 → 走改图通道，保持画面连贯。
  const prev = lastDoneImage();
  const reference = prev ? stripDataUrl(prev.image) : null;

  // 换号后第一轮注入上下文：让新账号看到之前的内容。
  let finalPrompt = prompt;
  if (state.pendingInject && state.turns.length > 1) {
    finalPrompt = composeInjectedPrompt(state.turns.slice(0, -1), prompt, state.settings.context_rounds);
    turn.injected = true;
    state.pendingInject = false;
  }

  render();
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
    state.gallery.unshift({ image: result.image, prompt, at: Date.now() });
    // 额度变了，重新拉一次
    loadAccounts(false);
  } catch (e) {
    turn.status = "error";
    turn.error = String(e && e.message ? e.message : e);
  } finally {
    state.busy = false;
    render();
  }
}

function stripDataUrl(s) {
  const i = s.indexOf(",");
  return s.startsWith("data:") && i >= 0 ? s.slice(i + 1) : s;
}

function lastDoneImage() {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const t = state.turns[i];
    if (t.status === "done" && t.image) return t;
  }
  return null;
}

/** 换号时准备注入上下文。 */
function markPendingInject() {
  state.pendingInject = true;
}

/**
 * 上下文注入：带**真实轮次**编号，不能从 1 重新数，
 * 否则模型会把顺序理解错。
 */
function composeInjectedPrompt(turns, current, limit) {
  const n = Math.max(1, limit || 5);
  const kept = turns.slice(Math.max(0, turns.length - n));
  if (kept.length === 0) return current.trim();
  const start = turns.length - kept.length;
  const ctx = kept.map((t, i) => `第 ${start + i + 1} 轮：${t.prompt.trim()}`).join("\n");
  return `【这是一个续接的会话，之前的内容如下】\n${ctx}\n\n【本轮要求】\n${current.trim()}`;
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

  const bar = el("div", { class: "row", style: "margin-bottom:16px;gap:10px" }, [
    el("span", { class: "badge ok", text: `可用 ${usable.length} / ${state.accounts.length}` }),
    el("span", { class: "badge mute", text: `总额度 ${total} 张` }),
    el("span", { class: "spacer" }),
    el("button", {
      class: "btn",
      text: state.loadingAccounts ? "刷新中…" : "刷新额度",
      disabled: state.loadingAccounts ? "disabled" : null,
      onclick: () => loadAccounts(true),
    }),
    el("button", {
      class: "btn danger",
      text: "一键删除限流/冻结",
      onclick: () => deleteBlocked(),
    }),
  ]);
  page.appendChild(bar);

  const section = el("div", { class: "section" });
  if (state.accounts.length === 0) {
    section.appendChild(el("div", { class: "empty", html: "<strong>还没有账号</strong>在「号池管理」中导入账号。" }));
  } else {
    const table = el("table", { class: "table" });
    table.appendChild(
      el("tr", {}, [
        el("th", { text: "账号" }),
        el("th", { text: "状态" }),
        el("th", { text: "剩余额度" }),
        el("th", { text: "下次刷新" }),
        el("th", { text: "倒计时" }),
        el("th", { text: "" }),
      ])
    );
    sortedAccounts().forEach((a, idx) => {
      const badgeClass = a.blocked ? "bad" : a.quota <= 0 ? "warn" : "ok";
      const pct = Math.max(4, Math.min(100, Math.round((a.quota / 24) * 100)));
      const barColor = a.blocked || a.quota <= 0 ? "bad" : a.quota <= 3 ? "warn" : "";
      const row = el("tr", {}, [
        el("td", {}, [el("div", { style: "color:var(--text)", text: a.name }), el("div", { style: "font-size:11px;color:var(--text-faint)", text: a.email })]),
        el("td", {}, [el("span", { class: "badge " + badgeClass, text: a.status || "未知" })]),
        el("td", {}, [
          el("div", { class: "row", style: "gap:8px" }, [
            el("span", { class: "mono", style: "color:var(--text);min-width:24px", text: String(a.quota) }),
            el("div", { class: "bar" }, [el("i", { class: barColor, style: `width:${a.blocked ? 4 : pct}%` })]),
          ]),
        ]),
        el("td", { class: "mono", text: localWhen(a.reset_at, Date.now()) }),
        el("td", { class: "mono", style: a.reset_due ? "color:var(--ok)" : "", text: a.reset_due ? "已到期，可刷新" : humanize(a.reset_in_ms) }),
        el("td", {}, [
          el("button", {
            class: "btn",
            style: "height:24px;padding:0 8px;font-size:11.5px",
            text: "删除",
            onclick: async () => {
              try {
                await call("delete_accounts", { tokens: [a.access_token] });
                toast("已删除 " + a.name);
                loadAccounts(false);
              } catch (e) {
                toast(String(e), true);
              }
            },
          }),
        ]),
      ]);
      table.appendChild(row);
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
  } catch (e) {
    toast(String(e), true);
  }
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
      table.appendChild(
        el("tr", {}, [
          el("td", { style: "color:var(--text)", text: a.email }),
          el("td", { text: a.plan || "free" }),
          el("td", {}, [el("span", { class: "badge " + (a.blocked ? "bad" : "ok"), text: a.status })]),
          el("td", { class: "mono", text: String(a.quota) }),
          el("td", {}, [
            el("button", {
              class: "btn",
              style: "height:24px;padding:0 8px;font-size:11.5px",
              text: "删除",
              onclick: async () => {
                try {
                  await call("delete_accounts", { tokens: [a.access_token] });
                  toast("已删除 " + a.name);
                  loadAccounts(false);
                } catch (e) {
                  toast(String(e), true);
                }
              },
            }),
          ]),
        ])
      );
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
  section.appendChild(
    el("div", { class: "field" }, [
      el("div", {}, [el("div", { class: "field-label", text: "接口地址" }), el("div", { class: "field-hint", text: "填到第三方客户端的 Base URL，模型名填 gpt-image-2。" })]),
      el("button", { class: "btn", text: "复制", onclick: () => copy(base + "/v1") }),
    ])
  );
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

  section.appendChild(
    el("div", { class: "field" }, [
      el("div", {}, [
        el("div", { class: "field-label", text: "输出文字说明" }),
        el("div", { class: "field-hint", text: "开启后每轮会在图片之外再生成一段文字描述。生图模型本身只出图，文字由额外的文本请求补上，会多消耗一次额度。" }),
      ]),
      el("button", {
        class: "switch" + (state.settings.text_reply ? " on" : ""),
        role: "switch",
        "aria-checked": state.settings.text_reply ? "true" : "false",
        onclick: () => saveSettings({ text_reply: !state.settings.text_reply }),
      }),
    ])
  );

  section.appendChild(
    el("div", { class: "field" }, [
      el("div", {}, [el("div", { class: "field-label", text: "换号上下文轮数" }), el("div", { class: "field-hint", text: "换号后注入最近多少轮文字，编号保留真实轮次。" })]),
      el("input", {
        class: "input",
        type: "number",
        min: "1",
        max: "50",
        value: String(state.settings.context_rounds),
        onchange: (e) => saveSettings({ context_rounds: Number(e.target.value) || 5 }),
      }),
    ])
  );

  section.appendChild(
    el("div", { class: "field" }, [
      el("div", {}, [el("div", { class: "field-label", text: "启动时检查更新" })]),
      el("button", {
        class: "switch" + (state.settings.auto_check_update ? " on" : ""),
        role: "switch",
        onclick: () => saveSettings({ auto_check_update: !state.settings.auto_check_update }),
      }),
    ])
  );

  section.appendChild(
    el("div", { class: "field" }, [
      el("div", {}, [el("div", { class: "field-label", text: "图片保存目录" }), el("div", { class: "field-hint", text: state.imagesDir || "" })]),
      el("button", { class: "btn", text: "打开文件夹", onclick: () => call("reveal_images").catch((e) => toast(String(e), true)) }),
    ])
  );

  page.appendChild(section);

  const about = el("div", { class: "section", style: "margin-top:16px" });
  about.appendChild(
    el("div", { class: "field" }, [
      el("div", {}, [
        el("div", { class: "field-label", text: "当前版本 v" + state.version }),
        el("div", { class: "field-hint", text: state.update && state.update.has_update ? `发现新版本 v${state.update.latest}` : "已是最新版本" }),
      ]),
      el("button", {
        class: "btn",
        text: state.update && state.update.has_update ? "下载更新" : "检查更新",
        onclick: () => (state.update && state.update.has_update ? doDownload() : checkUpdate()),
      }),
    ])
  );
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

/* ------------------------------------------------------------------ 更新 */

async function checkUpdate() {
  try {
    const info = await call("check_update");
    state.update = info;
    renderRail();
    if (info.has_update) toast(`发现新版本 v${info.latest}`);
    else toast("已是最新版本");
  } catch (e) {
    toast(String(e && e.message ? e.message : e), true);
  }
}

async function doDownload() {
  const info = state.update;
  if (!info) return;
  const url = info.proxy_url || info.direct_url;
  if (!url) return toast("该版本没有可下载的安装包", true);
  toast("开始下载（走 gh-proxy 镜像）…");
  try {
    const path = await call("download_update", { url, version: info.latest });
    toast("已下载到 " + path);
  } catch (e) {
    toast(String(e && e.message ? e.message : e), true);
  }
}

/* ------------------------------------------------------------------ 浮层 */

function openLightbox(src) {
  const box = $("#lightbox");
  $("#lightboxImg").src = src;
  box.hidden = false;
}
function closeLightbox() {
  $("#lightbox").hidden = true;
  $("#lightboxImg").src = "";
}

function openMenu() {
  $("#avatarMenu").hidden = false;
  $("#avatarBtn").setAttribute("aria-expanded", "true");
}
function closeMenu() {
  $("#avatarMenu").hidden = true;
  $("#avatarBtn").setAttribute("aria-expanded", "false");
}

/* ------------------------------------------------------------------ 启动 */

function bindChrome() {
  $("#avatarBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("#avatarMenu").hidden;
    open ? openMenu() : closeMenu();
  });
  $("#logoBtn").addEventListener("click", () => setRoute("home"));
  $("#versionBtn").addEventListener("click", checkUpdate);
  $$("#avatarMenu .menu-item").forEach((b) =>
    b.addEventListener("click", () => setRoute(b.dataset.route))
  );
  $("#lightbox").addEventListener("click", closeLightbox);
  $("#lightboxClose").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeLightbox();
      closeMenu();
      if (state.accountPopOpen) {
        state.accountPopOpen = false;
        render();
      }
    }
  });
  document.addEventListener("click", (e) => {
    if (!$( "#avatarMenu").hidden && !e.target.closest("#avatarMenu,#avatarBtn")) closeMenu();
  });
  // 每 30 秒刷新倒计时
  tickTimer = setInterval(() => {
    if (state.route === "overview" || state.accountPopOpen) render();
  }, 30000);
}

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
    // 浏览器里预览时没有 Tauri，给个降级提示而不是白屏
    state.version = "0.0.0-preview";
  }
  render();
  await loadAccounts(false);
  if (state.settings.auto_check_update) checkUpdate();
}

boot();

/* 供测试使用：这些函数是纯函数，单独导出便于回归验证。 */
window.__gif = { humanize, localWhen, parseIsoUtc, composeInjectedPrompt, sortedAccounts };
