// verify_tracker_v76_v77.js 的 v1/v2 分流回归测试
// 用法: node scripts/test_verify_v2.js  （退出码 0=全过 1=有失败）
const { verifyTrackerV76V77, verifyEntityTrackerV2 } = require('./verify_tracker_v76_v77');

const baseCard = {
  data: {
    extensions: {
      tracker: {
        schemaVersion: 2,
        entityTemplates: {
          tpl: {
            label: '测试模板',
            defaultState: { energy: 0 },
            stateSchema: {
              energy: {
                type: 'number', label: '体力', min: 0, max: 100,
                presentation: { ranges: [
                  { gte: 0, lt: 50, title: '低', color: '#000', text: '低体力' },
                  { gte: 50, lt: 100, title: '中', color: '#000', text: '中体力' },
                  { gte: 100, title: '满', color: '#000', text: '满体力' },
                ]},
                updatePolicy: {
                  mode: 'conservative',
                  qualitativeDeltas: { 一点: 1, 稍微: 2, 明显: 5, 大幅: 10, 修炼: 3 },
                  semanticHints: {
                    meaning: '该角色体力。',
                    positiveSignals: ['修炼'],
                    negativeSignals: ['受伤'],
                    neutralSignals: ['闲聊'],
                  },
                },
                aliases: ['体力'],
              },
            },
            sectionTemplate: '<section><h4>{{entityname}}</h4><div>{{getvar::energy}} {{getnarrative::energy}}</div></section>',
          },
        },
        initialEntities: [
          { id: 'e1', displayName: '角色一', aliases: [], templateId: 'tpl', initialState: { energy: 30 } },
        ],
        entityDiscovery: { enabled: true, defaultTemplateId: 'tpl', maxAutoEntities: 24 },
        migrations: [
          { id: 'm1', targetEntityId: 'e1', fieldMap: { legacy_energy: 'energy' } },
        ],
        template: '<details><summary>状态</summary>{{entitysections::tpl}}</details>',
        actions: [{ id: 'view', label: '查看状态', prompt: '查看' }],
        uiHints: { order: ['energy'] },
      },
    },
  },
};

let pass = 0, fail = 0;
function expectOk(name, card, shouldPass) {
  const r = verifyTrackerV76V77(card, { throwOnError: false });
  const ok = r.ok === shouldPass;
  if (ok) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}: 期望 ${shouldPass ? '通过' : '失败'}，实际 ${r.ok ? '通过' : '失败'}`); if (!r.ok) console.log('    ' + r.errors.slice(0, 3).join('\n    ')); }
}
function clone() { return JSON.parse(JSON.stringify(baseCard)); }

// 正例
expectOk('v2 合法卡通过', clone(), true);

// v2 负例
{
  const c = clone(); delete c.data.extensions.tracker.entityTemplates;
  expectOk('缺 entityTemplates → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.initialEntities[0].id = 'bad.id';
  expectOk('预设 id 含点号 → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.initialEntities.push({ id: 'e1', displayName: '重复', templateId: 'tpl' });
  expectOk('预设 id 重复 → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.initialEntities[0].initialState = { unknown_key: 5 };
  expectOk('override 用未知 key → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.entityDiscovery.defaultTemplateId = 'nope';
  expectOk('discovery 引用未知模板 → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.entityDiscovery.maxAutoEntities = 999;
  expectOk('discovery 上限越界 → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.migrations[0].targetEntityId = 'ghost';
  expectOk('migration 目标非预设 → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.migrations[0].fieldMap = { legacy_energy: 'nope' };
  expectOk('migration 目标 local key 不存在 → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.template = '<details><summary>状态</summary>{{getvar::energy}}</details>';
  expectOk('外层模板裸 getvar（无 entitysections）→ 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.template = '<details><summary>状态</summary>{{entitysections::nope}}</details>';
  expectOk('entitysections 引用未知模板 → 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.entityTemplates.tpl.sectionTemplate = '<section>{{getvar::nope}}</section>';
  expectOk('sectionTemplate 越权宏（模板外字段）→ 失败', c, false);
}
{
  const c = clone(); c.data.extensions.tracker.schemaVersion = '2';
  expectOk('字符串 schemaVersion "2" 也走 v2 → 通过', c, true);
}
{
  const c = clone(); c.data.extensions.tracker.schemaVersion = '1.0';
  expectOk('字符串 "1.0" 走 v1（缺根 schema → 失败）', c, false);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
