// verify_tracker_v76_v77.js — Tracker v76/v77 协议公共验证器（唯一权威实现）
// 所有生成脚本（写盘前）与验证脚本（读盘后）必须调用本模块，禁止各自实现规则
// 用法:
//   const { verifyTrackerV76V77 } = require('../lib/verify_tracker_v76_v77');
//   verifyTrackerV76V77(card, { storyTermsByField, throwOnError: false });
"use strict";

function verifyTrackerV76V77(card, options = {}) {
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

  const tracker = card?.data?.extensions?.tracker;
  requireRule(plain(tracker), "data.extensions.tracker", "必须存在且为对象");

  const schema = plain(tracker?.stateSchema) ? tracker.stateSchema : {};
  const fieldKeys = Object.keys(schema);
  const initial = plain(tracker?.initialState) ? tracker.initialState : {};
  const initialKeys = Object.keys(initial);

  requireRule(fieldKeys.length > 0, "tracker.stateSchema", "至少声明一个字段");
  requireRule(
    exactKeySet(initialKeys, fieldKeys),
    "tracker.initialState",
    "key 集合必须与 stateSchema 完全一致，且不得重复或遗漏"
  );

  for (const [key, field] of Object.entries(schema)) {
    const path = `tracker.stateSchema.${key}`;
    requireRule(plain(field), path, "字段声明必须为对象");
    if (!plain(field)) continue;

    requireRule(
      validStringArray(field.aliases),
      `${path}.aliases`,
      "必须是非空字符串数组"
    );
    requireRule(
      Array.isArray(field.aliases) && field.aliases.includes(field.label),
      `${path}.aliases`,
      `必须包含字段 label "${field.label}"`
    );
    requireRule(
      !own(field, "semanticHints"),
      `${path}.semanticHints`,
      "禁止位于字段顶层，必须移入 updatePolicy.semanticHints"
    );
    requireRule(own(initial, key), `tracker.initialState.${key}`, "缺少初始值");

    if (field.type === "number") {
      requireRule(Number.isFinite(field.min), `${path}.min`, "必须为有限数值");
      requireRule(Number.isFinite(field.max), `${path}.max`, "必须为有限数值");
      requireRule(field.min < field.max, path, "min 必须小于 max");
      requireRule(
        Number.isFinite(initial[key]) &&
          initial[key] >= field.min && initial[key] <= field.max,
        `tracker.initialState.${key}`,
        "必须为 min/max 范围内的数值"
      );

      const ranges = field.presentation?.ranges;
      requireRule(
        Array.isArray(ranges) && ranges.length > 0,
        `${path}.presentation.ranges`,
        "number 字段必须声明非空 ranges"
      );
      for (const [index, range] of (Array.isArray(ranges) ? ranges : []).entries()) {
        const rangePath = `${path}.presentation.ranges[${index}]`;
        requireRule(plain(range), rangePath, "必须为对象");
        // 标准格式 {gte, lt}（lt 可省略兜底），兼容 {min, max}
        const hasGteLt = Number.isFinite(range?.gte) &&
          (range.lt === undefined || Number.isFinite(range.lt));
        const hasMinMax = Number.isFinite(range?.min) && Number.isFinite(range?.max);
        requireRule(hasGteLt || hasMinMax, rangePath, "必须为 gte/lt（或 min/max）数值边界");
        if (hasGteLt && Number.isFinite(range.lt)) {
          requireRule(range.gte < range.lt, rangePath, "gte 必须小于 lt");
        }
        if (hasMinMax) {
          requireRule(range.min < range.max, rangePath, "min 必须小于 max");
        }
        requireRule(
          typeof range?.title === "string" && range.title.trim(),
          `${rangePath}.title`,
          "不能为空"
        );
        requireRule(
          typeof range?.text === "string" && range.text.trim(),
          `${rangePath}.text`,
          "不能为空"
        );
      }

      const policy = field.updatePolicy;
      requireRule(plain(policy), `${path}.updatePolicy`, "number 字段必须声明");
      const deltas = plain(policy?.qualitativeDeltas)
        ? policy.qualitativeDeltas
        : {};
      requireRule(
        Object.keys(deltas).length > 0,
        `${path}.updatePolicy.qualitativeDeltas`,
        "必须为非空对象"
      );
      for (const [term, delta] of Object.entries(deltas)) {
        requireRule(
          term.trim().length > 0 && Number.isFinite(delta) && delta !== 0,
          `${path}.updatePolicy.qualitativeDeltas.${term}`,
          "增量必须是非零有限数值"
        );
      }
      for (const term of genericDeltaTerms) {
        requireRule(
          own(deltas, term),
          `${path}.updatePolicy.qualitativeDeltas`,
          `缺少通用程度词 "${term}"`
        );
      }

      const storyTerms = storyTermsByField[key];
      // 生成脚本场景：storyTermsByField 必须显式提供（制卡者声明）
      // 通用验证脚本场景（storyTermsByField 缺省）：从 deltas 自动提取非通用词作为剧情词检查
      const autoStoryTerms = Object.keys(deltas).filter(
        (term) => !genericDeltaTerms.includes(term) && term.trim().length > 0
      );
      const effectiveStoryTerms = Array.isArray(storyTerms)
        ? storyTerms
        : autoStoryTerms;
      requireRule(
        validStringArray(effectiveStoryTerms) && effectiveStoryTerms.length >= 2,
        `storyTermsByField.${key}`,
        "每个 number 字段必须至少有两个本卡剧情词（生成时显式提供 storyTermsByField；通用验证时从 qualitativeDeltas 非通用词检查）"
      );
      for (const term of effectiveStoryTerms) {
        requireRule(
          !genericDeltaTerms.includes(term),
          `storyTermsByField.${key}`,
          `"${term}" 仍是通用程度词，不是本卡剧情词`
        );
        requireRule(
          own(deltas, term),
          `${path}.updatePolicy.qualitativeDeltas`,
          `缺少已声明剧情词 "${term}"`
        );
      }

      const hints = policy?.semanticHints;
      requireRule(
        plain(hints),
        `${path}.updatePolicy.semanticHints`,
        "必须存在且位于 updatePolicy 内"
      );
      requireRule(
        typeof hints?.meaning === "string" && hints.meaning.trim(),
        `${path}.updatePolicy.semanticHints.meaning`,
        "必须为非空字符串"
      );
      for (const name of [
        "positiveSignals",
        "negativeSignals",
        "neutralSignals"
      ]) {
        requireRule(
          validStringArray(hints?.[name]),
          `${path}.updatePolicy.semanticHints.${name}`,
          "必须是非空 JSON 字符串数组，禁止分隔字符串"
        );
      }
    } else if (field.type === "string") {
      requireRule(
        field.allowCustomValues === false,
        `${path}.allowCustomValues`,
        "有限枚举 string 字段必须严格等于 false"
      );
      const states = field.presentation?.states;
      requireRule(
        plain(states) && Object.keys(states).length > 0,
        `${path}.presentation.states`,
        "必须为非空对象"
      );

      for (const [stateKey, state] of Object.entries(plain(states) ? states : {})) {
        const statePath = `${path}.presentation.states.${stateKey}`;
        requireRule(plain(state), statePath, "必须为对象");
        requireRule(
          state?.title === stateKey,
          `${statePath}.title`,
          `必须与 states key "${stateKey}" 完全一致`
        );
        requireRule(
          Array.from(stateKey.trim()).length > 0 &&
            Array.from(stateKey.trim()).length <= maxStateTitleLength &&
            !/[\r\n]/.test(stateKey),
          statePath,
          `状态名必须为不超过 ${maxStateTitleLength} 字的短名`
        );
        requireRule(
          typeof state?.text === "string" && state.text.trim(),
          `${statePath}.text`,
          "必须为非空描述"
        );
      }

      requireRule(
        typeof initial[key] === "string" &&
          plain(states) && own(states, initial[key]),
        `tracker.initialState.${key}`,
        "必须精确命中 presentation.states 的 key"
      );
    } else {
      requireRule(false, `${path}.type`, "只允许 number 或 string");
    }
  }

  for (const key of Object.keys(storyTermsByField)) {
    requireRule(
      schema[key]?.type === "number",
      `storyTermsByField.${key}`,
      "只能引用已声明的 number 字段"
    );
  }

  requireRule(
    Array.isArray(tracker?.actions) && tracker.actions.length > 0,
    "tracker.actions",
    "必须为非空数组"
  );

  const order = tracker?.uiHints?.order;
  requireRule(
    Array.isArray(order) && exactKeySet(order, fieldKeys),
    "tracker.uiHints.order",
    "必须无重复，并与 stateSchema key 集合完全一致"
  );

  const template = typeof tracker?.template === "string"
    ? tracker.template.trim()
    : "";
  requireRule(
    /^<details(?:\s|>)/i.test(template),
    "tracker.template",
    "去除首尾空白后必须以 <details 开头"
  );
  requireRule(
    /<\/details>$/i.test(template),
    "tracker.template",
    "必须以 </details> 结束，外部不得残留文字"
  );
  requireRule(
    !/<!--\s*\/?panel\s*-->/i.test(template),
    "tracker.template",
    "不得包含 panel 标记"
  );
  requireRule(
    !/```|TRACKER_UPDATE|\{\{\s*setvar|必须输出|请输出|不得编造|变量更新|状态栏三件套/i.test(template),
    "tracker.template",
    "不得包含围栏、更新宏或输出指令"
  );

  const macros = [];
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const parsed = match[1].match(
      /^(getvar|gettitle|gettext|getcolor|getpercent|getnarrative)::\s*([A-Za-z0-9_-]+)$/
    );
    requireRule(
      Boolean(parsed),
      "tracker.template",
      `非法或无 ::key 的裸宏 "{{${match[1]}}}"`
    );
    if (parsed) {
      macros.push({ name: parsed[1], key: parsed[2] });
      requireRule(
        fieldKeys.includes(parsed[2]),
        "tracker.template",
        `宏引用未知字段 "${parsed[2]}"`
      );
    }
  }

  for (const [key, field] of Object.entries(schema)) {
    requireRule(
      macros.some((macro) => macro.name === "getvar" && macro.key === key),
      "tracker.template",
      `字段 "${key}" 缺少 {{getvar::${key}}}`
    );
    const descriptionMacro =
      field.type === "number" ? "getnarrative" : "gettext";
    requireRule(
      macros.some(
        (macro) => macro.name === descriptionMacro && macro.key === key
      ),
      "tracker.template",
      `字段 "${key}" 缺少 {{${descriptionMacro}::${key}}}`
    );
  }

  const result = { ok: errors.length === 0, errors };
  if (!result.ok && throwOnError) {
    const error = new Error(
      `Tracker v76/v77 验证失败（${errors.length} 项）\n- ${errors.join("\n- ")}`
    );
    error.validationErrors = errors;
    throw error;
  }
  return result;
}

module.exports = { verifyTrackerV76V77 };
