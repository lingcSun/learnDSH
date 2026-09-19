# DeepSeek Harness 设计沉淀：AGENTS.md 体系、Agent Notes 与 Gate 脚本

> 基于 deepseek-harness 源码 `fb2c4b9e`（2026-09-10，0.1.5-rc.2 附近）整理。上游更新较快，细节以源码为准；源码在本目录 `deepseek-harness/` 下（只读参考）。
>
> 说明：问题里的 "agent.md" 实为 **`AGENTS.md`**，".agent 目录" 实为 **`.agents/`**。本文所有路径均相对 `deepseek-harness/` 仓库根。

## 0. 总览：三层分工

一个长期由 agent（和人）协作开发的复杂仓库，有三对核心矛盾：上下文有限（规则不能全塞给每届会话）、决策会被遗忘（代码和文档承载不了"为什么"）、约定会漂移（口头约定没有强制力）。DSH 用三层载体分别解决：

| 层 | 载体 | 回答的问题 | 关键特征 |
|---|---|---|---|
| **常备指令** | `AGENTS.md`（分层分布，全仓约 22 份） | 每届会话必须知道什么 | 有字数预算；每条规则 1~3 行并链接到理由的"家" |
| **决策档案** | `.agents/notes/`（Agent Notes） | 当时为什么这么决定、放弃了什么 | RFC/ADR 式；状态编码在路径里；强制记录被否方案 |
| **机械门禁** | `scripts/`（gates and generators） | 约定如何保证不漂移 | 不变量全部进可执行 gate；gate 必须能拒绝坏案例 |

配套的第四个组件是 `.agents/skills/`（技能）：把"何时做、按什么标准做、如何校验"的工作流封装成可复用单元，供 agent 按需加载。

一句话概括：**规则放在 AGENTS.md，理由放进 Agent Note，执行交给 Gate 脚本**。

```
                 ┌─────────────────────────────┐
   每届会话载入 → │ AGENTS.md（规则，短，有预算） │──链接──┐
                 └─────────────────────────────┘        │ 指向理由
                 ┌─────────────────────────────┐        ↓
   按需查阅     │ .agents/notes/（决策+理由档案）│←──  互链
                 └─────────────────────────────┘        ↑
                 ┌─────────────────────────────┐        │ 校验两者
   CI/本地执行 → │ scripts/（gate 脚本+spec）    │────────┘
                 └─────────────────────────────┘
```

---

## 1. AGENTS.md 体系：分层的常备指令

### 1.1 分布与分层

AGENTS.md 不只在根目录，而是沿目录树分布（根、`packages/`、`docs/`、`scripts/`、`.agents/notes/`、`snapshots/`、`vendor/`、`website/` 等，另有个别子包如 `packages/client/`）。`docs/AGENTS.md` 里的 tier 表定义了分层职责：

- **根 `AGENTS.md`**：standing orders——每届会话都需要在上下文里的规则，每条 1~3 行，只放"常备命令"，其余（故事、示例、流程细节）禁止放。
- **子树 `AGENTS.md`**：只放该子树特有的指令，不放根文件已覆盖的规则。
- **`CLAUDE.md` 是 `AGENTS.md` 的符号链接**（根和 `packages/` 两处）：单一来源，同时服务多个 agent 产品；要改就改真身 `AGENTS.md`。

### 1.2 根 AGENTS.md 的内容结构

以根文件为例，段落依次是：仓库布局（注释式目录地图）→ 命令清单 → 沙箱失败处理 → Secrets → Conventions（约 30 条一句话规则）→ 防御性模式 / 类型与文档规范 → "如何编辑这份指令本身"。两个最值得学的特征：

**每条规则自带 rationale 链接。** 一条规则只有一两行正文，括号里链接到拥有它的文档或 Agent Note，例如：

