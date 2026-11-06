#!/usr/bin/env node
/* 提交前自检：不依赖任何第三方包。
   用法：node scripts/check.mjs */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { failed++; console.log("  ✗ " + m); };

function read(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

console.log("检查资源文件");
for (const f of [
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
  "src-tauri/build.rs",
  "src-tauri/capabilities/default.json",
  "src-tauri/src/lib.rs",
  "src-tauri/src/main.rs",
  "src-tauri/icons/icon.icns",
  "src-tauri/icons/icon.ico",
  "ui/index.html",
  "ui/styles.css",
  "ui/app.js",
]) {
  read(f) === null ? bad("缺少 " + f) : ok(f);
}

console.log("检查 JSON 合法性");
for (const f of ["src-tauri/tauri.conf.json", "src-tauri/capabilities/default.json"]) {
  const text = read(f);
  if (text === null) continue;
  try { JSON.parse(text); ok(f + " 可解析"); }
  catch (e) { bad(f + " 解析失败: " + e.message); }
}

console.log("检查 app.js 语法");
try {
  execFileSync(process.execPath, ["--check", join(root, "ui/app.js")], { stdio: "pipe" });
  ok("ui/app.js 语法正确");
} catch (e) {
  bad("ui/app.js 语法错误: " + (e.stderr || e.message));
}

console.log("检查前端与命令名对齐");
const app = read("ui/app.js") || "";
const lib = read("src-tauri/src/lib.rs") || "";
// 前端调用 call("xxx") 的命令都必须在 lib.rs 的 generate_handler 里注册
const called = new Set([...app.matchAll(/call\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
const registered = new Set([...lib.matchAll(/commands::([a-z_]+)/g)].map((m) => m[1]));
for (const c of called) {
  registered.has(c) ? ok("命令已注册: " + c) : bad("前端调用了未注册的命令: " + c);
}

console.log("检查 tauri.conf.json 前端目录");
const conf = JSON.parse(read("src-tauri/tauri.conf.json") || "{}");
const dist = conf.build && conf.build.frontendDist;
if (!dist) bad("frontendDist 未配置");
else existsSync(join(root, "src-tauri", dist)) ? ok("frontendDist 指向 " + dist) : bad("frontendDist 目录不存在: " + dist);

if (failed > 0) {
  console.error(`\n${failed} 项检查失败`);
  process.exit(1);
}
console.log("\n全部检查通过");
