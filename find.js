// 尋找 Claude Code CLI 與 vocab-video skill。
// Claude 桌面版是 Microsoft Store (MSIX) 程式：它看到的 %APPDATA%\Claude 實際上存在
// %LOCALAPPDATA%\Packages\Claude_xxx\LocalCache\Roaming\Claude，一般終端機只看得到後者。
import fs from 'node:fs';
import path from 'node:path';

function subdirs(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(d, e.name)); } catch { return []; }
}
function newest(paths) {
  return paths.filter(p => fs.existsSync(p))
    .map(p => ({ p, t: fs.statSync(p).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.p || '';
}
// 所有可能的「Roaming\Claude」資料夾
function claudeDataDirs() {
  const dirs = [path.join(process.env.APPDATA || '', 'Claude')];
  const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  for (const d of subdirs(pk)) if (/^Claude_/i.test(path.basename(d))) dirs.push(path.join(d, 'LocalCache', 'Roaming', 'Claude'));
  return dirs;
}

export function findClaude(override = '') {
  if (override && fs.existsSync(override)) return override;
  const cands = claudeDataDirs().flatMap(d => subdirs(path.join(d, 'claude-code')).flatMap(subdirs)).map(d => path.join(d, 'claude.exe'));
  cands.push(path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe'));
  cands.push(path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'));
  return newest(cands) || 'claude';
}

export function findSkill(override = '') {
  if (override && fs.existsSync(path.join(override, 'SKILL.md'))) return override;
  const cands = claudeDataDirs()
    .flatMap(d => subdirs(path.join(d, 'local-agent-mode-sessions', 'skills-plugin')).flatMap(subdirs))
    .map(d => path.join(d, 'skills', 'vocab-video', 'SKILL.md'));
  cands.push(path.join(process.env.USERPROFILE || '', '.claude', 'skills', 'vocab-video', 'SKILL.md'));
  const f = newest(cands);
  return f ? path.dirname(f) : '';
}

// 子程序不要繼承「我在 Claude Code 裡面」的環境變數
export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}