```markdown
- **No hardcoded tunables in plugins**: deployment-varying choices are validated
  `Config` fields changeable from cordis.yml; ...
- **Non-trivial changes MUST include an Agent Note in the same PR**
  ([scope](.agents/notes/README.md#when-to-write-one)).
```

规则因此可以极短——"是什么"在上下文里，"为什么"按需跳转。这就是 *"one home per fact"*（每个事实只有一个家，其他地方一律链接）。

**指令本身有字数预算，且被 gate 强制。** `verify-doc-budgets`（预算清单在 `scripts/doc-budgets.manifest.json`）规定根 AGENTS.md ≤ 1,950 词、子树 AGENTS.md ≤ 600 词。超了只能：先"搬走"（内容属于别的 tier）、再"压缩"、确实需要才在 PR 里说明并上调上限。**上下文是稀缺资源是硬约束，不是口号**——它直接写进了可执行的检查里。

### 1.3 设计意图

- 分层 + 预算解决"上下文有限"：会话只常备最短规则集，细节靠链接按需加载。
- 规则与理由分离解决"规则膨胀"：理由不挤占上下文，但永不丢失。
- 子树自治（每个目录自己的 AGENTS.md）让规则靠近被规则约束的代码，且不污染全局。

---

## 2. Agent Notes：agent 写的 RFC/ADR

### 2.1 定位

`.agents/notes/AGENTS.md` 的定义只有一句核心话：

> Agent Notes are effectively RFCs written by agents: durable proposals and decision records that preserve rationale, alternatives, consequences, and required verification.

即：**agent 写给未来的 agent（和人）的决策记录**，保存的是代码和文档都承载不了的部分——动机（why）、被放弃的备选方案、后果、以及当时承诺过的验证方式。强制纪律是：**每个非平凡变更必须在同一个 PR 里新增或更新至少一篇 Agent Note**；只有纯机械/局部改动豁免。

### 2.2 路径即状态：双轴编码

每篇 note 的路径就是它的全部元数据：`{lifecycle}/{class}/yyyy-mm-dd-topic.md`。

```
.agents/notes/
├── AGENTS.md                  # notes 自身的规则入口（很短，只讲 supersession 与归档）
├── README.md / .zh.md         # Agent Note 完整规范
├── proposed/                  # 提案：尚未（或只部分）实现
│   ├── architecture/  bug-fix/  feature/  process/  testing/
├── implemented/               # 决策已落地（自身还有一份 AGENTS.md 补充规则）
├── rejected/                  # 已否决（正文冻结，结论写在 Status 行）
└── archived/                  # 归档区：封存的历史快照，永不编辑
```

- **lifecycle（顶层目录）= 生命周期状态**：`proposed` → `implemented` 或 `rejected`；低价值的 `implemented` 老记录移入 `archived/`。文件在目录间移动 = 状态迁移，必须同一变更内改写 `Status:` 行并满足目标目录的骨架，gate 校验两者一致。
- **class（子目录）= 决策类型闭集**：`feature / bug-fix / simplification / architecture / process / testing`。闭集定义在 `scripts/agent-note-tree.ts`，分类 gate 拒绝任何其他目录；**加一个类必须同时改代码和 README**——刻意让"扩类"成为慎重动作。规范还解释了为什么没有 `refactor`：它与 `simplification` 的判别式（"可观察行为是否改变？"）重叠。
- **文件名日期 = 主题首次提出的时间**（以 git 历史为准），其余时间信息都交给 git，Status 行不带日期。

这套"路径即状态机"的好处：文件系统本身就是数据库，`walk` 一遍目录就是一次校验；状态一目了然，无需额外的索引机制。

### 2.3 文件格式：骨架随生命周期变化

每篇 note 的头三行固定：

```markdown
# Agent Note: <title>

Status: proposed   |   Status: implemented   |   Status: rejected — <一行理由>
```

正文以 `## Problem` 开头（动机必须独立于方案可读），其余章节按 lifecycle 有规定骨架（`verify-agent-note-format.ts` 属于 `doc-sync` gate 的一部分）：

