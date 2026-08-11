# character-card-creator

引导式角色卡创建助手 + JSON 生成器（ZCode 技能）。

通过问答引导用户完善角色设定，最终输出 **Chara Card V2 兼容** JSON 角色卡文件，兼容 RisuAI / SillyTavern / 类脑等主流 AI 角色卡平台；可选支持 [LnnLore](https://github.com/xyy1124/LnnLore)（PocketInn 特别版）的 tracker 状态协议扩展。

> 本仓库为**公共开源版**：已移除 NSFW/成人向特化内容与个人定制流程、个人标识信息，可直接用于任何题材的角色卡制作。

## 功能特性

- 引导式问答完善角色设定（角色定位 / 世界观 / 关系 / 场景）
- **工作流总控（Agent 协议）**：模式判定（create/modify/restore/imitate）、验收 profile、run.json 运行状态、候选文件 + 脚本验证才提升、有界返工循环、子智能体限定审查
- **执行工具 `scripts/card_agent.js`**：init/record/verify/promote/report 五子命令，run.json 状态管理 + 验证门禁（JSON 合法性 / tracker v76/v77 / PHI v71 / 内部引用泄漏）+ 候选提升全自动
- 输出合法 Chara Card V2 JSON（`spec: "chara_card_v2"`）
- 配套世界书（Lorebook）设计与双格式输出（CCv2 内嵌 + SillyTavern 原生格式）
- 世界书优先级与调度方法论（order / position / 触发词 / 预算截断）
- 去 AI 感写作约束、仿造模式（聊天记录 → 角色卡规律提取）
- 写作特化世界书（基于聊天记录的角色专属行为规则）
- **LnnLore tracker 状态协议扩展**（可选）：状态字段声明、presentation 阶段描述、updatePolicy + semanticHints、ST 三件套兼容、v76/v77 协议门禁与公共验证器

## 目录结构

```
character-card-creator/
├── SKILL.md                              ← 技能主体（ZCode 技能格式）
├── scripts/
│   ├── card_agent.js                     ← 工作流执行工具（init/record/verify/promote/report）
│   └── verify_tracker_v76_v77.js         ← tracker 公共验证器（v76/v77 协议，含 CLI 门禁）
├── README.md
└── LICENSE
```

## 安装（ZCode）

将本仓库 `SKILL.md` 所在目录复制到用户技能目录：

```powershell
Copy-Item -Recurse "character-card-creator" "$env:USERPROFILE\.zcode\skills\character-card-creator"
```

在 ZCode 中通过 `/character-card-creator` 调用；或直接对话描述创建角色卡需求，技能会自动触发。

## 与 LnnLore 的关系

[LnnLore](https://github.com/xyy1124/LnnLore)（PocketInn 特别版）是一个基于 Flutter 的 AI 聊天应用，实现了角色卡 `data.extensions.tracker` 的运行时（状态解析、校验、持久化与渲染）。

本技能的 tracker 协议部分（第七节）即为该应用的状态协议规范：

- App 端实现：`LnnLore` 仓库源码
- 协议验证器：本仓库 `scripts/verify_tracker_v76_v77.js`（生成/校验角色卡 tracker 时调用）
- SillyTavern 等平台可用「ST 三件套」（变量宏 / 正则 / Quick Replies）实现同等效果

## 脱敏声明

- 不含任何 NSFW/成人向特化内容（写作技法库、题材引导、内容注入规则等均已移除）
- 不含任何个人定制流程与个人标识信息
- 所有示例字段均为通用占位（如好感度、所在地）

## 许可证

[MIT](LICENSE)
