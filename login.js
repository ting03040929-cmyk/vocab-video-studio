// 登入 Claude Code CLI（只要做一次）
import { spawnSync } from 'node:child_process';
import { findClaude, cleanEnv } from './find.js';

const claude = findClaude();
console.log(`\n  使用：${claude}\n`);
if (claude === 'claude') {
  console.log('  找不到 Claude 程式。請確認 Claude 桌面版已安裝並至少開啟過一次 Code 分頁。\n');
  process.exit(1);
}
const opts = { stdio: 'inherit', env: cleanEnv(), shell: claude.endsWith('.cmd') };
const st = spawnSync(claude, ['auth', 'status', '--json'], { ...opts, stdio: 'pipe' });
let loggedIn = false;
try { loggedIn = JSON.parse(String(st.stdout)).loggedIn; } catch {}
if (loggedIn) {
  console.log('  ✔ 已經登入了，不用再登入。\n');
} else {
  console.log('  瀏覽器會開啟 Claude 登入頁，請用你的 Claude 帳號登入，完成後回到這個視窗。\n');
  spawnSync(claude, ['auth', 'login'], opts);
  console.log('');
  spawnSync(claude, ['auth', 'status', '--text'], opts);
}
