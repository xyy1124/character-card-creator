#!/usr/bin/env node
/**
 * card_agent.js — 角色卡工作流 Agent 工具（技能「〇、工作流总控」0.1~0.8 协议的执行层）
 *
 * 用途：把 run.json 状态管理、验证门禁、候选提升从"agent 自觉执行"变成"工具强制执行"。
 * 技能规则：工作流状态一律用本工具管理，禁止手写 run.json。
 *
 * 子命令:
 *   init <卡名> [--mode create|modify|restore|imitate] [--features lorebook,writing_specialization,tracker,source_research] [--profile basic|lorebook|tracker|restore-full]
 *       建 _work/run.json 骨架 + 预检（卡名合法、目录可写、run.json 不存在）
 *   record <卡名> --decision "用户决定文本" | --artifact <相对路径> | --issue-add "问题" | --issue-clear
 *       记录用户决定/产物/遗留问题到 run.json
 *   verify <卡名> [--candidate] [--story-terms=key=词1,词2 ...]
 *       按 run.json 的 profile 跑验证链：JSON 合法性 / tracker v76/v77 门禁 / PHI v71 输出指令 / 编号泄漏 / 数值化警告
 *       --candidate 时验证 _work/candidates/ 下的候选文件（0.6 候选提升门禁）
 *       退出码: 0=通过 / 1=验证失败 / 2=用法错误
 *   promote <卡名> [--force]
 *       备份正式文件 → 候选提升为正式 → 复验 → 更新 run.json（未通过 verify 时拒绝提升，--force 跳过）
 *   report <卡名>
 *       汇总 run.json 状态（mode/features/profile/stage_status/open_issues/artifacts）
 *
 * 环境变量: CARDS_ROOT（角色卡根目录，默认 ./cards）
 * 示例:
 *   CARDS_ROOT=E:/ZCode/角色卡/cards node scripts/card_agent.js init 蜜欧拉_NTR --mode modify --features tracker
 *   node card_agent.js verify 蜜欧拉_NTR
 */
"use strict";

const fs = require('fs');
const path = require('path');
const { verifyTrackerV76V77 } = require('./verify_tracker_v76_v77');

const CARDS_ROOT = process.env.CARDS_ROOT || 'cards';
const MODES = ['create', 'modify', 'restore', 'imitate'];
const FEATURES = ['lorebook', 'writing_specialization', 'tracker', 'source_research'];
const PROFILES = ['basic', 'lorebook', 'tracker', 'restore-full'];
const CARD_FILE_SUFFIX = '_角色卡_CCv2.json';

