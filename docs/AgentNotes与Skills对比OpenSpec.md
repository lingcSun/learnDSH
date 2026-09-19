# Agent Notes、Skills 与 OpenSpec 对比

> 信息来源：DSH 侧基于 deepseek-harness 源码 `fb2c4b9e`（2026-09-10，详见 [DeepSeek-Harness-设计沉淀](DeepSeek-Harness-设计沉淀.md)）；OpenSpec 侧基于官方仓库 [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) main 分支 README 及文档（检索日期 2026-09-19）。OpenSpec 迭代较快，细节以其源码为准。

## 0. 一句话定位

| | DSH Agent Notes | DSH Skills | OpenSpec |
|---|---|---|---|
| **回答的问题** | 为什么这么定（决策的理由） | 这类活怎么干（流程与标准） | 接下来建什么（需求与验收） |
| **本质** | RFC/ADR 式决策档案 | 可复用工作流封装 | 需求变更的"提案→实施→归档"流水线 |
| **载体** | 单篇 markdown，路径编码状态 | SKILL.md + references/scripts | 一个 change 目录（proposal / specs / design / tasks 四件套） |

**核心结论：三者不是竞品，各自把一种失败模式挡在不同阶段**——OpenSpec 挡在写代码之前（先对齐 what），Agent Notes 挡在重新争论之前（固化 why），Skills 挡在执行走样之前（标准化 how）。可以同时使用，各自占据一层。

## 1. OpenSpec 速览

OpenSpec 是 Fission-AI 开源的轻量级 SDD（spec-driven development）框架（npm 包 `@fission-ai/openspec`，MIT），给 25~30 种 AI 编码助手加一层"规格层"：人和 AI 在写代码之前先就规格达成一致。官方哲学：fluid not rigid（流动而非僵化）、iterative not waterfall（迭代而非瀑布）、为 brownfield（存量项目）而生、从个人项目到企业可伸缩。

**目录结构**（`openspec init` 生成）：

```
openspec/
├── project.md              # 项目约定
├── specs/                  # 每个能力一份 spec.md —— 需求的"当前真值"
└── changes/
    ├── <change-id>/        # 在途变更（四件套）
    │   ├── proposal.md     # 为什么做、改什么
    │   ├── specs/          # 需求增量（delta）：ADDED / MODIFIED / REMOVED Requirements
    │   ├── design.md       # 技术方案
    │   └── tasks.md        # 实施清单（编号勾选项）
    └── archive/            # 归档：日期前缀（如 2025-01-23-add-dark-mode/）
```

**需求写法**是普通 markdown 的 SHALL + WHEN/THEN 场景：

```markdown
## ADDED Requirements
### Requirement: Theme selection
The app SHALL let users switch between light and dark themes.

#### Scenario: User toggles dark mode
- **WHEN** the user clicks the theme toggle
- **THEN** the app switches to dark mode and persists the choice
```

**工作流**：`/opsx:explore`（无风险探索方案）→ `/opsx:propose`（生成 change 四件套，人审核）→ `/opsx:apply`（按 tasks 实施）→ `/opsx:archive`（**delta 合并进 `specs/` 真值**，change 移入 archive/）。扩展档位还有 new / continue / ff / verify / bulk-archive 等命令。集成方式是 `openspec init / update` 向各工具写入 slash 命令和 agent 指引（含 AGENTS.md 提示块）；CLI 提供 validate 做结构校验。跨仓库协作场景有 Stores（beta）：把 `openspec/` 形状放进独立仓库，团队共享一份需求真值。

## 2. 逐维度对比

| 维度 | Agent Notes | Skills | OpenSpec |
|---|---|---|---|
| 针对的失败模式 | re-litigation：对已决事项反复争论 | 同类任务每次重想、执行走样 | 需求只活在聊天记录里，AI 拿模糊 prompt 乱写 |
| 记录单元 | 一篇 note = 一个决策 | 一个 SKILL.md = 一类任务 | 一个 change = 一次能力变更（多文件） |
| 内容重心 | rationale、被否方案、后果、验证 | 步骤、判断标准、校准样例、收尾要跑的 gate | 需求（SHALL）+ 场景（WHEN/THEN）+ 任务清单 |
| 生命周期 | proposed → implemented / rejected → archived；**状态编码在路径里**，文件移动即状态迁移，gate 校验 Status 行与目录一致 | 无生命周期（长期稳定的流程知识） | draft → apply → archive；目录移动 + delta 合并，CLI 辅助 |
| "当前真值" | 代码 + docs 是真值；implemented note 只跟随现实同步事实 | 无真值概念，只有做法 | **`specs/` 显式维护需求真值**，archive 时由 delta 合并演进——三者中最独特的设计 |
| 强制机制 | 仓库内 gate（`verify-agent-note-format` 等，进 doc-sync/CI），且要求"证明能拒绝坏案例" | 无强制，靠 description 触发匹配 + 自律；出口指向 gate | `openspec validate`（结构校验，可选执行）+ 工作流指引，强制力靠纪律 |
| 入口/触发方式 | 规则驱动：AGENTS.md 规定"非平凡变更必须同 PR 带 note" | 模型按 description 语义匹配自动调用 | 人或 agent 显式敲 slash 命令发起 |
| 结构自由度 | 骨架强制：章节名闭集、头三行固定 | frontmatter 仅 name/description，正文自由 | 四件套固定，各文件内部自由 |
| 历史处理 | `archived/` 封存：append-only 哈希清单，封存后永不编辑 | 不适用 | `changes/archive/` 日期前缀留存，无防篡改机制 |
| 多语言 | 强制 `.zh.md` 逐节镜像 + sidecar 一致性 | 无 | 无 |
| 适用规模 | 大型仓库、多 agent 长期协作 | 任意 | 个人到企业，可跨仓库（Stores） |

