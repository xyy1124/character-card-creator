// verify_tracker_v76_v77.js — Tracker 协议公共验证器（唯一权威实现）
// 入口按 schemaVersion 分流：
//   schemaVersion >= 2 → verifyEntityTrackerV2（v89 动态实体卡）
//   否则               → verifyStaticTrackerV1（v76/v77 静态卡，原规则不变）
// 所有生成脚本（写盘前）与验证脚本（读盘后）必须调用本模块，禁止各自实现规则
// 模块用法（仓库根目录）:
//   const { verifyTrackerV76V77 } = require('./scripts/verify_tracker_v76_v77');
//   verifyTrackerV76V77(card, { storyTermsByField, throwOnError: false });
// CLI 用法（0.6 候选提升门禁）:
//   node scripts/verify_tracker_v76_v77.js <角色卡.json> [--story-terms=key=词1,词2 ...]
//   退出码: 0=通过 / 1=验证失败 / 2=用法错误或文件不可读
"use strict";

// ---- 公共工具 ----
function makeHelpers(options) {
  const {
    storyTermsByField = {},
    genericDeltaTerms = ["一点", "稍微", "明显", "大幅"],
    maxStateTitleLength = 12,
    throwOnError = true
  } = options;
  const errors = [];
  const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const own = (o, k) => plain(o) && Object.prototype.hasOwnProperty.call(o, k);
  const requireRule = (condition, path, message) => {
    if (!condition) errors.push(`${path}: ${message}`);
  };
  const validStringArray = (v) =>
    Array.isArray(v) && v.length > 0 &&
    v.every((item) => typeof item === "string" && item.trim().length > 0);
  const exactKeySet = (actual, expected) =>
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((key) => expected.includes(key));
  return {
    errors, plain, own, requireRule, validStringArray, exactKeySet,
    genericDeltaTerms, storyTermsByField, maxStateTitleLength,
  };
}