// ---------- 基础工具 ----------
function cardDir(name) {
  return path.join(CARDS_ROOT, name);
}
function workDir(name) {
  return path.join(cardDir(name), '_work');
}
function runJsonPath(name) {
  return path.join(workDir(name), 'run.json');
}
function candidatesDir(name) {
  return path.join(workDir(name), 'candidates');
}
function findCardFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => x.endsWith(CARD_FILE_SUFFIX) && !x.includes('.bak'));
  return f ? path.join(dir, f) : null;
}
function loadRun(name) {
  const p = runJsonPath(name);
  if (!fs.existsSync(p)) {
    console.error(`✗ run.json 不存在: ${p}（先执行 init）`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveRun(name, run) {
  fs.writeFileSync(runJsonPath(name), JSON.stringify(run, null, 2) + '\n', 'utf8');
}
function exitUsage(msg) {
  console.error(`用法错误: ${msg}\n用法: node card_agent.js <init|record|verify|promote|report> <卡名> [选项]`);
  process.exit(2);
}

// ---------- 检查项 ----------
// 编号泄漏：运行时字段不得含制作层编号（如 "01-§三" / "3-§五"）
const RUNTIME_FIELDS = [
  'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'system_prompt', 'post_history_instructions', 'alternate_greetings',
];
const LEAK_RE = /[0-9０-９]\s*[-－]\s*§/;
// PHI v71：禁止"输出状态栏/面板"指令句
const PHI_OUTPUT_RE = /输出\s*(?:HTML\s*)?(?:状态栏|状态面板|状态条)|(?:必须|每次|回复|末尾).{0,12}(?:输出).{0,8}(?:状态栏|状态面板|状态条|面板)/;
// 全字段污染模式（模型可见字段中任何一处命中即 FAIL——App 剥离层不处理这些）
const POLLUTION_RE = /必须输出状态面板|输出 HTML 状态面板|每次回复末尾(?:强制)?输出状态|输出状态栏|状态面板强制输出|角色卡是否要求状态面板|是否必须输出状态面板|更新面板|回复末尾完整输出状态面板|预测更新后的状态栏|状态栏必须与剧情一致|在 post_history_instructions 中更新面板/;
// 模拟 App 剥离后 PHI 残留的面板样式（剥离后命中即 FAIL）
const PHI_STRIP_RESIDUE_RE = /状态面板|状态栏|【|❤~|当前心理状态|【\{|【状态规则/;
// 模拟 App stripPanelTemplates 剥离逻辑（按 tracker_runtime.dart:975-1102 实现）
function stripAppPHI(phi) {
  if (!phi) return '';
  let s = phi
    .replace(/<!--panel-->[\s\S]*?<!--\/panel-->/g, '')
    .replace(/<details>[\s\S]*?<\/details>/g, '');
  const keep = [];
  for (const l of s.split('\n')) {
    if (/setvar::/.test(l)) continue;
    if (/状态栏三件套|强制输出规则/.test(l)) continue;
    if (/(?:必须|需要|请|随后|每次|回复|末尾).{0,20}(?:输出|显示).{0,10}(?:状态栏|状态面板|面板|状态条)/.test(l)) continue;
    keep.push(l);
  }
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function checkJsonLegal(cardPath) {
  const errors = [];
  if (!fs.existsSync(cardPath)) {
    return { ok: false, errors: [`卡文件不存在: ${cardPath}`] };
  }
  try {
    JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  } catch (e) {
    errors.push(`JSON 解析失败: ${e.message}`);
  }
  return { ok: errors.length === 0, errors };
}

function checkTracker(cardPath, storyTermsByField) {
  let card;
  try { card = JSON.parse(fs.readFileSync(cardPath, 'utf8')); } catch { return { ok: true, errors: [], skipped: true }; }
  const tracker = card?.data?.extensions?.tracker;
  if (!tracker) return { ok: true, errors: [], skipped: true };
  const result = verifyTrackerV76V77(card, { storyTermsByField, throwOnError: false });
  return { ok: result.ok, errors: result.errors, skipped: false };
}

function checkPhiV71(cardPath) {
  let card;
  try { card = JSON.parse(fs.readFileSync(cardPath, 'utf8')); } catch { return { ok: true, errors: [], skipped: true }; }
  if (!card?.data?.extensions?.tracker) return { ok: true, errors: [], skipped: true }; // 仅含 tracker 的卡必查
  const phi = card?.data?.post_history_instructions || '';
  const errors = [];
  const m = PHI_OUTPUT_RE.exec(phi);
  if (m) errors.push(`post_history_instructions 含"输出面板"指令句（v71 FAIL）: "${m[0]}"`);
  return { ok: errors.length === 0, errors, skipped: false };
}

function checkLeak(cardPath) {
  let card;
  try { card = JSON.parse(fs.readFileSync(cardPath, 'utf8')); } catch { return { ok: true, errors: [], skipped: true }; }
  const errors = [];
  const scan = (label, text) => {
    if (typeof text !== 'string') return;
    text.split('\n').forEach((line, i) => {
      const m = LEAK_RE.exec(line);
      if (!m) return;
      const trimmed = line.trim();
      // 例外：system_prompt 防泄漏规则中的"禁止格式示例"（列表行如 "- 01-§、02-§、…"，或含"输出纯净规则/严禁在最终回复中输出/禁止格式"的规则段），技能文档明确属合法例外
      if (label === 'system_prompt' && (
        /^[-*]\s*[0-9０-９]{1,2}\s*[-－]\s*§/.test(trimmed) ||
        /输出纯净规则|严禁在最终回复中输出|防泄漏|禁止格式|制作标记/.test(line)
      )) return;
      errors.push(`编号泄漏 ${label}（第${i + 1}行）: "${trimmed.slice(0, 60)}"`);
    });
  };
  const d = card.data || {};
  for (const f of RUNTIME_FIELDS) scan(f, d[f]);
  if (Array.isArray(d.alternate_greetings)) d.alternate_greetings.forEach((g, i) => scan(`alternate_greetings[${i}]`, g));
  if (Array.isArray(d.character_book?.entries)) d.character_book.entries.forEach((e, i) => scan(`character_book.entries[${i}].content`, e.content));
  return { ok: errors.length === 0, errors, skipped: false };
}

function checkNumeric(cardPath) {
  let card;
  try { card = JSON.parse(fs.readFileSync(cardPath, 'utf8')); } catch { return { ok: true, errors: [], skipped: true }; }
  const warnings = [];
  const count = (t) => (t.match(/[0-9０-９]/g) || []).length;
  const scan = (label, text) => {
    if (typeof text !== 'string') return;
    if (count(text) >= 10) warnings.push(`${label} 数字 ≥10（数值化语言，需自然化或属面板模板例外）`);
  };
  const d = card.data || {};
  for (const f of RUNTIME_FIELDS) scan(f, d[f]);
  if (Array.isArray(d.character_book?.entries)) d.character_book.entries.forEach((e, i) => scan(`character_book.entries[${i}].content`, e.content));
  return { warnings };
}

// 模拟 App 剥离后 PHI 必须干净（剥离层不处理纯文本状态段——2026-08-11 事故根因）
function checkPhiStripped(cardPath) {
  let card;
  try { card = JSON.parse(fs.readFileSync(cardPath, 'utf8')); } catch { return { ok: true, errors: [], skipped: true }; }
  if (!card?.data?.extensions?.tracker) return { ok: true, errors: [], skipped: true };
  const phi = card?.data?.post_history_instructions || '';
  const stripped = stripAppPHI(phi);
  const errors = [];
  const m = stripped.match(PHI_STRIP_RESIDUE_RE);
  if (m) errors.push(`PHI 模拟 App 剥离后仍有面板样式残留: "${stripped.slice(0, 60)}"（纯文本状态段会被注入模型，导致正文输出状态栏）`);
  return { ok: errors.length === 0, errors, skipped: false };
}

// 全字段污染扫描：模型可见字段不得含输出指令/面板模板（mes_example/system_prompt/description/世界书/actions）
function checkFieldPollution(cardPath) {
  let card;
  try { card = JSON.parse(fs.readFileSync(cardPath, 'utf8')); } catch { return { ok: true, errors: [], skipped: true }; }
  const errors = [];
  const d = card.data || {};
  const scan = (label, text) => {
    if (typeof text !== 'string') return;
    const m = text.match(POLLUTION_RE);
    if (m) errors.push(`${label} 含面板输出指令: "${m[0].slice(0, 40)}"`);
    if (/<details/.test(text)) errors.push(`${label} 含裸 <details> 面板（App 剥离层只处理 PHI 内/部分格式，其他字段会注入模型）`);
  };
  for (const f of ['description', 'personality', 'scenario', 'mes_example', 'system_prompt']) scan(f, d[f]);
  if (Array.isArray(d.character_book?.entries)) d.character_book.entries.forEach((e, i) => scan(`worldbook[${i}]`, e.content));
  for (const a of (d.extensions?.tracker?.actions || [])) scan('tracker.actions', a.prompt);
  return { ok: errors.length === 0, errors, skipped: false };
}

// profile 必需文件（相对卡目录）
const PROFILE_FILES = {
  basic: [],
  lorebook: ['<卡名>_配套世界书_ST.json'],
  tracker: ['<卡名>_QuickReplies.json'],
  'restore-full': ['<卡名>_配套世界书_ST.json', '<卡名>_写作特化_ST.json', '<卡名>_QuickReplies.json', '<卡名>_封面.png', '<卡名>_还原学习笔记.md', '<卡名>_制作说明.md'],
};

function checkProfileFiles(name, profile) {
  const errors = [];
  for (const f of PROFILE_FILES[profile] || []) {
    const p = path.join(cardDir(name), f.replace('<卡名>', name));
    if (!fs.existsSync(p)) errors.push(`profile=${profile} 必需文件缺失: ${f}`);
  }
  return { ok: errors.length === 0, errors };
}

function runVerify(name, opts) {
  const cardPath = opts.candidate
    ? path.join(candidatesDir(name), `${name}${CARD_FILE_SUFFIX}`)
    : findCardFile(cardDir(name));
  const run = loadRun(name);
  const profile = run.profile || 'basic';
  const errors = [];
  const warnings = [];

  // 1. JSON 合法性
  const j = checkJsonLegal(cardPath);
  if (!j.ok) errors.push(...j.errors);

  // 2. tracker v76/v77（含 tracker 时必查）
  const t = checkTracker(cardPath, opts.storyTermsByField);
  if (!t.ok) errors.push(...t.errors.map((e) => `tracker: ${e}`));

  // 3. PHI v71
  const p = checkPhiV71(cardPath);
  if (!p.ok) errors.push(...p.errors);

  // 3.5 PHI 模拟 App 剥离后残留（2026-08-11 事故根因）
  const ps = checkPhiStripped(cardPath);
  if (!ps.ok) errors.push(...ps.errors);

  // 3.6 全字段污染扫描（mes_example/system_prompt/世界书/actions）
  const fp = checkFieldPollution(cardPath);
  if (!fp.ok) errors.push(...fp.errors);

  // 4. 编号泄漏
  const l = checkLeak(cardPath);
  if (!l.ok) errors.push(...l.errors);

  // 5. 数值化警告
  const n = checkNumeric(cardPath);
  warnings.push(...n.warnings);

  // 6. profile 必需文件
  const pf = checkProfileFiles(name, profile);
  if (!pf.ok) errors.push(...pf.errors);

  const src = opts.candidate ? '候选' : '正式';
  console.log(`== verify ${name}（${src}，profile=${profile}）==`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (errors.length === 0) {
    console.log(`✓ 全部通过（${warnings.length} 条警告）`);
    return { ok: true, warnings };
  }
  console.log(`✗ 验证失败（${errors.length} 项）`);
  return { ok: false, errors, warnings };
}

// ---------- 子命令 ----------
function cmdInit(name, opts) {
  const invalid = /[\\/:*?"<>|\s]/.test(name);
  if (invalid) exitUsage(`卡名含非法字符: ${name}`);
  if (!fs.existsSync(CARDS_ROOT)) exitUsage(`CARDS_ROOT 不存在: ${CARDS_ROOT}`);
  if (fs.existsSync(runJsonPath(name))) {
    console.error(`✗ run.json 已存在: ${runJsonPath(name)}（用 record/report 继续，或先删除再 init）`);
    process.exit(1);
  }
  const mode = opts.mode || (fs.existsSync(cardDir(name)) ? 'modify' : 'create');
  if (!MODES.includes(mode)) exitUsage(`未知模式: ${mode}（${MODES.join('|')}）`);
  const features = { lorebook: false, writing_specialization: false, tracker: false, source_research: false };
  for (const f of opts.features || []) {
    if (!FEATURES.includes(f)) exitUsage(`未知功能开关: ${f}`);
    features[f] = true;
  }
  const profile = opts.profile
    || (mode === 'restore' ? 'restore-full'
      : features.tracker ? 'tracker'
      : features.lorebook ? 'lorebook'
      : 'basic');
  if (!PROFILES.includes(profile)) exitUsage(`未知 profile: ${profile}（${PROFILES.join('|')}）`);

  fs.mkdirSync(workDir(name), { recursive: true });
  fs.mkdirSync(candidatesDir(name), { recursive: true });
  const run = {
    mode, features, profile,
    user_decisions: [], inputs: [], artifacts: [],
    stage_status: { init: 'done' },
    validation_profile: [],
    attempts: {},
    open_issues: [],
  };
  saveRun(name, run);
  console.log(`✓ run.json 已创建: ${runJsonPath(name)}`);
  console.log(`  mode=${mode} features=${JSON.stringify(features)} profile=${profile}`);
  // 预检：卡文件存在性提示
  const cardFile = findCardFile(cardDir(name));
  console.log(cardFile ? `  卡文件: ${cardFile}` : `  ⚠ 卡文件未找到（${name}${CARD_FILE_SUFFIX}）——create 模式属正常`);
}

function cmdRecord(name, opts) {
  const run = loadRun(name);
  let changed = false;
  if (opts.decision) { run.user_decisions.push({ date: new Date().toISOString().slice(0, 10), decision: opts.decision }); changed = true; }
  if (opts.artifact) { if (!run.artifacts.includes(opts.artifact)) run.artifacts.push(opts.artifact); changed = true; }
  if (opts.issueAdd) { if (!run.open_issues.includes(opts.issueAdd)) run.open_issues.push(opts.issueAdd); changed = true; }
  if (opts.issueClear) { run.open_issues = []; changed = true; }
  if (!changed) exitUsage('record 需要 --decision / --artifact / --issue-add / --issue-clear 之一');
  saveRun(name, run);
  console.log(`✓ run.json 已更新（${runJsonPath(name)}）`);
}

function cmdVerify(name, opts) {
  const result = runVerify(name, opts);
  process.exit(result.ok ? 0 : 1);
}

function cmdPromote(name, opts) {
  const run = loadRun(name);
  const candPath = path.join(candidatesDir(name), `${name}${CARD_FILE_SUFFIX}`);
  const formalPath = findCardFile(cardDir(name));
  if (!fs.existsSync(candPath)) {
    console.error(`✗ 候选文件不存在: ${candPath}（0.6：先产出候选再提升）`);
    process.exit(1);
  }
  // 门禁：候选必须通过 verify（--force 跳过）
  if (!opts.force) {
    const v = runVerify(name, { candidate: true, storyTermsByField: opts.storyTermsByField });
    if (!v.ok) {
      console.error('✗ 候选未通过验证，拒绝提升（--force 可强制，不推荐）');
      process.exit(1);
    }
  }
  // 备份正式文件
  if (formalPath) {
    const bak = `${formalPath}.modify-${new Date().toISOString().slice(0, 10)}.bak`;
    fs.copyFileSync(formalPath, bak);
    console.log(`  备份: ${bak}`);
  }
  // 提升
  fs.copyFileSync(candPath, path.join(cardDir(name), `${name}${CARD_FILE_SUFFIX}`));
  console.log(`✓ 候选已提升为正式文件`);
  // 复验
  const v2 = runVerify(name, { storyTermsByField: opts.storyTermsByField });
  if (!v2.ok) {
    console.error('⚠ 提升后复验未通过——请按 0.7 返工循环处理');
    process.exit(1);
  }
  run.stage_status.promote = 'done';
  if (!run.artifacts.includes(`${name}${CARD_FILE_SUFFIX} (提升后)`)) run.artifacts.push(`${name}${CARD_FILE_SUFFIX} (提升后)`);
  saveRun(name, run);
  console.log('✓ promote 完成，run.json 已更新');
}

function cmdReport(name) {
  const run = loadRun(name);
  const cardFile = findCardFile(cardDir(name));
  console.log(`== report ${name} ==`);
  console.log(`  卡文件: ${cardFile || '未找到'}`);
  console.log(`  mode: ${run.mode} | profile: ${run.profile}`);
  console.log(`  features: ${JSON.stringify(run.features)}`);
  console.log(`  stage_status: ${JSON.stringify(run.stage_status)}`);
  console.log(`  user_decisions: ${run.user_decisions.length} 条`);
  for (const d of run.user_decisions) console.log(`    - [${d.date}] ${d.decision}`);
  console.log(`  open_issues: ${run.open_issues.length} 项`);
  for (const i of run.open_issues) console.log(`    - ${i}`);
  console.log(`  artifacts: ${run.artifacts.length} 项`);
  for (const a of run.artifacts) console.log(`    - ${a}`);
  console.log(`  attempts: ${JSON.stringify(run.attempts || {})}`);
}

// ---------- 入口 ----------
function parseOpts(args) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--mode=')) opts.mode = a.slice(7);
    else if (a === '--mode') opts.mode = args[++i];
    else if (a.startsWith('--features=')) opts.features = a.slice(11).split(',');
    else if (a === '--features') opts.features = (args[++i] || '').split(',');
    else if (a.startsWith('--profile=')) opts.profile = a.slice(10);
    else if (a === '--profile') opts.profile = args[++i];
    else if (a.startsWith('--decision=')) opts.decision = a.slice(11);
    else if (a === '--decision') opts.decision = args[++i];
    else if (a.startsWith('--artifact=')) opts.artifact = a.slice(11);
    else if (a === '--artifact') opts.artifact = args[++i];
    else if (a.startsWith('--issue-add=')) opts.issueAdd = a.slice(12);
    else if (a === '--issue-add') opts.issueAdd = args[++i];
    else if (a === '--issue-clear') opts.issueClear = true;
    else if (a === '--candidate') opts.candidate = true;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--story-terms=')) {
      const m = /^--story-terms=([^=]+)=(.+)$/.exec(a);
      if (!m) exitUsage(`--story-terms 格式: --story-terms=key=词1,词2`);
      (opts.storyTermsByField ||= {})[m[1].trim()] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    }
    else if (a.startsWith('-')) exitUsage(`未知选项: ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

const { opts, rest } = parseOpts(process.argv.slice(2));
const cmd = rest[0];
const name = rest[1];
if (!cmd || !name) exitUsage('需要子命令和卡名');
switch (cmd) {
  case 'init': cmdInit(name, opts); break;
  case 'record': cmdRecord(name, opts); break;
  case 'verify': cmdVerify(name, opts); break;
  case 'promote': cmdPromote(name, opts); break;
  case 'report': cmdReport(name); break;
  default: exitUsage(`未知子命令: ${cmd}`);
}
