// 語詞教學動畫工作台 — 本機網頁伺服器（零相依套件）
// 用 Claude Code CLI（claude -p）在背景執行 vocab-video skill，排隊、限制同時數量、
// 遇到用量上限自動暫停再續跑。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findClaude as _findClaude, findSkill as _findSkill, cleanEnv } from './find.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(ROOT, '..');            // 115難語詞語音（WAV 放這裡）
const OUT = path.join(BASE, 'out');
const DONE = path.join(OUT, '已完成');            // 成品（影片、旁白稿）
const WIP = path.join(OUT, '製作中');             // 正在做的語詞的工作資料夾
const TEMP = path.join(OUT, '暫存');              // 做完後的工作資料夾（腳本留著做配音版／修改）
const FONTS = path.join(ROOT, 'fonts');
const DATA = path.join(ROOT, 'data');
const LOGS = path.join(DATA, 'logs');
const JOBS_FILE = path.join(DATA, 'jobs.json');
const CONFIG_FILE = path.join(DATA, 'config.json');
const ENV_FILE = path.join(ROOT, '.env');
try { process.loadEnvFile(ENV_FILE); } catch {}     // GEMINI_API_KEY 等設定
// 金鑰格式有好幾種（AIza…、AQ.…），只擋明顯不是金鑰的：中文、空白、太短
const KEY_RE = /^[\x21-\x7e]{20,}$/;
const PORT = Number(process.env.PORT) || 5577;

for (const d of [DONE, WIP, TEMP, DATA, LOGS]) fs.mkdirSync(d, { recursive: true });

// out 根目錄裡的成品（舊檔或 skill 自己存的）一律收進「已完成」
function tidyOut() {
  let files = [];
  try { files = fs.readdirSync(OUT, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name); } catch {}
  for (const f of files) {
    if (!/\.(mp4|txt)$/i.test(f)) continue;
    try { fs.renameSync(path.join(OUT, f), path.join(DONE, f)); } catch {}
  }
}
tidyOut();

// 搬移整個資料夾（Windows 檔案被占用時稍後重試；目的地已存在就合併）
function moveDir(from, to, tries = 6) {
  if (!fs.existsSync(from)) return;
  try {
    if (fs.existsSync(to)) { fs.cpSync(from, to, { recursive: true, force: true }); fs.rmSync(from, { recursive: true, force: true }); }
    else fs.renameSync(from, to);
  } catch (e) {
    if (tries > 0) setTimeout(() => moveDir(from, to, tries - 1), 2000);
    else console.log(`  無法搬移 ${from}：${e.message}`);
  }
}

const STYLES = ['剪紙Q版人物', '積木人偶風', '漫畫分格風'];
const DEFAULT_CONFIG = {
  concurrency: 1,          // 同時執行幾個任務
  model: 'sonnet',         // sonnet 較省；opus 品質較好但用量多
  retryMinutes: 30,        // 碰到用量上限後幾分鐘自動重試
  maxBudgetUsd: 0,         // 每個任務花費上限（0 = 不限；訂閱制可不設）
  claudePath: '',          // 留空 = 自動尋找
  skillDir: '',            // 留空 = 自動尋找
  ttsModel: 'gemini-3.8-flash-tts',
  ttsModels: [],           // 這把金鑰可用的語音模型（按「儲存並測試」時更新）
  ttsVoice: 'auto',        // auto = 每個語詞依故事自動挑聲音
  autoVoice: true,         // 無聲版完成後自動產生語音 → 做配音版
};
// [名稱, 網頁上的說明, 給自動挑選看的特色]
const VOICES = [
  ['Sulafat', '女・溫暖柔和', 'female, warm, storyteller'],
  ['Vindemiatrix', '女・溫和', 'female, gentle, calm'],
  ['Achernar', '女・輕柔', 'female, soft, soothing'],
  ['Aoede', '女・清新輕快', 'female, breezy, friendly teacher'],
  ['Leda', '女・年輕', 'female, youthful, like an older sister'],
  ['Laomedeia', '女・開朗', 'female, upbeat, cheerful'],
  ['Gacrux', '女・成熟', 'female, mature, like a grandmother or mother'],
  ['Puck', '男・活潑', 'male, upbeat, lively, like an older brother'],
  ['Achird', '男・友善', 'male, friendly, warm'],
  ['Iapetus', '男・清晰', 'male, clear, steady teacher'],
  ['Sadaltager', '男・知性', 'male, knowledgeable, calm'],
  ['Charon', '男・穩重', 'male, informative, like a father or grandfather'],
];
const isVoice = v => v === 'auto' || VOICES.some(x => x[0] === v);
const DEFAULT_TTS_STYLE = '用台灣國語，語氣溫柔、親切，速度放慢，像國中特教老師在對學生說話，每句話之間稍微停頓。';