// 字段级校验（v1/v2 共用）——type/range/presentation/updatePolicy/semanticHints
function verifyFieldSchema(h, field, initialValue, path, templateFieldKeys) {
  const { requireRule, own, validStringArray, genericDeltaTerms, storyTermsByField, maxStateTitleLength } = h;
  requireRule(h.plain(field), path, "字段声明必须为对象");
  if (!h.plain(field)) return;

  requireRule(validStringArray(field.aliases), `${path}.aliases`, "必须是非空字符串数组");
  requireRule(
    Array.isArray(field.aliases) && field.aliases.includes(field.label),
    `${path}.aliases`,
    `必须包含字段 label "${field.label}"`
  );
  requireRule(!own(field, "semanticHints"), `${path}.semanticHints`, "禁止位于字段顶层，必须移入 updatePolicy.semanticHints");

  if (field.type === "number") {
    requireRule(Number.isFinite(field.min), `${path}.min`, "必须为有限数值");
    requireRule(Number.isFinite(field.max), `${path}.max`, "必须为有限数值");
    requireRule(field.min < field.max, path, "min 必须小于 max");
    if (initialValue !== undefined) {
      requireRule(
        Number.isFinite(initialValue) && initialValue >= field.min && initialValue <= field.max,
        `${path}.initialState`,
        "必须为 min/max 范围内的数值"
      );
    }

    const ranges = field.presentation?.ranges;
    requireRule(Array.isArray(ranges) && ranges.length >= 3, `${path}.presentation.ranges`, "number 字段必须声明至少 3 段 ranges（v76 标准）");
    for (const [index, range] of (Array.isArray(ranges) ? ranges : []).entries()) {
      const rangePath = `${path}.presentation.ranges[${index}]`;
      requireRule(h.plain(range), rangePath, "必须为对象");
      const hasGteLt = Number.isFinite(range?.gte) && (range.lt === undefined || Number.isFinite(range.lt));
      const hasMinMax = Number.isFinite(range?.min) && Number.isFinite(range?.max);
      requireRule(hasGteLt || hasMinMax, rangePath, "必须为 gte/lt（或 min/max）数值边界");
      if (hasGteLt && Number.isFinite(range.lt)) requireRule(range.gte < range.lt, rangePath, "gte 必须小于 lt");
      if (hasMinMax) requireRule(range.min < range.max, rangePath, "min 必须小于 max");
      requireRule(typeof range?.title === "string" && range.title.trim(), `${rangePath}.title`, "不能为空");
      requireRule(typeof range?.text === "string" && range.text.trim(), `${rangePath}.text`, "不能为空");
    }

    const policy = field.updatePolicy;
    requireRule(h.plain(policy), `${path}.updatePolicy`, "number 字段必须声明");
    const deltas = h.plain(policy?.qualitativeDeltas) ? policy.qualitativeDeltas : {};
    requireRule(Object.keys(deltas).length > 0, `${path}.updatePolicy.qualitativeDeltas`, "必须为非空对象");
    for (const [term, delta] of Object.entries(deltas)) {
      requireRule(term.trim().length > 0 && Number.isFinite(delta) && delta !== 0, `${path}.updatePolicy.qualitativeDeltas.${term}`, "增量必须是非零有限数值");
    }
    for (const term of genericDeltaTerms) {
      requireRule(own(deltas, term), `${path}.updatePolicy.qualitativeDeltas`, `缺少通用程度词 "${term}"`);
    }

    const storyTerms = storyTermsByField[path.includes('.') ? path.split('.').pop() : path];
    const autoStoryTerms = Object.keys(deltas).filter((term) => !genericDeltaTerms.includes(term) && term.trim().length > 0);
    const effectiveStoryTerms = Array.isArray(storyTerms) ? storyTerms : autoStoryTerms;
    // v1 静态卡：至少两个剧情词（生成时显式提供 storyTermsByField）
    // v2 实体卡：模板字段在 sectionTemplate/裁判 prompt 有语义约束，
    // 通用验证场景下允许仅 1 个剧情词（qualitativeDeltas 非通用词），
    // 不强制 2 个——避免 v2 模板字段因剧情词不足被误拒。
    const isEntityTemplatePath = path.includes('.stateSchema.');
    const minStoryTerms = isEntityTemplatePath ? 1 : 2;
    requireRule(validStringArray(effectiveStoryTerms) && effectiveStoryTerms.length >= minStoryTerms, `storyTermsByField`, `每个 number 字段必须至少有两个本卡剧情词（生成时显式提供 storyTermsByField；通用验证时从 qualitativeDeltas 非通用词检查）`);
    for (const term of effectiveStoryTerms) {
      requireRule(!genericDeltaTerms.includes(term), `storyTermsByField`, `"${term}" 仍是通用程度词，不是本卡剧情词`);
      requireRule(own(deltas, term), `${path}.updatePolicy.qualitativeDeltas`, `缺少已声明剧情词 "${term}"`);
    }

    const hints = policy?.semanticHints;
    requireRule(h.plain(hints), `${path}.updatePolicy.semanticHints`, "必须存在且位于 updatePolicy 内");
    requireRule(typeof hints?.meaning === "string" && hints.meaning.trim(), `${path}.updatePolicy.semanticHints.meaning`, "必须为非空字符串");
    for (const name of ["positiveSignals", "negativeSignals", "neutralSignals"]) {
      requireRule(validStringArray(hints?.[name]), `${path}.updatePolicy.semanticHints.${name}`, "必须是非空 JSON 字符串数组，禁止分隔字符串");
    }
  } else if (field.type === "string") {
    const isEnumerated = field.allowCustomValues === false;
    const states = field.presentation?.states;
    if (isEnumerated) {
      requireRule(h.plain(states) && Object.keys(states).length >= 2, `${path}.presentation.states`, "枚举模式必须声明至少 2 个 states");
      requireRule(typeof initialValue === "string" && h.plain(states) && own(states, initialValue), `${path}.initialState`, "枚举模式 initialState 必须精确命中 presentation.states 的 key");
    } else if (states != null) {
      requireRule(h.plain(states) && Object.keys(states).length > 0, `${path}.presentation.states`, "自由模式 states（如声明）必须为非空对象");
    }
    for (const [stateKey, state] of Object.entries(h.plain(states) ? states : {})) {
      const statePath = `${path}.presentation.states.${stateKey}`;
      requireRule(h.plain(state), statePath, "必须为对象");
      requireRule(state?.title === stateKey, `${statePath}.title`, `必须与 states key "${stateKey}" 完全一致`);
      requireRule(Array.from(stateKey.trim()).length > 0 && Array.from(stateKey.trim()).length <= maxStateTitleLength && !/[\r\n]/.test(stateKey), statePath, `状态名必须为不超过 ${maxStateTitleLength} 字的短名`);
      requireRule(typeof state?.text === "string" && state.text.trim(), `${statePath}.text`, "必须为非空描述");
    }
  } else {
    requireRule(false, `${path}.type`, "只允许 number 或 string");
  }
}