| lifecycle | 骨架 | 要求 |
|---|---|---|
| `proposed/` | Problem / **Proposal** / Alternatives considered / Acceptance criteria / Risks | 可以谈计划、迁移步骤、open questions |
| `implemented/` | Problem / **Decision** / Alternatives considered / Consequences | 现在时描述已落地现实；`## Proposal`、`## Plan`、`## Acceptance criteria` 等 spec 语言被 gate **拒绝**（防止"永远在讲计划"的文档腐坏） |
| `rejected/` | 冻结的 proposal 原文 | 结论只写在 `Status:` 行——"被否的理由是读者唯一来看的事实" |

**`## Alternatives considered` 强制存在**，规范里给了理由，这句值得单独记：

> A decision recorded without what it beat invites re-litigation — the failure Agent Notes exist to prevent.
> （不记录决策打败了谁，就会有人重新争论它——这正是 Agent Note 要防止的失败。）

真实样例（`implemented/architecture/2026-06-11-event-sourced-sessions.md`，仅 260 词）：Problem 一句话 → Decision 三段（事件溯源 + 派生消息历史 + 追加时序契约）→ Alternatives considered 一段（"可变消息数组为什么输了"）→ Consequences 四条（保证、代价、扩展性、缓解方案）。**短而完整：决策、代价、被否方案、验证全部在场。**

### 2.4 生命周期治理：取代、归档、删除

这是整套体系最有特色的部分：

- **每篇新 note 触发 supersession 检查**：检索活跃树里覆盖同一决策的旧 note；完全取代 → 走 consolidation 规则（新主人吸收旧 note 的每一条独有 rationale 后删除旧件并修复所有入链）；部分取代 → 两篇互链保活。**不许把旧 note 就地改写成相反决策**——改决策 = 新 note + 互链。
- **`implemented/` 的 note 保持与现实同步**（`implemented/AGENTS.md`）：代码改了路径/包名/默认值，note 在同一变更内更新事实——但这只是事实性跟新，**不是改写决策的许可**。
- **归档 = 封存而非删除**（`dsh-archive-agent-notes` 技能 + `verify-archived-agent-notes.ts`）：完整三件套（英文 + `.zh.md` 中文对照 + `.i18n.yaml` sidecar）整体移入 `archived/`，正文零改动，只插入一行 `Archived: YYYY-MM-DD`，sidecar 重新记录哈希，进 **append-only 的封存清单**（先证明所有旧封存未被篡改，再追加新条目）。此后永不编辑——历史快照不是现行权威。
- **归档判据是语义的，不是机械的**：按"未来决策价值"判断（rationale、负面保证、安全规则、重引入条件是否还会指导未来工作），明确禁止按字数/年龄/配额归档；技能里给了一组**校准样例**（533 词该归档，248 词该保留——"长度不是标准"）。
- **rejected 的保留条件**：只有当这篇否决记录还能阻止一个"诱人的、有意义的错误"时才保留，否则整个三件套删除。
- **禁止中央索引**：`agent-note-tree.ts` 里对 `INDEX.md` 直接报错（"centralized Agent Note indexes are forbidden; browse the lifecycle/class tree or search the repository"）。理由：活跃树本身就是工作清单，再加索引必然双份维护并漂移。

### 2.5 双语契约

每篇 note 是 `foo.md` + `foo.zh.md`（逐节镜像）+ `foo.i18n.yaml`（一致性 sidecar）三件套；机器检查的 header token（`# Agent Note: ` 和 `Status:` 行）在中文版里保持英文原样。配对一致性由专门的 pairing gate 负责。

---

## 3. `.agents/skills/`：把工作流封装成技能