// ---------- 狀態 ----------
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
let config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
// 舊版把金鑰存在 config.json：搬到 .env
if (config.geminiKey) {
  if (!process.env.GEMINI_API_KEY && KEY_RE.test(config.geminiKey)) saveEnvKey(config.geminiKey);
  delete config.geminiKey;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 1));
}
function saveEnvKey(key) {
  const head = '# Gemini API 金鑰（https://aistudio.google.com/apikey）。這個檔案不會進 git，不要分享給別人。\n';
  let t = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : head;
  const line = `GEMINI_API_KEY=${key}`;
  t = /^GEMINI_API_KEY=.*$/m.test(t) ? t.replace(/^GEMINI_API_KEY=.*$/m, line) : t.replace(/\n?$/, `\n${line}\n`);
  fs.writeFileSync(ENV_FILE, t);
  process.env.GEMINI_API_KEY = key;
}
const geminiKey = () => { const k = (process.env.GEMINI_API_KEY || '').trim(); return KEY_RE.test(k) ? k : ''; };
let jobs = readJson(JOBS_FILE, []);
let paused = false;
let limitUntil = 0;        // 用量上限：此時間前不啟動新任務
let loginState = { checked: false, ok: false, message: '尚未檢查' };
const procs = new Map();   // jobId -> child process

// 黑視窗被關掉後重開：上次跑到一半的任務
// 1. 若舊的 claude 程式還活著就先結束它（避免同一個詞做兩份、重複花用量）
// 2. 重新排隊，並標記「接續上次的對話」而不是從頭做
// 只認「本工作台啟動的」claude（命令列含本專案 fonts 路徑），絕不誤殺 Claude 桌面版
function isClaudePid(pid) {
  if (!pid) return false;
  try {
    const cmd = execFileSync('powershell', ['-NoProfile', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
      { encoding: 'utf8', windowsHide: true });
    return /claude/i.test(cmd) && cmd.includes(FONTS) && cmd.includes('stream-json');
  } catch { return false; }
}
for (const j of jobs) if (j.status === 'running') {
  if (isClaudePid(j.pid)) { try { execFileSync('taskkill', ['/PID', String(j.pid), '/T', '/F'], { windowsHide: true }); } catch {} }
  j.status = 'queued';
  j.resume = !!j.sessionId;
  j.note = j.resume ? '上次被中斷，會從中斷的地方接著做' : '上次被中斷，重新排隊';
}

let saveTimer = null;
function saveJobs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 1)), 300);
}
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 1));

// ---------- 找 claude 與 skill ----------
const findClaude = () => _findClaude(config.claudePath);
const findSkill = () => _findSkill(config.skillDir);

// ---------- 掃描成品與錄音 ----------
const VIDEO_RE = /^(.+?)_教學動畫_(.+?)(_配音版)?\.mp4$/;
function scanLibrary() {
  const lib = {};
  const get = w => (lib[w] ||= { word: w, silent: null, voiced: null, style: null, narration: null, wav: null });
  let outFiles = [];
  try { outFiles = fs.readdirSync(DONE); } catch {}
  for (const f of outFiles) {
    const m = f.match(VIDEO_RE);
    if (m) {
      const e = get(m[1]);
      const st = fs.statSync(path.join(DONE, f));
      const info = { file: f, size: st.size, mtime: st.mtimeMs };
      if (m[3]) e.voiced = info; else { e.silent = info; e.style = m[2]; }
      if (!e.style) e.style = m[2];
    } else if (f.endsWith('_旁白.txt')) {
      get(f.slice(0, -'_旁白.txt'.length)).narration = f;
    }
  }
  const wavs = listWavs();
  for (const w of Object.keys(lib)) lib[w].wav = matchWav(w, wavs);
  return { lib: Object.values(lib).sort((a, b) => (b.silent?.mtime || 0) - (a.silent?.mtime || 0)), wavs };
}
function listWavs() {
  try { return fs.readdirSync(BASE).filter(f => /\.(wav|mp3)$/i.test(f)); } catch { return []; }
}
function wavWord(f) {
  return f.replace(/\.(wav|mp3)$/i, '').replace(/_語音朗讀$/, '').replace(/^今天我們要學的語詞是/, '');
}
function matchWav(word, wavs = listWavs()) {
  return wavs.find(f => wavWord(f) === word) || null;
}

