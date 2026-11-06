// 发布前自检：确认工作流里的产物路径和真实布局一致，避免再出现
//「编译成功但收集不到文件」这种浪费一整轮构建的错误。
import fs from 'node:fs';

const wf = fs.readFileSync('.github/workflows/release.yml', 'utf8');
const pkg = fs.readFileSync('Cargo.toml', 'utf8');
const errors = [];

const isWorkspace = /^\[workspace\]/m.test(pkg);
const expectedTargetDir = isWorkspace ? './target' : './src-tauri/target';

if (isWorkspace) {
  if (/find src-tauri\/target/.test(wf)) {
    errors.push(`这是 workspace 工程，产物在 target/，工作流却去找 src-tauri/target/`);
  }
  if (!/find target /.test(wf)) {
    errors.push(`工作流里没有 find target 收集步骤`);
  }
  if (fs.existsSync('src-tauri/target')) {
    errors.push(`src-tauri/target 反而存在，布局和预期不符`);
  }
} else if (!/find src-tauri\/target/.test(wf)) {
  errors.push('非 workspace 工程，工作流应找 src-tauri/target/');
}

// concurrency 会把同组正在跑的 run 一起取消，发版流程里不要用
if (/^concurrency:/m.test(wf)) {
  errors.push('工作流里有 concurrency，取消单个 run 会误杀同组正在构建的 run');
}
if (/needs:\s*test/.test(wf)) {
  errors.push('build 不应 needs test：测试会拖慢出包');
}

const jobs = [...wf.matchAll(/^\s{2}([a-z][\w-]*):$/gm)].map(m => m[1]);
const expect = ['test', 'build', 'publish'];
for (const j of expect) if (!jobs.includes(j)) errors.push(`缺少 job: ${j}`);
// Linux 现在不出包；但 publish 用 ubuntu runner 是允许的，只检查 build matrix
const matrixBlock = wf.slice(wf.indexOf('matrix:'), wf.indexOf('runs-on: ${{ matrix.os }}'));
if (/linux/i.test(matrixBlock)) errors.push('build matrix 里还有 Linux，当前阶段不出 Linux 包');

if (errors.length) {
  console.error('发布自检失败：');
  for (const e of errors) console.error('  ✗ ' + e);
  console.error(`\n预期产物目录: ${expectedTargetDir}`);
  process.exit(1);
}
console.log(`发布自检通过（产物目录 ${expectedTargetDir}，${expect.length} 个 job）`);