## 3. 关键差异深挖

### 3.1 What / Why / How：三层互补，不是三选一

OpenSpec 的 spec 是**需求合同**（系统应当怎样），归档后长期留在 `specs/` 生效——它在 DSH 的分层里对应的其实是 README/subsystems 的"产品契约"层，**不是** Agent Notes 层。Agent Note 是**决策档案**（为什么这样而不是那样）；OpenSpec 的 proposal.md 虽然也写 why，但归档的重心是"真值合并进 specs"，why 不作为长期资产被刻意保存——DSH 恰好相反：**why 是一等公民**，note 永久保存理由与被否方案，明说目标是"防止 re-litigation"。Skills 则是**执行程序**，与两者正交；OpenSpec 的 slash 命令模板其实也扮演了流程封装的角色（部分工具里这些命令就是以 skill 形式安装的），但没有 DSH Skills 那套"用校准样例传达判断尺度"的传统。

### 3.2 真值管理：需求真值 vs 事实真值 vs 无真值

OpenSpec 最值得单独看的设计是**活的需求真值**：`specs/` 随每次 archive 自动演进。DSH 明确不走这条路——它认为代码和文档才是真值，note 只是跟随者（implemented note 的"事实同步"规则），并在归档时干脆把历史**冻结**而非合并。两种取舍各有代价：需求真值会腐化（代码改了 spec 没人跟），OpenSpec 靠"每次变更都必须走 change 流程"的纪律维持；DSH 靠"docs accompany every code change" + gate 强制。冻结档案则永不腐化，但也永不更新——所以 DSH 要求归档判据是"rationale 不再指导未来工作"。

### 3.3 强制力与灵活性成反比

强制力光谱：**DSH gate（CI 强制、证明拒绝坏案例）> OpenSpec validate（本地结构校验，跑不跑随你）> Skills（纯自律）**。灵活性正好倒过来：OpenSpec 最 fluid（官方哲学第一条，任何 artifact 随时改、无阶段门），DSH notes 最严格（章节名闭集、格式 gate、supersession 检查）。这背后是定位差异：OpenSpec 是要"伺候 30 种工具"的通用框架，约定只能软；DSH 是自家仓库，约定可以硬到进 CI。

### 3.4 粒度与开销方向相反

OpenSpec 的开销**前置**：再小的特性也要四件套，换来实施前的人机对齐（"Agree before you build"）。Agent Note 的开销**后置**：一篇两三百词的短文随 PR 交付。对个人项目或小改动，四件套明显偏重；对跨团队、跨仓库的需求对齐，一篇 note 又远不够。粒度选择本质上取决于"错方向的代价"：代价越大，越值得前置 OpenSpec 式的提案对齐。

## 4. 对本仓库实践的启示

我们已经有的：根 AGENTS.md（分层规则）、输出约定 + md2html（约定配工具）。

- **可借 OpenSpec**：① `learnDSH/` 里做稍大的模仿练习（比如实现一个 capability seam）之前，先写简化版 change——`proposal.md` + `tasks.md` 两件套即可，design/spec delta 视情况加；② 用 WHEN/THEN 场景写验收标准，比"完成 XX 功能"可检验得多；③ 任务清单用编号勾选项（tasks.md 风格），agent 执行时可逐项核对。
- **可借 Agent Notes**：① 决策必须带 `## Alternatives considered`——整套体系性价比最高的一条；② "改决策 = 开新记录 + 互链，不重写旧的"；③ 状态编码在路径里（目录即数据库）。
- **Skills 的启示**：重复执行两次以上的流程就该固化。比如"沉淀文档"本身（写 md → `python scripts/md2html.py` → commit → push）已经重复多次，可以写成一条 skill / slash 命令。
- **选型口诀**：需求不明、方向风险大 → OpenSpec 式提案先行；方案已定、理由要留 → Agent Note 式决策记录；同类任务反复做 → Skill 化。三者不互斥。

## 附：参考来源

- DSH：`.agents/notes/README.md`、`.agents/skills/*/SKILL.md`、`scripts/agent-note-tree.ts` 等（路径见[设计沉淀](DeepSeek-Harness-设计沉淀.md)文末导航）
- OpenSpec：[GitHub 仓库](https://github.com/Fission-AI/OpenSpec)（README，2026-09-19 检索）、[npm 包](https://www.npmjs.com/package/@fission-ai/openspec)
- 同类参照：OpenSpec README 自身的对比对象 [github/spec-kit](https://github.com/github/spec-kit)（更重、阶段门更 rigid）与 [Kiro](https://kiro.dev)（IDE 绑定）