// ---------- 提示詞 ----------
function promptFor(job, skillDir) {
  const W = path.join(WIP, job.word);
  const common = `
環境說明（以下優先於 SKILL.md 裡的雲端路徑）：
- 這是老師 Windows 電腦上的「無人值守」背景任務。沒有人能回答問題：不要用 AskUserQuestion，不要等待回覆。SendUserFile、present_files、device_commit_files、get_device_info 都不需要。
- 用 Bash（Git Bash）或 PowerShell 執行指令；Python 指令是 \`python\`（不是 python3）；不用加 \`timeout\`，渲染很久也沒關係（Bash 工具的 timeout 參數設到最大 600000）。若渲染超過 10 分鐘，用背景執行並等待輸出檔完成。
- skill 資料夾：${skillDir}（scripts、examples、references 都在裡面；sys.path.insert 用正斜線絕對路徑，例如 '${skillDir.replace(/\\/g, '/')}/scripts'）
- 工作資料夾（取代 /home/claude）：${W}（也就是目前 cwd）
- 字型已經下載好，不要再 git clone：_IANSUI = '${path.join(FONTS, 'Iansui-Regular.ttf').replace(/\\/g, '/')}'，_BPMF = '${path.join(FONTS, 'BpmfIansui-Regular.ttf').replace(/\\/g, '/')}'
- 成品資料夾（取代 /mnt/user-data/outputs 與 SKILL.md 說的 out 資料夾）：${DONE}
  這裡只放最終影片與文字檔；out 根目錄不要放任何東西；預覽圖、中間檔都留在工作資料夾。
  先渲染到工作資料夾、確認可解碼，再複製到成品資料夾。
節省用量：
- 只有在不確定意思或讀音（尤其破音字）時才上網查，最多 2 次。
- 範例只讀最接近的一個；paperkit.py / comickit.py 用 grep 找需要的函式與 docstring，不要整份反覆讀。
- preview 檢查最多 3 輪就渲染。不要寫長篇說明。
- 結束時最後一則回覆格式：第一行「DONE: <mp4 完整路徑>」，接著最多 5 行重點；失敗則第一行「FAILED: 原因」。`;

  if (job.type === 'voiced') {
    return `請用 vocab-video skill 的第 6 步，為語詞「${job.word}」製作配音版。
先讀 ${path.join(skillDir, 'SKILL.md')} 與 references/pedagogy_and_narration.md。
- 無聲版：${path.join(DONE, `${job.word}_教學動畫_${job.style}.mp4`)}
- 場景腳本：在 ${W} 裡的 .py（若找不到，依旁白稿與無聲版重新寫一份相同故事的腳本）
- 旁白稿：${path.join(DONE, `${job.word}_旁白.txt`)}（若不存在，以腳本中的 SUBS 為準）
- 老師的旁白錄音：${path.join(BASE, job.wav)}（先複製到工作資料夾再用）
- 輸出：${path.join(DONE, `${job.word}_教學動畫_${job.style}_配音版.mp4`)}
對齊後在 ${path.join(DONE, `${job.word}_配音說明.txt`)} 寫幾行：哪一句對到哪一段、提醒老師對齊是依停頓推算、請檢查同步與讀音。
${common}`;
  }
  return `請用 vocab-video skill 製作語詞教學動畫（無聲版）。
語詞：${job.word}
風格：${job.style}（老師已經在網頁選好，不要再詢問）
${job.note2 ? `老師的補充要求：${job.note2}\n` : ''}
先讀 ${path.join(skillDir, 'SKILL.md')}，以及它提到的 references（styles.md、pedagogy_and_narration.md），然後照流程第 1–5 步做。
- 輸出影片：${path.join(DONE, `${job.word}_教學動畫_${job.style}.mp4`)}
- 第 5 步要給老師的內容（故事分段與時間、旁白稿逐句、Gemini 風格提示、要注意的破音字）寫成 UTF-8 文字檔：${path.join(DONE, `${job.word}_旁白.txt`)}
  這個檔案會被程式自動讀取來產生語音，格式必須是：第一行「【旁白稿】」，下面每行一句、以「1. 」「2. 」編號，和字幕一字不差（不要加注音或括號說明）；空一行後是「【Gemini 風格提示】」與一行提示；其餘內容（故事分段、破音字）放在後面。
- 角色請和別的語詞不一樣（可看成品資料夾裡其他 _旁白.txt 的角色名，避免重複）。
${common}`;
}

// ---------- Gemini 語音 ----------
// 從旁白稿取出逐句旁白與風格提示。新格式以【旁白稿】開頭；舊檔可能是純句子或【旁白稿（逐句…）】區段。
function parseNarration(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map(s => s.trim());
  const isHead = s => /^【/.test(s) || /^[─—-]{4,}/.test(s);
  const section = re => {
    const i = lines.findIndex(s => re.test(s));
    if (i < 0) return null;
    const out = [];
    for (const s of lines.slice(i + 1)) { if (isHead(s)) break; if (s) out.push(s); }
    return out;
  };
  let sents = section(/^【旁白稿/);
  if (sents) sents = sents.filter(s => /^\d+\s*[.、．]/.test(s));
  else {
    sents = [];
    for (const s of lines) { if (isHead(s) || /\.mp4/.test(s)) break; if (s) sents.push(s); }
  }
  sents = sents.map(s => s.replace(/^\d+\s*[.、．]\s*/, ''));
  const style = (section(/^【Gemini/) || []).join('') || DEFAULT_TTS_STYLE;
  return { sentences: sents, style };
}
function readNarration(word) {
  const f = path.join(DONE, `${word}_旁白.txt`);
  return fs.existsSync(f) ? parseNarration(fs.readFileSync(f, 'utf8')) : null;
}

