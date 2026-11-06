#!/usr/bin/env node
/* 前端纯函数测试：用 node 的 vm 加载 app.js 里的函数，不依赖 DOM。
   这些函数决定了额度倒计时、排序和上下文注入的正确性，必须有回归。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "ui/app.js"), "utf8");

// 只抽出纯函数区段执行，避免触碰 DOM。
function grab(name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, `找不到函数 ${name}`);
  // 从函数头开始，按大括号配对找到函数结尾
  let depth = 0, i = src.indexOf("{", start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return src.slice(start, end);
}

const code = ["humanize", "parseIsoUtc", "localWhen", "composeInjectedPrompt"]
  .map(grab)
  .join("\n");

const ctx = { console, Date, Math, Number, String, Object, Array, RegExp, JSON };
vm.createContext(ctx);
vm.runInContext(code + "\nthis.api={humanize,parseIsoUtc,localWhen,composeInjectedPrompt};", ctx);
const { humanize, parseIsoUtc, localWhen, composeInjectedPrompt } = ctx.api;

let n = 0;
const test = (name, fn) => {
  try {
    fn();
    n++;
    console.log("  ✓ " + name);
  } catch (e) {
    console.log("  ✗ " + name + "\n    " + e.message);
    process.exitCode = 1;
  }
};

console.log("倒计时格式化");
test("小时与分钟", () => {
  assert.equal(humanize((7 * 60 + 23) * 60000), "7 小时 23 分");
});
test("超过一天显示天", () => {
  assert.equal(humanize(26 * 3600 * 1000), "1 天 2 小时");
});
test("不足一分钟至少显示 1 分钟", () => {
  assert.equal(humanize(5000), "1 分钟");
});
test("已过期", () => {
  assert.equal(humanize(-1000), "已到期");
});
test("空值", () => {
  assert.equal(humanize(null), "—");
  assert.equal(humanize(undefined), "—");
});

console.log("时间解析");
test("无时区按 UTC 解析", () => {
  const t = parseIsoUtc("2026-11-06T09:09:41");
  assert.equal(t, Date.UTC(2026, 10, 6, 9, 9, 41));
});
test("上游带小数秒的格式也能解析", () => {
  // 上游实际会返回 "2026-11-06T09:09:41.61"，小数秒保留但在界面上不影响分钟级显示
  const t = parseIsoUtc("2026-11-06T09:09:41.61");
  assert.equal(Math.floor(t / 1000), Date.UTC(2026, 10, 6, 9, 9, 41) / 1000);
});
test("带 Z 的结果一致", () => {
  assert.equal(parseIsoUtc("2026-11-06T09:09:41Z"), parseIsoUtc("2026-11-06T09:09:41"));
});
test("非法输入返回 null", () => {
  assert.equal(parseIsoUtc(""), null);
  assert.equal(parseIsoUtc("nope"), null);
});

console.log("本地时间显示");
test("同一天显示今天+时分", () => {
  const now = new Date(2026, 10, 6, 20, 0).getTime();
  const iso = new Date(2026, 10, 6, 17, 9).toISOString().replace(/\.\d+Z$/, "");
  assert.equal(localWhen(iso, now), "今天 17:09");
});
test("次日显示明天", () => {
  const now = new Date(2026, 10, 6, 20, 0).getTime();
  const iso = new Date(2026, 10, 7, 9, 30).toISOString().replace(/\.\d+Z$/, "");
  assert.equal(localWhen(iso, now), "明天 09:30");
});

console.log("换号上下文注入");
test("无历史时不加前缀", () => {
  assert.equal(composeInjectedPrompt([], "画只猫", 5), "画只猫");
});
test("编号保留真实轮次，不从 1 重数", () => {
  const turns = ["a", "b", "c", "d", "e", "f", "g", "h"].map((p) => ({ prompt: p }));
  const out = composeInjectedPrompt(turns, "新要求", 3);
  assert.ok(!out.includes("第 1 轮："), "不应出现第 1 轮");
  assert.ok(out.includes("第 6 轮：f"), "应从第 6 轮开始");
  assert.ok(out.includes("第 8 轮：h"), "应到第 8 轮");
  assert.ok(out.endsWith("【本轮要求】\n新要求"));
});
test("标记续接会话", () => {
  const out = composeInjectedPrompt([{ prompt: "x" }], "y", 5);
  assert.ok(out.startsWith("【这是一个续接的会话"));
});

console.log(`\n${n} 个测试通过`);