`skills/` 下 12 个技能（`dsh-archive-agent-notes`、`dsh-pre-push-checks`、`dsh-code-review`、`dsh-doc`、`dsh-prose-standard`、`dsh-ci-test-reliability`、`dsh-find-simplifications`、`dsh-translate-docs` 等），每个一个目录 + `SKILL.md`（frontmatter 只有 `name` 和触发时机导向的 `description`），可带 `references/`、`templates/`、`scripts/`。

设计要点：

- **技能承载"流程知识"而非"产品契约"**：产品/运行时契约归 docs 和源码，技能只固化"这类工作该怎么做、按什么标准校验"（这条边界写在 `docs/AGENTS.md` 的 tier 表里）。
- **判断标准用校准样例传达，不用阈值**：如归档技能里的" calibrated examples"——每个例子给出字数与裁决，示范"语义优先于字数"。
- **技能与 gate 互相引用**：技能末尾固定一节"Validate and report"，指明要跑哪些 gate（`pnpm run doc-sync`、`git diff --check`……）以及报告格式——流程的出口永远是可执行校验。

---

## 4. `scripts/`：Gates and Generators——约定的机械化

根 AGENTS.md 给 `scripts/` 的定位就四个词：**gates and generators**。它把前两层（AGENTS.md 的规则、Agent Notes 的纪律）里所有"可机械检查"的部分变成可执行程序。

### 4.1 与 notes 体系直接相关的 gate

| 脚本 | 职责 |
|---|---|
| `scripts/agent-note-tree.ts` | notes 树的结构事实来源：lifecycle/class **闭集**、目录深度与文件名正则、walk 返回全部违规；**`INDEX.md` 直接判死** |
| `scripts/verify-agent-note-format.ts` | 单篇 note 格式：头三行、Status 与所在目录互查、各 lifecycle 骨架、implemented 禁用 spec 语言、Alternatives considered 强制 |
| `scripts/verify-archived-agent-notes.ts` | 归档封存：闭集树、完整三件套、归档元数据、sidecar 哈希、**append-only 冻结内容清单** |
| `scripts/run-gates.ts` | gate 聚合器（`pnpm run doc-sync` 的叶子清单） |
| `scripts/doc-budgets.manifest.json` + `verify-doc-budgets` | 文档字数预算 |

每个脚本都有同目录同名 `.spec.ts`（`scripts/AGENTS.md` 要求 spec 在 forked worker 里与全套件并行跑，"只在单跑时通过的 spec 就是缺陷"）。

### 4.2 gate 的设计原则

`scripts/AGENTS.md` 和根 AGENTS.md 各给出几条，合起来看：

- **不变量必须进 gate，且 gate 必须自证**："Wire mechanically checkable invariants into an executed top-level gate and prove each changed acceptance path rejects an invalid case"——不仅要检查，还要证明每个新接入的校验路径**真的拒绝过一个坏案例**。
- **禁用窄例外优于全局关闭规则**（"Use narrow, justified exceptions instead of disabling a rule globally"）。
- gate 自身工程化：不经过 shell 调 pnpm、glob 路径归一化、平台适配只留在需要它的 gate、语法感知的源发现、防空语料/被收窄语料的护栏。
- **规范与执行互为镜像**：README 写"class 是闭集，加类需同时改 README 和本文件"，`agent-note-tree.ts` 顶注释同样声明"closed under `.agents/notes/README.md`"——两处互指，改一处必然让 gate 变红提醒你改另一处。

---

## 5. 设计哲学提炼