// ---- v1：v76/v77 静态卡（原规则不变）----
function verifyStaticTrackerV1(tracker, options = {}) {
  const h = makeHelpers(options);
  const { requireRule, exactKeySet } = h;

  const schema = h.plain(tracker?.stateSchema) ? tracker.stateSchema : {};
  const fieldKeys = Object.keys(schema);
  const initial = h.plain(tracker?.initialState) ? tracker.initialState : {};
  const initialKeys = Object.keys(initial);

  requireRule(fieldKeys.length >= 3, "tracker.stateSchema", "至少声明 3 个字段（v76 标准）");
  requireRule(exactKeySet(initialKeys, fieldKeys), "tracker.initialState", "key 集合必须与 stateSchema 完全一致，且不得重复或遗漏");

  for (const [key, field] of Object.entries(schema)) {
    const path = `tracker.stateSchema.${key}`;
    requireRule(h.plain(field), path, "字段声明必须为对象");
    if (!h.plain(field)) continue;
    verifyFieldSchema(h, field, initial[key], path, fieldKeys);
  }

  for (const key of Object.keys(h.storyTermsByField)) {
    requireRule(schema[key]?.type === "number", `storyTermsByField.${key}`, "只能引用已声明的 number 字段");
  }

  requireRule(Array.isArray(tracker?.actions) && tracker.actions.length >= 2, "tracker.actions", "必须声明至少 2 个动作（查看状态/重置状态 + 玩法动作，v76 标准）");

  const order = tracker?.uiHints?.order;
  requireRule(Array.isArray(order) && exactKeySet(order, fieldKeys), "tracker.uiHints.order", "必须无重复，并与 stateSchema key 集合完全一致");

  const template = typeof tracker?.template === "string" ? tracker.template.trim() : "";
  requireRule(/^<details(?:\s|>)/i.test(template), "tracker.template", "去除首尾空白后必须以 <details 开头");
  requireRule(/<\/details>$/i.test(template), "tracker.template", "必须以 </details> 结束，外部不得残留文字");
  requireRule(!/<!--\s*\/?panel\s*-->/i.test(template), "tracker.template", "不得包含 panel 标记");
  requireRule(!/```|TRACKER_UPDATE|\{\{\s*setvar|必须输出|请输出|不得编造|变量更新|状态栏三件套/i.test(template), "tracker.template", "不得包含围栏、更新宏或输出指令");

  const macros = [];
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const parsed = match[1].match(/^(getvar|gettitle|gettext|getcolor|getpercent|getnarrative)::\s*([A-Za-z0-9_-]+)$/);
    requireRule(Boolean(parsed), "tracker.template", `非法或无 ::key 的裸宏 "{{${match[1]}}}"`);
    if (parsed) {
      macros.push({ name: parsed[1], key: parsed[2] });
      requireRule(fieldKeys.includes(parsed[2]), "tracker.template", `宏引用未知字段 "${parsed[2]}"`);
    }
  }

  for (const [key, field] of Object.entries(schema)) {
    requireRule(macros.some((macro) => macro.name === "getvar" && macro.key === key), "tracker.template", `字段 "${key}" 缺少 {{getvar::${key}}}`);
    const descriptionMacro = field.type === "number" ? "getnarrative" : "gettext";
    requireRule(macros.some((macro) => macro.name === descriptionMacro && macro.key === key), "tracker.template", `字段 "${key}" 缺少 {{${descriptionMacro}::${key}}}`);
  }

  return { ok: h.errors.length === 0, errors: h.errors, kind: 'v1' };
}

// ---- v2：v89 动态实体卡 ----
function verifyEntityTrackerV2(tracker, options = {}) {
  const h = makeHelpers(options);
  const { requireRule, exactKeySet } = h;

  const templates = h.plain(tracker?.entityTemplates) ? tracker.entityTemplates : {};
  const templateIds = Object.keys(templates);
  const initialEntities = Array.isArray(tracker?.initialEntities) ? tracker.initialEntities : [];

  // 1. 模板完整性
  requireRule(templateIds.length >= 1, "tracker.entityTemplates", "必须至少声明 1 个实体模板");
  for (const [templateId, template] of Object.entries(templates)) {
    const tPath = `tracker.entityTemplates.${templateId}`;
    requireRule(h.plain(template), tPath, "模板必须为对象");
    if (!h.plain(template)) continue;
    requireRule(typeof template.label === "string" && template.label.trim(), `${tPath}.label`, "必须为非空 label");
    requireRule(h.plain(template.defaultState), `${tPath}.defaultState`, "必须为对象");
    const schema = h.plain(template.stateSchema) ? template.stateSchema : {};
    const fieldKeys = Object.keys(schema);
    requireRule(fieldKeys.length >= 1, `${tPath}.stateSchema`, "模板必须声明至少 1 个字段");
    for (const [key, field] of Object.entries(schema)) {
      const fieldPath = `${tPath}.stateSchema.${key}`;
      verifyFieldSchema(h, field, template.defaultState?.[key], fieldPath, fieldKeys);
    }
    // sectionTemplate 校验
    const section = typeof template.sectionTemplate === "string" ? template.sectionTemplate : "";
    if (section.trim()) {
      for (const match of section.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const body = match[1].trim();
        if (body === "entityid" || body === "entityname") continue;
        const parsed = body.match(/^(getvar|gettitle|gettext|getcolor|getpercent|getnarrative)::\s*([A-Za-z0-9_-]+)$/);
        requireRule(Boolean(parsed), `${tPath}.sectionTemplate`, `非法或无 ::key 的宏 "{{${body}}}"`);
        if (parsed) {
          requireRule(fieldKeys.includes(parsed[2]), `${tPath}.sectionTemplate`, `宏引用模板外字段 "${parsed[2]}"`);
        }
      }
    } else {
      requireRule(false, `${tPath}.sectionTemplate`, "必须声明（分区模板是实体卡面板的组成部分）");
    }
  }

  // 2. 预设实体
  const entityIds = [];
  for (const [index, entity] of initialEntities.entries()) {
    const ePath = `tracker.initialEntities[${index}]`;
    requireRule(h.plain(entity), ePath, "必须为对象");
    if (!h.plain(entity)) continue;
    requireRule(typeof entity.id === "string" && entity.id.trim(), `${ePath}.id`, "必须为非空 id");
    requireRule(!entity.id.includes('.'), `${ePath}.id`, "id 不得包含点号（实例 key 用点分隔）");
    requireRule(typeof entity.displayName === "string" && entity.displayName.trim(), `${ePath}.displayName`, "必须为非空 displayName");
    requireRule(typeof entity.templateId === "string" && templateIds.includes(entity.templateId), `${ePath}.templateId`, "必须引用已声明模板");
    if (entity.id && !entity.id.includes('.')) {
      requireRule(!entityIds.includes(entity.id), `${ePath}.id`, "预设实体 id 不得重复");
      entityIds.push(entity.id);
    }
    if (entity.initialState != null) {
      const overrideKeys = Object.keys(entity.initialState);
      const template = templates[entity.templateId];
      const tKeys = h.plain(template?.stateSchema) ? Object.keys(template.stateSchema) : [];
      for (const k of overrideKeys) {
        requireRule(tKeys.includes(k), `${ePath}.initialState.${k}`, "override 只能使用模板字段 key");
      }
    }
  }

  // 3. discovery
  const discovery = h.plain(tracker?.entityDiscovery) ? tracker.entityDiscovery : {};
  if (discovery.enabled === true) {
    requireRule(typeof discovery.defaultTemplateId === "string" && templateIds.includes(discovery.defaultTemplateId), "tracker.entityDiscovery.defaultTemplateId", "必须引用已声明模板");
    requireRule(Number.isInteger(discovery.maxAutoEntities) && discovery.maxAutoEntities >= 1 && discovery.maxAutoEntities <= 24, "tracker.entityDiscovery.maxAutoEntities", "必须是 1..24 的整数");
  }

  // 4. migrations
  const migrations = Array.isArray(tracker?.migrations) ? tracker.migrations : [];
  const migrationIds = [];
  for (const [index, migration] of migrations.entries()) {
    const mPath = `tracker.migrations[${index}]`;
    requireRule(h.plain(migration), mPath, "必须为对象");
    if (!h.plain(migration)) continue;
    requireRule(typeof migration.id === "string" && migration.id.trim(), `${mPath}.id`, "必须为非空 id");
    if (migration.id) {
      requireRule(!migrationIds.includes(migration.id), `${mPath}.id`, "migration id 不得重复");
      migrationIds.push(migration.id);
    }
    requireRule(typeof migration.targetEntityId === "string" && entityIds.includes(migration.targetEntityId), `${mPath}.targetEntityId`, "必须引用预设实体 id");
    requireRule(h.plain(migration.fieldMap), `${mPath}.fieldMap`, "必须为对象");
    if (h.plain(migration.fieldMap)) {
      for (const [legacyKey, localKey] of Object.entries(migration.fieldMap)) {
        requireRule(typeof legacyKey === "string" && typeof localKey === "string", `${mPath}.fieldMap`, "键值必须为字符串");
        const entity = initialEntities.find((e) => e.id === migration.targetEntityId);
        const tKeys = h.plain(templates[entity?.templateId]?.stateSchema) ? Object.keys(templates[entity.templateId].stateSchema) : [];
        requireRule(tKeys.includes(localKey), `${mPath}.fieldMap.${legacyKey}`, `目标 local key "${localKey}" 不在模板字段中`);
      }
    }
  }

  // 5. actions
  requireRule(Array.isArray(tracker?.actions) && tracker.actions.length >= 1, "tracker.actions", "必须声明至少 1 个动作（实体卡：查看状态 + 玩法动作）");

  // 6. 外层模板
  const template = typeof tracker?.template === "string" ? tracker.template.trim() : "";
  requireRule(/^<details(?:\s|>)/i.test(template), "tracker.template", "去除首尾空白后必须以 <details 开头");
  requireRule(/<\/details>$/i.test(template), "tracker.template", "必须以 </details> 结束，外部不得残留文字");
  requireRule(!/<!--\s*\/?panel\s*-->/i.test(template), "tracker.template", "不得包含 panel 标记");
  requireRule(!/```|TRACKER_UPDATE|\{\{\s*setvar|必须输出|请输出|不得编造|变量更新|状态栏三件套/i.test(template), "tracker.template", "不得包含围栏、更新宏或输出指令");
  // 混合卡：根 stateSchema 字段宏允许在外层；实体字段宏必须在 sectionTemplate 内
  const rootSchema = h.plain(tracker?.stateSchema) ? tracker.stateSchema : {};
  const rootKeys = Object.keys(rootSchema);
  let foundSection = false;
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const body = match[1].trim();
    const parsed = body.match(/^entitysections::\s*([A-Za-z0-9_-]+)$/);
    if (parsed) {
      foundSection = true;
      requireRule(templateIds.includes(parsed[1]), "tracker.template", `entitysections 引用未知模板 "${parsed[1]}"`);
      continue;
    }
    const fieldMacro = body.match(/^(getvar|gettitle|gettext|getcolor|getpercent|getnarrative)::\s*([A-Za-z0-9_-]+)$/);
    if (fieldMacro) {
      requireRule(rootKeys.includes(fieldMacro[2]), "tracker.template", `外层宏引用未知根字段 "${fieldMacro[2]}"（实体字段宏必须在 sectionTemplate 内）`);
    } else {
      requireRule(false, "tracker.template", `外层模板不允许裸宏 "{{${body}}}"`);
    }
  }
  // 实体卡必须有 entitysections；纯根字段卡（有根 schema 无模板实体引用）例外
  const hasRootOnly = rootKeys.length > 0 && !/entitysections/i.test(template);
  requireRule(foundSection || hasRootOnly, "tracker.template", "实体卡模板必须包含 {{entitysections::模板ID}}");

  // 7. uiHints.order（混合卡：与根字段集一致；单模板无根字段：与模板字段一致；
  //    多模板：仅需属于 discovery default 模板）
  const order = tracker?.uiHints?.order;
  if (rootKeys.length > 0) {
    if (order != null) {
      requireRule(Array.isArray(order) && exactKeySet(order, rootKeys), "tracker.uiHints.order", "混合卡 order 必须与根 stateSchema 字段集完全一致");
    }
  } else if (templateIds.length === 1) {
    const singleTKeys = Object.keys(templates[templateIds[0]].stateSchema || {});
    if (order != null) {
      requireRule(Array.isArray(order) && exactKeySet(order, singleTKeys), "tracker.uiHints.order", "单模板卡 order 必须与模板字段集完全一致");
    }
  } else {
    const defaultTemplateId = h.plain(tracker?.entityDiscovery)?.defaultTemplateId;
    if (order != null && defaultTemplateId && templates[defaultTemplateId]) {
      const defKeys = Object.keys(templates[defaultTemplateId].stateSchema || {});
      requireRule(Array.isArray(order) && exactKeySet(order, defKeys), "tracker.uiHints.order", "多模板卡 order 必须与 discovery 默认模板字段集一致（其余模板由 sectionTemplate 验序）");
    }
  }

  return { ok: h.errors.length === 0, errors: h.errors, kind: 'v2' };
}

// ---- 统一入口：按 schemaVersion 分流 ----
function verifyTrackerV76V77(card, options = {}) {
  const tracker = card?.data?.extensions?.tracker;
  if (!tracker || typeof tracker !== "object" || Array.isArray(tracker)) {
    const errors = ["data.extensions.tracker: 必须存在且为对象"];
    if (options.throwOnError) {
      const error = new Error(`Tracker 验证失败（${errors.length} 项）\n- ${errors.join("\n- ")}`);
      error.validationErrors = errors;
      throw error;
    }
    return { ok: false, errors, kind: 'invalid' };
  }
  let schemaVersion = 1;
  if (typeof tracker.schemaVersion === "number") {
    schemaVersion = tracker.schemaVersion;
  } else if (typeof tracker.schemaVersion === "string") {
    schemaVersion = parseInt(tracker.schemaVersion, 10);
    if (Number.isNaN(schemaVersion)) schemaVersion = 1;
  }
  const isV2 = schemaVersion >= 2;
  const result = isV2
    ? verifyEntityTrackerV2(tracker, options)
    : verifyStaticTrackerV1(tracker, options);
  if (!result.ok && options.throwOnError) {
    const error = new Error(
      `Tracker ${isV2 ? 'v89 实体卡' : 'v76/v77'} 验证失败（${result.errors.length} 项）\n- ${result.errors.join("\n- ")}`
    );
    error.validationErrors = result.errors;
    throw error;
  }
  return result;
}

module.exports = { verifyTrackerV76V77, verifyStaticTrackerV1, verifyEntityTrackerV2 };

// CLI 入口（0.6 候选提升门禁用）：直接运行本文件时读取角色卡 JSON 并验证
if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const cardPath = args.find((a) => !a.startsWith('--'));
  if (!cardPath) {
    console.error('用法: node scripts/verify_tracker_v76_v77.js <角色卡.json> [--story-terms=key=词1,词2 ...]');
    process.exit(2);
  }
  const storyTermsByField = {};
  for (const arg of args) {
    const m = /^--story-terms=([^=]+)=(.+)$/.exec(arg);
    if (m) storyTermsByField[m[1].trim()] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  }
  let card;
  try {
    card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  } catch (e) {
    console.error(`无法读取/解析角色卡 ${cardPath}: ${e.message}`);
    process.exit(2);
  }
  const result = verifyTrackerV76V77(card, { storyTermsByField, throwOnError: false });
  if (result.ok) {
    console.log(`✓ Tracker ${result.kind === 'v2' ? 'v89 实体卡' : 'v76/v77'} 验证通过`);
    process.exit(0);
  }
  console.error(`✗ Tracker ${result.kind === 'v2' ? 'v89 实体卡' : 'v76/v77'} 验证失败（${result.errors.length} 项）`);
  for (const err of result.errors) console.error('  - ' + err);
  process.exit(1);
}