function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 風格提示怎麼給：2.x 會把句首的中文提示當成指示；3.x 會把中文提示照唸出來，
// 只認句首的英文 [標籤]（不支援 systemInstruction）。實測 2026-10：英文標籤不會被唸出、會放慢語速。
const DEFAULT_TTS_TAG = 'Speak in Taiwanese Mandarin, gently and warmly, slowly, like a special-education teacher talking to junior-high students, with a short pause between sentences';
const tagCache = new Map([[DEFAULT_TTS_STYLE, DEFAULT_TTS_TAG]]);
async function styleToTag(style) {
  if (!/[㐀-鿿]/.test(style)) return style.replace(/^\[|\]$/g, '');
  if (tagCache.has(style)) return tagCache.get(style);
  try {
    const r = await fetch(`${GEMINI}/models/gemini-2.5-flash:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
      body: JSON.stringify({ contents: [{ parts: [{ text: `把下面的朗讀風格要求翻成一句英文，給語音模型當作語氣指示。只輸出那句英文，不要引號或括號。\n\n${style}` }] }] }),
      signal: AbortSignal.timeout(30000),
    });
    const t = (await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim().replace(/[\[\]"\n]/g, ' ');
    if (t) { tagCache.set(style, t); return t; }
  } catch {}
  return DEFAULT_TTS_TAG;
}
// 自動挑聲音：讓 Gemini 文字模型讀故事，從 VOICES 選一個最適合當旁白的
async function pickVoice(word, sentences) {
  const list = VOICES.map(([v, , d]) => `${v}: ${d}`).join('\n');
  const r = await fetch(`${GEMINI}/models/gemini-2.5-flash:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `這是給國中特教班學生看的語詞教學短片「${word}」的旁白。請從下面的聲音裡，挑一個最適合當這支短片旁白的聲音。
考量故事的主角（男生／女生、小孩／大人／長輩）、氣氛（輕鬆、溫馨、緊張、安靜），旁白要清楚、親切、適合學生聽。

旁白：
${sentences.join('\n')}

可選的聲音：
${list}

只輸出 JSON：{"voice": "聲音名稱", "reason": "一句中文理由"}` }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const t = (await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  const j = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || '{}');
  const v = VOICES.find(x => x[0].toLowerCase() === String(j.voice || '').toLowerCase());
  if (!v) throw new Error(`沒有挑到可用的聲音：${t.slice(0, 100)}`);
  return { voice: v[0], reason: j.reason || '' };
}

const modelVersion = m => Number(m.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
async function ttsText(style, sentences) {
  if (modelVersion(config.ttsModel) >= 3) return `[${await styleToTag(style)}] ${sentences.join('\n')}`;
  return `${style}\n請朗讀以下內容：\n\n${sentences.join('\n')}`;
}

async function geminiTts(style, sentences, voice, log = () => {}) {
  const text = await ttsText(style, sentences);
  log(`送出：${text.replace(/\n/g, ' ⏎ ')}`);
  let r, body;
  // 503（模型忙碌）與每分鐘次數上限的 429 等一下再試；每日額度用完的 429 重試也沒用，最後會失敗
  for (let i = 0; i < 4; i++) {
    r = await fetch(`${GEMINI}/models/${config.ttsModel}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
      signal: AbortSignal.timeout(180000),
    });
    body = await r.json().catch(() => ({}));
    if (r.ok || ![429, 500, 503].includes(r.status) || i === 3) break;
    log(`Gemini 回應 ${r.status}，${30 * (i + 1)} 秒後重試`);
    await sleep(30000 * (i + 1));
  }
  if (!r.ok && r.status === 400 && /voice/i.test(body.error?.message || '') && voice !== 'Sulafat') {
    log(`這個模型不支援聲音 ${voice}，改用 Sulafat`);
    return geminiTts(style, sentences, 'Sulafat', log);
  }
  if (!r.ok) {
    const msg = body.error?.message || `HTTP ${r.status}`;
    const e = new Error(r.status === 429 ? `Gemini 用量已達上限（429）：${msg}` : r.status === 400 || r.status === 403 ? `金鑰或模型有問題（${r.status}）：${msg}` : msg);
    e.status = r.status; throw e;
  }
  const part = body.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  if (!part) throw new Error('Gemini 沒有回傳音訊（可能是文字被擋下或模型不支援語音）');
  const data = Buffer.from(part.inlineData.data, 'base64');
  // 2.5 回傳裸 PCM（audio/L16;rate=24000）；3.x 直接回傳完整的 WAV 檔
  if (data.subarray(0, 4).toString() === 'RIFF') return data;
  const rate = Number(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1]) || 24000;
  return pcmToWav(data, rate);
}
const wavSeconds = wav => (wav.length - 44) / (wav.readUInt32LE(28) || 48000);

// 產生語音任務：寫成 115難語詞語音\<語詞>_語音朗讀.wav（舊檔先移到「舊錄音」資料夾），完成後可接著排配音版
async function startTts(job) {
  Object.assign(job, { status: 'running', startedAt: Date.now(), endedAt: null, error: null, attempts: (job.attempts || 0) + 1,
    activity: `🎙 Gemini 產生語音中（${job.voice}）…` });
  logLine(job, `=== 產生語音（第 ${job.attempts} 次），${config.ttsModel}，聲音 ${job.voice}`);
  saveJobs();
  try {
    if (!geminiKey()) throw new Error('還沒有設定 Gemini API 金鑰（在「Gemini 語音」設定裡貼上）');
    let { style, sentences } = job;
    if (!sentences?.length) {
      const n = readNarration(job.word);
      if (!n?.sentences.length) throw new Error(`找不到可用的旁白稿：${job.word}_旁白.txt`);
      ({ style, sentences } = n);
    }
    if (job.voice === 'auto') {
      job.activity = '🎙 依故事挑選聲音…'; saveJobs();
      try {
        const p = await pickVoice(job.word, sentences);
        job.voice = p.voice; job.voiceReason = p.reason;
        logLine(job, `自動挑選聲音：${p.voice}（${p.reason}）`);
      } catch (e) {
        job.voice = 'Sulafat';
        logLine(job, `自動挑選聲音失敗，改用 Sulafat：${e.message}`);
      }
      job.activity = `🎙 Gemini 產生語音中（${job.voice}）…`; saveJobs();
    }
    logLine(job, `風格：${style}`);
    logLine(job, sentences.join(' ⏎ '));
    const wav = await geminiTts(style || DEFAULT_TTS_STYLE, sentences, job.voice, t => logLine(job, t));
    if (job.status === 'canceled') return;
    const file = `${job.word}_語音朗讀.wav`;
    const dest = path.join(BASE, file);
    const old = matchWav(job.word);
    if (old) {
      const bak = path.join(BASE, '舊錄音');
      fs.mkdirSync(bak, { recursive: true });
      fs.renameSync(path.join(BASE, old), path.join(bak, old.replace(/(\.\w+)$/, `_${Date.now().toString(36)}$1`)));
    }
    fs.writeFileSync(dest, wav);
    const sec = wavSeconds(wav);
    Object.assign(job, { status: 'done', endedAt: Date.now(), wav: file, activity: `完成（${sec.toFixed(1)} 秒）` });
    logLine(job, `=== 完成：${file}，${sec.toFixed(1)} 秒`);
    if (job.chain) queueVoiced(job.word, job.model);
  } catch (e) {
    if (job.status === 'canceled') return;
    Object.assign(job, { status: 'failed', endedAt: Date.now(), error: String(e.message || e) });
    logLine(job, `=== 失敗：${job.error}`);
  }
  saveJobs();
}

function newJob(fields) {
  const job = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: 'queued', createdAt: Date.now(), model: config.model, ...fields };
  jobs.push(job);
  return job;
}
const isActive = (word, type) => jobs.some(j => j.word === word && j.type === type && ['queued', 'running'].includes(j.status));
function queueTts(word, opts = {}) {
  if (isActive(word, 'tts')) return null;
  const e = scanLibrary().lib.find(x => x.word === word);
  return newJob({ word, type: 'tts', videoStyle: e?.style || STYLES[0], voice: opts.voice || config.ttsVoice,
    style: opts.style || '', sentences: opts.sentences || null, chain: opts.chain !== false, model: opts.model || config.model });
}
function queueVoiced(word, model) {
  if (isActive(word, 'voiced')) return null;
  const e = scanLibrary().lib.find(x => x.word === word);
  const wav = matchWav(word);
  if (!e?.silent || !wav) return null;
  return newJob({ word, type: 'voiced', style: e.style, wav, model: model || config.model });
}

// ---------- 執行任務 ----------
const LIMIT_RE = /usage limit|rate.?limit|limit reached|hit your limit|reset(s)? at|quota|overloaded|\b429\b|\b529\b/i;

function logLine(job, line) {
  fs.appendFile(path.join(LOGS, `${job.id}.log`), `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${line}\n`, () => {});
}

function startJob(job) {
  const skillDir = findSkill();
  const claude = findClaude();
  if (!skillDir) { job.status = 'failed'; job.error = '找不到 vocab-video skill（可在設定填 skillDir）'; saveJobs(); return; }
  const cwd = path.join(WIP, job.word);
  moveDir(path.join(TEMP, job.word), cwd);   // 之前做過：把腳本搬回製作中
  fs.mkdirSync(cwd, { recursive: true });

  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--model', job.model || config.model,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash,PowerShell,WebSearch,WebFetch,TodoWrite',
    '--disallowedTools', 'AskUserQuestion',
    '--add-dir', skillDir, OUT, BASE, FONTS];
  if (config.maxBudgetUsd > 0) args.push('--max-budget-usd', String(config.maxBudgetUsd));
  // 被中斷（關視窗、用量上限）的任務：接續上次的對話，不用從頭做
  const resuming = !!(job.resume && job.sessionId);
  if (resuming) args.push('--resume', job.sessionId);
  const prompt = resuming
    ? `剛才任務被中斷了（工作台被關閉或碰到用量上限）。請先看工作資料夾 ${cwd} 和成品資料夾 ${DONE} 目前的進度，從中斷的地方接著做完，不要從頭重做。完成後照原本的格式回覆（DONE: … 或 FAILED: …）。`
    : promptFor(job, skillDir);
  job.resume = false;

  const env = cleanEnv();

  Object.assign(job, { status: 'running', startedAt: Date.now(), endedAt: null, error: null, activity: '啟動中…',
    turns: 0, outTokens: 0, costBase: resuming ? (job.costUsd || 0) : 0, costUsd: resuming ? (job.costUsd || 0) : 0,
    attempts: (job.attempts || 0) + 1 });
  logLine(job, `=== ${resuming ? '接續' : '開始'}（第 ${job.attempts} 次），模型 ${job.model}，${claude}`);
  saveJobs();

  const child = spawn(claude, args, { cwd, env, windowsHide: true, shell: claude.endsWith('.cmd') });
  procs.set(job.id, child);
  job.pid = child.pid;
  child.stdin.end(prompt);

  const raw = fs.createWriteStream(path.join(LOGS, `${job.id}.jsonl`), { flags: 'a' });
  let buf = '', stderr = '', result = null;
  child.stdout.on('data', chunk => {
    raw.write(chunk);
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      handleEvent(job, ev, r => { result = r; });
    }
  });
  child.stderr.on('data', c => { stderr += c.toString('utf8'); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  child.on('error', err => { stderr += String(err); });
  child.on('close', code => {
    raw.end();
    procs.delete(job.id);
    moveDir(cwd, path.join(TEMP, job.word));   // 工作資料夾收進暫存
    tidyOut();
    job.endedAt = Date.now();
    if (job.status === 'canceled') { logLine(job, '=== 已取消'); saveJobs(); return; }
    const text = (result?.result || '') + '\n' + stderr;
    if (result) {
      job.costUsd = (job.costBase || 0) + (result.total_cost_usd || 0);
      const u = result.usage || {};
      job.usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
      job.result = (result.result || '').slice(0, 4000);
    }
    if (/Not logged in|\/login|authentication/i.test(text) && !(result && !result.is_error)) {
      job.status = 'queued'; job.note = '尚未登入 Claude，已暫停佇列';
      paused = true; loginState = { checked: true, ok: false, message: '尚未登入：請執行「登入Claude.bat」' };
    } else if ((result?.is_error || code !== 0) && LIMIT_RE.test(text)) {
      job.status = 'queued'; job.note = '碰到用量上限，稍後從中斷處接著做';
      job.resume = !!job.sessionId;
      limitUntil = Date.now() + config.retryMinutes * 60000;
      logLine(job, `=== 用量上限，${config.retryMinutes} 分鐘後重試`);
    } else if (result && !result.is_error && /^\s*DONE:/m.test(result.result || '')) {
      job.status = 'done'; job.activity = '完成';
    } else if (result && !result.is_error && !/FAILED:/.test(result.result || '')) {
      job.status = 'done'; job.activity = '完成（請確認成品）';
    } else {
      job.status = 'failed';
      job.error = ((result?.result || '') || stderr || `結束代碼 ${code}`).slice(0, 1500);
    }
    logLine(job, `=== 結束：${job.status}  US$${(job.costUsd || 0).toFixed(2)}`);
    // 無聲版完成 → 自動用 Gemini 產生語音，再接著做配音版
    if (job.status === 'done' && job.type === 'silent' && config.autoVoice && geminiKey()) {
      if (queueTts(job.word, { model: job.model })) logLine(job, '=== 已排入：產生語音 → 配音版');
    }
    saveJobs();
  });
}

function handleEvent(job, ev, setResult) {
  if (ev.type === 'system' && ev.subtype === 'init') { job.sessionId = ev.session_id; saveJobs(); return; }
  if (ev.type === 'assistant' && ev.message) {
    job.turns++;
    job.outTokens += ev.message.usage?.output_tokens || 0;
    for (const c of ev.message.content || []) {
      if (c.type === 'text' && c.text.trim()) { job.activity = '💬 ' + c.text.trim().slice(0, 200); logLine(job, job.activity); }
      if (c.type === 'tool_use') {
        const inp = c.input || {};
        const desc = inp.description || inp.command || inp.file_path || inp.pattern || inp.query || inp.url || '';
        job.activity = `🔧 ${c.name}：${String(desc).slice(0, 160)}`;
        logLine(job, job.activity);
      }
    }
    saveJobs();
    return;
  }
  if (ev.type === 'result') { setResult(ev); }
}

function cancelJob(job) {
  const p = procs.get(job.id);
  job.status = 'canceled'; job.endedAt = Date.now();
  if (p) execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], () => {});
  saveJobs();
}

// ---------- 排程 ----------
function tick() {
  if (paused) return;
  // 產生語音不用 Claude 用量：一次一個，不受同時數量與 Claude 用量上限限制
  if (!jobs.some(j => j.type === 'tts' && j.status === 'running')) {
    const t = jobs.find(j => j.type === 'tts' && j.status === 'queued' && !isActive(j.word, 'silent'));
    if (t) startTts(t);
  }
  if (Date.now() < limitUntil) return;
  const running = jobs.filter(j => j.status === 'running' && j.type !== 'tts');
  if (running.length >= config.concurrency) return;
  const busyWords = new Set(running.map(j => j.word));
  const next = jobs.find(j => j.status === 'queued' && j.type !== 'tts' && !busyWords.has(j.word)
    // 配音版要等同一個詞的無聲版與語音完成
    && !(j.type === 'voiced' && (isActive(j.word, 'silent') || isActive(j.word, 'tts'))));
  if (next) startJob(next);
}
setInterval(tick, 2000);

function checkLogin() {
  return new Promise(resolve => {
    const env = cleanEnv();
    const claude = findClaude();
    // auth status 不花用量
    execFile(claude, ['auth', 'status', '--json'],
      { env, timeout: 30000, windowsHide: true, shell: claude.endsWith('.cmd') }, (err, stdout) => {
        let r = null; try { r = JSON.parse(stdout); } catch {}
        if (r?.loggedIn) loginState = { checked: true, ok: true, message: `已登入（${r.authMethod}）` };
        else loginState = { checked: true, ok: false, message: r ? '尚未登入' : String(err?.message || '無法執行 claude') };
        resolve(loginState);
      });
  });
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
}
function serveFile(req, res, file) {
  if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
}
// 只允許讀資料夾內的檔名，防止 ../ 跳出
const safeIn = (dir, name) => { const p = path.resolve(dir, name); return p.startsWith(dir + path.sep) ? p : null; };

function parseWords(text) {
  return [...new Set(String(text || '').split(/[\s,，、;；\n]+/).map(s => s.trim()).filter(Boolean))];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(req, res, path.join(ROOT, 'public', 'index.html'));
    if (req.method === 'GET' && p.startsWith('/out/')) { const f = safeIn(DONE, p.slice(5)); return f ? serveFile(req, res, f) : send(res, 400, {}); }
    if (req.method === 'GET' && p.startsWith('/wav/')) { const f = safeIn(BASE, p.slice(5)); return f ? serveFile(req, res, f) : send(res, 400, {}); }

    if (req.method === 'GET' && p === '/api/state') {
      const { lib, wavs } = scanLibrary();
      const skillDir = findSkill();
      return send(res, 200, {
        config: { ...config, hasKey: !!geminiKey(), keyTail: geminiKey().slice(-4) },
        voices: VOICES, jobs, library: lib, wavs: wavs.map(f => ({ file: f, word: wavWord(f) })), styles: STYLES,
        paused, limitUntil, now: Date.now(), login: loginState,
        env: { claude: findClaude(), skillDir, fonts: fs.existsSync(path.join(FONTS, 'BpmfIansui-Regular.ttf')), out: OUT },
      });
    }
    if (req.method === 'POST' && p === '/api/jobs') {
      const b = await readBody(req);
      const words = parseWords(b.words);
      const type = b.type === 'voiced' ? 'voiced' : 'silent';
      const created = [];
      for (const word of words) {
        if (jobs.some(j => j.word === word && j.type === type && ['queued', 'running'].includes(j.status))) continue;
        let style = STYLES.includes(b.style) ? b.style : STYLES[0];
        let wav = null;
        if (type === 'voiced') {
          wav = b.wav || matchWav(word);
          const silent = scanLibrary().lib.find(e => e.word === word);
          if (silent?.style) style = silent.style;
          if (!wav) continue;
        }
        const job = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), word, type, style, wav,
          model: b.model || config.model, note2: String(b.note || '').slice(0, 500), status: 'queued', createdAt: Date.now() };
        jobs.push(job); created.push(job);
      }
      saveJobs(); tick();
      return send(res, 200, { created: created.length });
    }
    let m;
    if ((m = p.match(/^\/api\/jobs\/([\w]+)\/(cancel|retry|log|up)$/))) {
      const job = jobs.find(j => j.id === m[1]);
      if (!job) return send(res, 404, { error: 'no job' });
      if (m[2] === 'log') {
        const f = path.join(LOGS, `${job.id}.log`);
        const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
        return send(res, 200, t.slice(-30000), 'text/plain; charset=utf-8');
      }
      if (m[2] === 'cancel') cancelJob(job);
      if (m[2] === 'retry') { job.status = 'queued'; job.resume = false; job.error = null; job.note = null; tick(); }
      if (m[2] === 'up') { jobs = [job, ...jobs.filter(j => j !== job)]; }
      saveJobs();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/jobs\/([\w]+)$/))) {
      const job = jobs.find(j => j.id === m[1]);
      if (job?.status === 'running') cancelJob(job);
      jobs = jobs.filter(j => j.id !== m[1]); saveJobs();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/clear-finished') {
      jobs = jobs.filter(j => !['done', 'canceled'].includes(j.status)); saveJobs();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/config') {
      const b = await readBody(req);
      if (b.concurrency) config.concurrency = Math.max(1, Math.min(6, Number(b.concurrency)));
      if (b.model) config.model = String(b.model);
      if (b.retryMinutes) config.retryMinutes = Math.max(1, Number(b.retryMinutes));
      if (b.maxBudgetUsd !== undefined) config.maxBudgetUsd = Math.max(0, Number(b.maxBudgetUsd) || 0);
      if (typeof b.geminiKey === 'string' && b.geminiKey.trim()) {
        const k = b.geminiKey.trim();
        if (!KEY_RE.test(k)) return send(res, 400, { error: '這看起來不是 API 金鑰（金鑰不會有中文或空白，請到 aistudio.google.com/apikey 重新複製）' });
        saveEnvKey(k);
      }
      if (isVoice(b.ttsVoice)) config.ttsVoice = b.ttsVoice;
      if (config.ttsModels?.includes(b.ttsModel)) config.ttsModel = b.ttsModel;
      if (b.autoVoice !== undefined) config.autoVoice = !!b.autoVoice;
      saveConfig(); tick();
      return send(res, 200, config);
    }
    if (req.method === 'GET' && p === '/api/narration') {
      const n = readNarration(url.searchParams.get('word') || '');
      return n ? send(res, 200, n) : send(res, 404, { error: '找不到旁白稿' });
    }
    if (req.method === 'POST' && p === '/api/tts') {
      const b = await readBody(req);
      const word = String(b.word || '').trim();
      const sentences = String(b.sentences || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const job = word && queueTts(word, { style: String(b.style || '').trim(), sentences: sentences.length ? sentences : null, voice: isVoice(b.voice) ? b.voice : config.ttsVoice, chain: b.chain !== false, model: b.model });
      saveJobs(); tick();
      return send(res, 200, { created: job ? 1 : 0 });
    }
    // 測試金鑰：列出可用的語音模型；設定的模型不存在時自動換成可用的
    if (req.method === 'POST' && p === '/api/test-key') {
      if (!geminiKey()) return send(res, 200, { ok: false, message: '還沒有填金鑰' });
      const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': geminiKey() }, signal: AbortSignal.timeout(20000) }).catch(e => ({ ok: false, statusText: String(e) }));
      const body = r.json ? await r.json().catch(() => ({})) : {};
      if (!r.ok) return send(res, 200, { ok: false, message: body.error?.message || r.statusText || '連線失敗' });
      const tts = (body.models || []).map(m => m.name.replace(/^models\//, '')).filter(n => /tts/i.test(n));
      if (!tts.length) return send(res, 200, { ok: false, message: '金鑰可以用，但找不到語音（TTS）模型' });
      // 版本新的排前面；同版本 flash > pro > lite，正式版 > preview
      const ver = n => Number(n.match(/gemini-(d+(?:.d+)?)/)?.[1] || 0);
      const rank = n => (/preview/.test(n) ? 2 : 0) + (/lite/.test(n) ? 1 : 0) + (/pro/.test(n) ? 0.5 : 0);
      tts.sort((a, b) => ver(b) - ver(a) || rank(a) - rank(b));
      const isNew = !config.ttsModels?.length;
      config.ttsModels = tts;
      if (isNew || !tts.includes(config.ttsModel)) config.ttsModel = tts[0];
      saveConfig();
      return send(res, 200, { ok: true, message: `金鑰可以用，語音模型：${config.ttsModel}` });
    }
    if (req.method === 'POST' && p === '/api/pause') {
      const b = await readBody(req);
      paused = !!b.paused; if (!paused) limitUntil = 0; tick();
      return send(res, 200, { paused });
    }
    if (req.method === 'POST' && p === '/api/check-login') {
      const r = await checkLogin(); if (r.ok && paused) paused = false;
      return send(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/open-out') {
      execFile('explorer.exe', [OUT], () => {});
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/text') {
      const f = safeIn(DONE, url.searchParams.get('file') || '');
      if (!f || !fs.existsSync(f)) return send(res, 404, '');
      return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/plain; charset=utf-8');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  工作台已經在執行中了（port ${PORT} 被占用）。`);
    console.log(`  直接打開 http://localhost:${PORT} 即可；若要重開，請先關掉另一個工作台視窗。\n`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  語詞教學動畫工作台：http://localhost:${PORT}\n`);
  console.log(`  claude：${findClaude()}`);
  console.log(`  skill ：${findSkill() || '（找不到！）'}`);
  console.log(`  成品  ：${OUT}\n`);
  checkLogin().then(r => console.log(`  登入狀態：${r.ok ? '已登入' : r.message}`));
});