1. **三层分工，各答一问**：规则（AGENTS.md）答"要做什么"，note 答"为什么这么做"，gate 答"怎么保证一直如此"。任何一层单独存在都会失败：只有规则会漂移，只有档案没人看，只有 gate 没有判断力。
2. **Rationale 是一等公民**。整套体系最独特之处是把"防止 re-litigation"（防止对已决事项的反复争论）当作明确目标，为此强制记录被否方案、否决理由、重引入条件。
3. **路径即状态，目录即数据库**。lifecycle/class/date 全部编码在路径里，walk 即校验，无需额外元数据存储。
4. **One home per fact**。每个事实只有一个"家"，其余全是链接；层次表（tier taxonomy）规定每类事实属于哪一层。
5. **上下文经济学是硬约束**。根指令 ≤1,950 词、子树 ≤600 词，用 gate 而不是自觉来保证——因为每届会话都要载入这些内容。
6. **冻结历史，而非改写历史**。归档 append-only + 哈希封存；改决策 = 新 note + 互链。"现在的文档描述现状，历史只活在 note/commit/postmortem 里"。
7. **闭集 + 显式扩展**。类型、事件、note 分类都做成闭集，扩集要求同时更新代码与规范两处，由 gate 强制同步。
8. **语义校准优于机械阈值**。归档/删除按"未来决策价值"判断，明说字数、年龄、配额都不是标准，用校准样例传达尺度——这是 gate（机械）与技能（语义）的分工边界。
9. **gate 与技能是一对**：gate 管不变量（能自动判对错），技能管流程与判断（何时做、按什么标准做、边界情况怎么裁量），技能的收尾永远是"去跑这些 gate"。

---

## 6. 对我们自己实践的启示

在 `learnDSH/`（模仿实现）和 `plugins/`（插件开发）中可以按规模裁剪这套体系：

**最小可行版（任何项目都值得）**
- 一个精炼的根 `AGENTS.md`：每条规则 1~3 行 + 链接理由；不追求字数 gate，但保持"规则短、理由有家"的纪律。
- `notes/` 按 `proposed / implemented / rejected` 三分，文件名带日期前缀；**强制 `## Alternatives considered`**——这是整套体系性价比最高的一条。
- 立"改决策开新 note 互链，不重写旧 note"的规矩。
- 不建 INDEX.md，目录即索引。

**进阶（当团队/多 agent 协作变多）**
- class 分类闭集 + 一个几十行的目录 walker 脚本（参照 `agent-note-tree.ts`，核心就是一个 readdir + 白名单校验）。
- note 格式 gate（头三行 + 骨架章节名），挂在 lint 流程里。
- "非平凡变更必须同 PR 带 note"写进 AGENTS.md 的 Conventions。

**做 agent 产品本身的参考**
- event-sourced sessions 这篇 note 本身就是 DSH 核心设计（session 可回放、消息历史是派生视图）的浓缩版，做 agent 记忆/持久化设计时值得先读。
- AGENTS.md 不只是"给人看的约定"，也是产品能力：DSH 仓库里 `snapshots/session/agent-instructions/` 的夹具表明 harness 自身就有加载/嵌套 AGENTS.md 的机制与快照测试——指令文件是产品的一等公民。

---

## 附：源码导航

| 内容 | 路径 |
|---|---|
| 根指令 | `AGENTS.md`（`CLAUDE.md` 是其符号链接） |
| 文档标准（tier 表、预算、行文规则） | `docs/AGENTS.md` |
| Agent Note 完整规范 | `.agents/notes/README.md`（中文版 `README.zh.md`） |
| notes 入口 / implemented 补充规则 / 归档规则 | `.agents/notes/AGENTS.md`、`implemented/AGENTS.md`、`archived/AGENTS.md` |
| note 树闭集与 walker | `scripts/agent-note-tree.ts` |
| note 格式 gate | `scripts/verify-agent-note-format.ts` |
| 归档封存 gate | `scripts/verify-archived-agent-notes.ts` |
| 归档工作流技能（含校准样例） | `.agents/skills/dsh-archive-agent-notes/SKILL.md` |
| 其他技能 | `.agents/skills/*/SKILL.md`（12 个） |
| gate 聚合器 | `scripts/run-gates.ts`（`pnpm run doc-sync`） |
| 字数预算 | `scripts/doc-budgets.manifest.json` |
| 样例 note | `.agents/notes/implemented/architecture/2026-06-11-event-sourced-sessions.md` |
