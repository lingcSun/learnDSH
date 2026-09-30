# DeepSeek Harness（dsh）使用手册

DeepSeek Harness（命令行工具名 `dsh`）是 DeepSeek 开源的全插件化 Agent Harness， 理念是 **“Everything is a Plugin”**：模型、工具、技能（Skills）、会话、沙箱、存储、规划、目标、子代理（Subagents）、工作流全部以插件形式提供，可在不改源码的前提下自由组合与替换。 本手册覆盖：① 如何为项目构建 Harness（AGENTS.md、Skills、MCP）；② 进阶用法（Subagents、Agent Teams、Workflows 等）。

GitHub：deepseek-ai/deepseek-harness 适用版本：dsh v0.2.0-rc.2 对应源码：master@639ed0153（2026-09-29） MIT 开源 Developer Preview · 可能存在破坏性变更 手册整理日期：2026-09-05 · 事实复核日期：2026-09-29

> [!WARN] 📌 版本适配说明（dsh 迭代很快，请先核对版本）
> 本手册内容对应 **dsh v0.2.0-rc.2**（源码 tag `dsh-v0.2.0-rc.2`，commit `639ed0153`，2026-09-29）；初稿基于 v0.1.3-alpha.1（commit `d347e70`，2026-09-04），2026-09-26 对照 v0.1.7-rc.2 源码完成一次事实复核，2026-09-29 升级到 v0.2.0-rc.2 复核。 项目更新频繁、可能存在破坏性变更：阅读前请先用 `dsh -V` 或 `npx @deepseek-ai/dsh --version` 核对本机版本； 若与本手册版本不一致，命令、配置与行为可能已有出入，请以 [官方仓库文档](https://github.com/deepseek-ai/deepseek-harness) 为准。

## 认识 DeepSeek Harness

官方对 Harness 的定位是一个公式：**Agent = Model + Harness**。模型负责“思考”，Harness 负责让 Agent 在真实工程环境中持续干活——管理上下文、调用工具、编辑文件、执行 Shell、委派子任务、记录全过程。DeepSeek Harness 就是 DeepSeek 官方开源的这样一个 Harness。

### 核心设计：一切皆插件

整个系统构建在 [Cordis](https://github.com/cordiverse/cordis) 插件框架之上，由 Cordis 内核负责插件的挂载、卸载与依赖管理，插件之间通过服务（Service）与事件（Event）协作。模型、工具、技能、会话、沙箱、存储、循环、调度乃至 Web UI 都是由插件提供的能力，可以在**配置层**完成选择、替换与扩展，而无需修改 Harness 源码。社区插件统一使用 GitHub 主题标签 `dsh-plugin` 发布与发现。

### 四种运行模式（Agent Preset）

> 版本提示：旧版手册里的 “Code 模式（Code Mode SDK）” 已被 **PTC 模式**取代；下表的 preset id 才是配置文件与源码里真实使用的标识（对应源文件 `packages/bundle/web-app/presets/*.patch.yml`）。

| Preset id | 界面名称 | 说明 |
| --- | --- | --- |
| **standard**（标准模式） | Standard mode | 默认模式。处理代码、文件和资料，适合大多数任务；按需使用检索、编辑、终端等工具。含文件编辑、Shell（Windows 下为 PowerShell）、文件/网络搜索、Skills、Planning、Goals、Subagents、Workflows。 |
| **ptc**（PTC 模式） | PTC mode | 包含标准模式的全部能力；工具经 **PTC（Programmatic Tool Calling）** 暴露，模型可把多步操作写进一段程序一次性编排执行，更适合批量调用工具并筛选/整理/去重/统计/汇总结果的场景。 |
| **minimal**（极简模式） | Minimal mode | 极简编码代理，只保留一个**持久终端工具**（Windows 下为 PowerShell 持久化终端，其余平台为 bash），用于最小环境下的基准评测与能力对比。注意：**该模式不挂载 `agent-instructions` 插件，AGENTS.md 不注入**。 |
| **cordis**（创造模式） | Creator mode | 用对话定制 DSH：编写插件以添加功能或界面，或组合工具与提示词创建自己的模式；含运行时检视与预设编写引导。 |

这四个 preset 均以 `@deepseek-ai/dsh-agent-preset` 插件行的形式注入，按 `order` 排序由 `packages/preset/agent-preset-registry` 展示；Web UI 的 Agent presets 设置页可切换「设为新任务默认」。

### 全程可追溯的会话日志

模型看到的一切都被记录在一条**只追加（append-only）的会话日志**里：系统提示词、推理、工具调用与结果、子代理调度、上下文注入等。Web UI 中的 Trajectory 视图可以按来源检查每条记录；**续跑（Resume）、分叉（Fork）、搜索、回放（Replay）都作用于同一条事件流**。这既是调试利器，也意味着“模型可见 ⟺ 已落日志”。

> [!WARN] ⚠️ 开发者预览阶段
> 项目处于 Developer Preview，官方明确说明**会有破坏性兼容变更**；运行前请阅读仓库中的 `SAFETY.md` 安全须知。本手册基于官方 master 分支 **v0.2.0-rc.2**（commit `639ed0153`，2026-09-29）的文档整理，个别细节请以官方文档为准。

## 安装与快速上手

### 安装与启动

**方式一：npm 直接运行（推荐，需先安装 Node.js）**

```
# 启动 Web UI，自动打开浏览器，默认监听 http://127.0.0.1:3080
npx @deepseek-ai/dsh web

# 只启动服务，不自动打开浏览器（适合 SSH 远程，仅打印访问 URL）
npx @deepseek-ai/dsh web --no-open

# 指定端口（--port 属于 web 应用自身）
dsh --profile web --port 8080
```

**方式二：源码运行**

```
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 构建仓库产物；`pnpm dsh web` 直接使用已构建产物启动，不再重新构建。

### 配置 API Key 与工作区

1. **填 Key：**打开 Web UI → **Settings → Models**，在 DeepSeek 卡片中粘贴 API Key（在 [platform.deepseek.com](https://platform.deepseek.com) 申请）并保存。配置即时生效，**无需重启服务**。密钥本身落盘在 `$DSH_HOME/.credentials.yaml`，设置里只保留凭证引用。
2. **选工作区：**点击 *Choose workspace*，把 `dsh` 的启动目录加入并选中。未选择工作区前，会话输入框不可用。`dsh` 以**调用它的目录作为默认工作区根目录**（没有 `--workspace` 参数）。
3. **跑第一个任务：**例如输入“总结这个仓库，指出主要包的职责”，观察代理读文件、执行命令、委派子代理与维护计划的全过程。

> [!TIP] 💡 环境变量方式
> 也可以直接设置 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_BASE_URL`；自定义 Provider 通常用 `apiKeyEnv` 引用环境变量而非内联密钥。见 4.6 节「自定义模型 Provider」。

### CLI 与运行 Profiles

`dsh` 的运行形态由 **Profile（配置档案）**决定。Profile 是“有序的插件包补丁层堆栈 + 用户覆盖层”，位于 `$DSH_HOME/profiles/<name>/`，内含 `package.json`（`dsh.profile` 清单声明有序 bundles）和用户的 `cordis.patch.yml`。常用命令：

| 命令 | 作用 |
| --- | --- |
| `dsh web` | `--profile web` 的别名，启动 Web UI。 |
| `dsh --profile headless "任务描述"` | 一次性执行：新建一个持久化会话，打印最终答案后退出。适合脚本/CI 调用。 |
| `dsh --profile sdk` | 以 JSON-RPC stdio 向 SDK 客户端提供服务，直到关闭或断开。 |
| `dsh --profile sdk-minimal` | 以独立的最小 Agent 树服务 SDK 客户端。 |
| `dsh --profile acp` | 通过 ACP stdio 为自动化客户端提供服务。 |
| `dsh --profile <name>` | 引导自建 Profile（web/headless/sdk 等首次使用会从内置模板自动初始化，其余需 `dsh plugin` 安装插件）。 |
| `dsh plugin --profile <name> <pnpm 参数>` | 在 Profile 目录内转发 pnpm，管理该 Profile 的插件。另有三个 DSH 自有子命令：`allow-version` / `revoke-version` / `version-exemptions`（对某个包版本放行或收回版本豁免）。 |
| `dsh --patch <file.cordis.yml>` | 叠加 overlay 补丁层（启用 MCP、Webhook 等可选能力的主要方式，见 3.3 节）。 |
| `dsh --dump-default-config` / `dsh --dump-config` | 不启动地打印默认/合成后的插件配置树，用于核查配置。 |

参数切分规则：启动器无法识别的第一个参数开始属于应用本身，如 `dsh --profile web --help` 显示的是 web 应用的帮助。

### 配置文件全景（Harness Home）

Harness Home 解析规则：`$DSH_HOME`，未设置则为 `~/.dsh`。典型的用户级文件布局：

```
~/.dsh/                          ← Harness Home（$DSH_HOME）
├── AGENTS.md                    ← 用户级全局指令（对所有项目生效）
├── .credentials.yaml            ← 凭证文档（API Key 实际存放处，勿提交）
├── cordis.patch.yml             ← 机器级补丁层（如常驻 MCP 服务器）
├── skills/                      ← 用户级技能目录
└── profiles/
    └── <name>/
        ├── package.json         ← dsh.profile 清单（有序 bundles）
        ├── node_modules/        ← 该 Profile 安装的出树插件
        └── cordis.patch.yml     ← Profile 级补丁层：用户设置与精调也写在这里
```

> 版本提示：早期版本的用户设置写在 `$DSH_HOME/settings.yaml`，现**已废弃**——设置统一落在当前 profile 的 `cordis.patch.yml`。Settings 服务在启动时会把 harness home 里遗留的 `settings.yaml` **先改名为 `settings.yaml.imported`，再**从改名后的文件逐 section 导入为同名条目（先改名保证「部分导入」绝不重放）。

相关环境变量：`DSH_HOME`、`DSH_AGENTS_HOME`（默认 `~/.agents`）、`DSH_BUNDLED_SKILL_DIR`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`。启动行为相关的还有：`DSH_PERMISSION_MODE`（默认 `workspace-write`；设为 `danger-full-access` 时审批策略同步放宽为 `never`）、`DSH_TOOLS_MODE`（`native` / `ptc` / `both`）、`DSH_TELEMETRY_MODE`（默认 `FEEDBACK_ONLY`）、`DSH_TELEMETRY_DISABLED`（取任何非空值即退出遥测）。这些变量也可以写在 `$DSH_HOME/.env`（或调用目录的 `.env`）里。

## 构建项目的 Harness

“为项目构建 Harness”= 让 `dsh` 一进你的项目就懂规矩、会技能、能连外部服务。核心是四类东西：**AGENTS.md（项目说明书）、Skills（可复用技能）、MCP（外部工具服务）、Hooks（生命周期钩子）**。它们大多放在项目根目录或 `.dsh/`、`.agents/` 下，随仓库提交，团队共享。

| 文件 / 目录（项目级） | 作用 |
| --- | --- |
| `AGENTS.md` | 项目说明书，内容注入系统提示词（见 3.1）。 |
| `.dsh/skills/` | 项目技能目录（优先级最高的技能来源，见 3.2）。 |
| `.agents/skills/` | 跨工具通用的项目技能目录（Claude Code 等也识别 `.agents/` 约定，便于一套技能多端复用）。 |
| `$DSH_HOME/cordis.patch.yml` | 机器级/Profile 级补丁层，MCP 服务器等插件在此持久启用（见 3.3）。 |
| `hooks.json` | 生命周期钩子（兼容 Claude Code / Codex 的 hooks 格式，见 3.4）。 |

### AGENTS.md：给代理的项目说明书

`AGENTS.md` 由 `@deepseek-ai/dsh-agent-instructions` 插件（`packages/context/agent-instructions/`）加载，作为 `instructions` 形态上下文注入请求。当前加载模型是**用户全局 + 项目根到会话 cwd 的整条目录链 + 每目录多候选 + local 叠加**：

1. **用户全局**：固定的 `$DSH_HOME/AGENTS.md`，对所有项目生效。
2. **项目根**：从会话 cwd 逐级向上，命中任一 `projectRootMarkers`（默认只有 `.git`）的目录即项目根；找不到时退回 cwd。标记本身可通过 `projectRootMarkers` 扩展。
3. **目录链**：遍历**从项目根到 cwd 的每一个目录**（不只根那一层），每目录按顺序加载全部存在的候选文件：`AGENTS.md`、`CLAUDE.md`，再加载叠加层 `AGENTS.local.md`、`CLAUDE.local.md`。
   ⇒ 子目录里的 `AGENTS.md` 也会随深度叠加生效；`CLAUDE.md` 是**被同等识别的候选名**（不只是软链兼容），`.local.md` 用来放本机私有补充。
4. **同目录去重**：同目录内内容（trimmed）相同的候选折叠到顺序最先的一个；不同目录即使内容相同也各自保留。
5. **两道截断**：单文件超过 `maxSourceBytes`（默认 1 MiB）整个忽略；渲染后的基线/单批次超过 `maxBytes`（preset 中为 65536）按预算截断。任一项设为非正或非有限值则整个 AGENTS.md 加载被禁用。
6. **动态刷新**：`read` / `write` / `edit` 工具成功触达某文件后，该路径涉及的嵌套/变更/移除指令会在步边界被重新投影进 agent 收件箱，无需重启会话。

注意：`minimal` preset 不挂载该插件，极简模式下 AGENTS.md 不注入。

#### 推荐写法：一份实用的项目 AGENTS.md 模板

官方仓库自己的 [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md) 是绝佳范本，其结构值得照抄：① 开头一段定位 + “动 packages/ 前先读架构文档”；② 会话数据兼容性规则；③ 启动方式；④ 仓库布局；⑤ 常用命令；⑥ 失败处理原则；⑦ 密钥规则；⑧ 代码约定；⑨ 测试要求。模板：

```
# <项目名> — AGENTS.md

## 项目概述
一句话说明本项目是什么、技术栈、目标用户。

## 仓库布局
- `src/server/`   HTTP API（Fastify）
- `src/web/`      前端（React + Vite）
- `packages/core/` 公共领域逻辑，改动前先读 docs/architecture.md

## 常用命令
- 安装依赖：`pnpm install`
- 本地开发：`pnpm dev`
- 运行测试：`pnpm test --filter <package>`（CI 跑全量，本地只跑改动面）
- 类型检查：`pnpm typecheck`

## 代码约定
- 全仓库 ESM；组件用函数式 + hooks；禁止 `any`
- 错误必须显式处理，空 catch 必须注释说明吞掉了什么
- 注释只写“代码本身表达不了的约束”，不叙述控制流程

## 测试与验收
- 任何行为变更须带测试；修 bug 先写复现测试再修
- 涉及 API 的改动要同步更新 OpenAPI 描述

## 密钥与安全
- 密钥只走 `.env`（已 gitignore）；发现 `.env` 缺失直接报错，不要编造默认值
- 永不把密钥写进代码、日志或提交

## Git 约定
- 提交信息用 Conventional Commits；PR 必须带 `kind/*` 标签
```

> [!TIP] 💡 写好 AGENTS.md 的原则
> ① 写**约束**而不是百科：模型不知道的团队规矩、命令、坑；② 命令给**可直接执行的原文**；③ 规则保持自包含、尽量精炼（官方还要求“规则必须自包含并尽可能压缩”）；④ 与其写“注意质量”，不如写“PR 前必须通过 `pnpm verify`”。

### Skills：把可复用方法论做成“技能”（推荐）

技能（Skill）是一份**可选指令文档**：平时只在系统提示词里占一行“名字 + 描述”，当模型判断当前任务匹配时，再通过 `skill({ name })` 工具**按需加载全文**（渐进披露），从而用极小的上下文成本携带大量领域知识。技能名必须是 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）。

#### 目录与优先级

| 优先级 | 来源 | 位置 |
| --- | --- | --- |
| 100（最高） | project-dsh | `<项目根>/.dsh/skills` |
| 200 | project-agents | `<项目根>/.agents/skills` |
| 300 | custom | 配置项 `customSkillDirs` 指定的目录 |
| 400 | user-dsh | `<DSH_HOME>/skills`（即 `~/.dsh/skills`） |
| 500 | user-agents | `<agentsHome>/skills`（即 `~/.agents/skills`） |
| 600 | bundled | `bundledSkillDir`（内置/随包技能） |

项目根 = 最近的含 `.git` 的祖先目录（否则用当前 cwd）。重名技能按 优先级 → provider 顺序 → 目录内顺序 消歧；技能目录会被文件监听（chokidar），增删改即时生效。

#### 两种合法形态

```
.dsh/skills/
├── deploy-check/          ← 形态一：目录捆绑（推荐，可带脚本/参考资料）
│   └── SKILL.md
└── commit-style.md        ← 形态二：单文件
# 注意：不支持嵌套递归发现（**/SKILL.md 无效），只扫上述两层
```

#### SKILL.md 模板

```
---
name: deploy-check
description: 发布前检查：跑 lint、测试、迁移漂移与环境变量核对，输出发布就绪报告
whenToUse: 当用户要求发布、上线、打 tag 或部署到生产环境时使用
disable-model-invocation: false   # true = 只允许用户手动调用，模型不能自作主张
user-invocable: true              # false = 只允许模型调用，用户不直接触发
---

# 发布前检查

## 步骤
1. 运行 `pnpm lint && pnpm typecheck`，任何报错即中止。
2. 运行 `pnpm test`，覆盖失败的包要给出摘要。
3. 对照 `.env.example` 核对生产环境变量清单。
4. 生成《发布就绪报告》：通过项 / 阻塞项 / 建议动作。

## 参考
- 详细核对表见 references/checklist.md（相对技能目录解析）
- 回滚脚本：scripts/rollback.sh
```

模板说明：frontmatter 中两个策略键省略时默认均为 `true`；`description` 是路由依据，务必写清“做什么、何时用”。

> [!TIP] 💡 技能写作要点
> ① `description` 是模型决定“要不要加载这个技能”的唯一线索，要短而准；② `whenToUse` 是补充路由提示；③ 正文默认**不缓存**——每次调用都重读文件，改完立即生效，很适合迭代打磨；④ 只按需在正文中显式引用脚本/参考文档（加载结果不会枚举技能目录）；⑤ 五种组合的调用策略都被保留，敏感技能记得 `disable-model-invocation: true`。

### 接入 MCP 服务器

dsh 通过 `@deepseek-ai/dsh-mcp-client` 插件连接 MCP（Model Context Protocol）服务器，发现的服务器工具以 `mcp__<serverName>__<tool>` 命名暴露给模型。支持两种传输：

- **stdio**：dsh 作为父进程拉起/停止子命令，随插件生命周期管理（最常用）；
- **streamable-http**：连接一个**已经在运行**的远程服务（需给 `url` 与 `headers`），dsh 不负责托管上游。

> [!WARN] ⚠️ 与其他工具不同：没有 dsh mcp add 命令
> dsh 的 MCP 服务器通过 **Cordis overlay 补丁（`--patch`）**或补丁文件启用，不是 `mcpServers` JSON 配置。下面三步走。

#### 第 1 步：写一个 overlay 文件（stdio 示例）

官方自带的记忆服务器示例 `memorix.cordis.yml` 原文：

```
# Opt-in reference for Memorix 1.3.0. Install the pinned `memorix` executable
# first; DSH starts it but does not run a package manager.
- insert:
    - id: memory-memorix
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memorix
        transport: stdio
        command: memorix
        args: [serve]
        cwd: !!js process.cwd()
```

照此结构接任意 stdio MCP 服务器（示例：GitHub MCP 服务器）：

```
# github-mcp.cordis.yml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: [-y, '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: ${GITHUB_TOKEN}   # 额外密钥只放在行内 config.env，不写进 YAML 其他位置
        cwd: !!js process.cwd()
```

#### 远程 HTTP 服务器示例

```
- insert:
    - id: mcp-docs-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: docs
        transport: streamable-http
        url: https://docs.example.com/mcp
        headers:
          Authorization: Bearer ${DOCS_MCP_TOKEN}
```

#### 第 2 步：临时启用（`--patch` 试跑）

```
# 启动官方记忆 MCP（先全局安装对应可执行文件，dsh 只负责拉起、不负责装包）
npm install --global memorix@1.3.0
npx @deepseek-ai/dsh web --patch "$PWD/apps/cli/config/examples/mcp-memory/memorix.cordis.yml"
```

源码仓库的 `apps/cli/config/examples/` 下现有两组官方 overlay 示例：`github-review/`（评审事件驱动的工作区会话）与 `mcp-memory/`（三个记忆类 MCP 服务器参考：`memorix.cordis.yml`、`engram.cordis.yml`、`mcp-reference-memory.cordis.yml`）；早期版本里的通用 `cordis/` 与 `schedule/` 示例未随版本保留，按同目录示例的写法自建即可。

#### 第 3 步：持久启用（写进补丁文件）

把 overlay 的 `insert` 条目**合并**（不要整文件覆盖，里面可能有你其他补丁）进：

- `$DSH_HOME/profiles/<name>/cordis.patch.yml` — 仅该 Profile 生效（推荐按项目/用途分 Profile）；
- `$DSH_HOME/cordis.patch.yml` — 机器级全局生效。

#### 行为与安全细节

- **发现是异步的**：启动后稍等，模型侧出现 `mcp__…` 工具才算就绪。
- **断线自愈**：崩溃后自动带退避重连并重新同步工具；重连预算耗尽则注销工具，需 reload/重启恢复。
- **环境变量卫生**：stdio 桥会剥掉疑似凭证类变量与全部 `DSH_*` 变量（其余继承）；服务器需要的额外密钥写在对应条目的 `config.env` 里。
- **验证方法**：会话 A 写入一个唯一值 → 新会话 B 中让它读回并使用 → 证明写入、召回、应用三个环节都通。

### Hooks 与其他项目级配置

#### hooks.json（生命周期钩子）

两个官方插件让 dsh 直接**复用 Claude Code / Codex 的 hooks 格式**：`dsh-hooks-claude-code` 与 `dsh-hooks-codex`，各自以 `configPath` 指向一个 `hooks.json`（或含 `hooks` 键的设置文件）。Claude Code 版支持 `${CLAUDE_PLUGIN_ROOT}` 与 `${CLAUDE_PROJECT_DIR}` 变量替换。

#### 用户设置与行为微调（原 settings.yaml）

早期版本写在 `$DSH_HOME/settings.yaml` 的用户设置，现在**统一落在当前 profile 的 `$DSH_HOME/profiles/<name>/cordis.patch.yml`**，通过 Cordis 条目 config 覆盖生效；写入以 profile override 层承载，Home patch 与 `--patch` overlay 优先级更高，会被它们覆盖的表单写入会被拒绝。

Settings 服务（`packages/settings/settings/src/index.ts`）在 Loader 就绪后会**先把 harness home 里遗留的 `settings.yaml` 改名为 `settings.yaml.imported`，再从改名后的文件逐 section 一次性导入同名条目**（`ui-developer-tools`→`ui-settings`、`ui-onboarding`→`ui-settings-general`、`shell`→当前平台的 `pwsh-sandbox` / `bash-sandbox`）；当前组合不认识的 section 只留在改名后的文件里并记录日志。

Settings 表单只能编辑插件以 `.volatile()` 声明的字段，普通配置仍通过 Cordis 配置文件编辑。典型用途见 4.6 节的模型精调示例。

#### 凭证

`$DSH_HOME/.credentials.yaml` 存放真实密钥；设置与 UI 只持有凭证引用，线上传输一律脱敏。它属于用户级而非项目级，**永远不要提交进仓库**。

#### 会话数据与存储

会话持久化（JSONL）需要显式配置 `root` 目录（按 项目/会话 分子目录，支持 zstd）；另有 JSON / SQLite 存储后端与派生查询索引。均在 `cordis.yml` 合成层配置，可用 `dsh --dump-default-config` 查看默认值。

## 进阶用法

### Subagents：子代理委派

子代理是父代理把一块工作**整体委托**给一个独立上下文的子 Agent 执行：子代理有自己的会话日志，干完活把结果交回父代理。它是 Standard 模式自带的能力（“可选能力，不在主循环之内”），并且与其他能力缝不同——**多个 provider 实现可以同时共存**，按名字注册、按名字路由。

#### 内置 Provider 一览

| Provider 插件 | 说明 |
| --- | --- |
| `dsh-subagent-spawn-in-process` | 在进程内新起一个全新上下文的子代理（最常用，不继承父对话）。 |
| `dsh-subagent-fork-in-process` | 从父会话**分叉**出的子代理（继承父上下文，`inheritsParentContext: true`）。 |
| `dsh-subagent-claude-code` | 把子任务委托给本机安装的 **Claude Code CLI** 执行。 |
| `dsh-subagent-codex` | 把子任务委托给本机安装的 **Codex CLI** 执行。 |
| `dsh-subagent-acp` | 通过 ACP 协议连接外部代理客户端。 |
| `dsh-subagent-dsh-sdk` | 经 SDK 拉起另一个 dsh 实例作为子代理。 |

> [!TIP] 💡 “异构委派”
> 这是 dsh 最出圈的玩法：同一个界面、同一条会话日志里，可以把子任务派给 Claude Code 或 Codex 干——跨模型/跨工具混编团队。前提是本机已装好对应 CLI 并完成其自身登录/鉴权。

#### 模型如何使用（对模型暴露的工具）

- **委派工具**：模型侧参数只有必填的 `{ description, prompt }`，另有可选的 `provider` / `model` / `reasoning_effort`（开启子代理模型选择时暴露）与 `run_in_background`（默认后台）。`label` 由 `description` 自动生成；`outputSchema`、`maxDepth`、`toolFilter`、`persona`、`agentOptions` 属于**部署侧 Config 或服务请求层**，不是模型能传的参数。
- **控制工具**（`dsh-tool-subagent-control`）：`send_message`（向子代理发消息，经 `Agent.steer()` 进其收件箱）、`interrupt_agent`（打断）、`list_agents`（列出你启动过的子代理及其 id / 标签 / 状态）。子代理的可用性状态只有两个值：`running`（正在干活）与 `inactive`（当前没有在跑，不代表任务已完成或失败）；`provisioning` / `failed` 描述的是**成员创建过程**，不要与可用性混用。

#### 两种运行模式

| 模式 | 行为 |
| --- | --- |
| **One-shot**
（一次性） | 前台委派、用完即弃。返回一个 `SubagentResult`：`output`（正文）、可选 `structured`（按 outputSchema 的结构化数据）、可选 `diagnostic`（≤4096 UTF-8 字节的诊断信息）和 `stopReason`（`completed | aborted | error | max-tokens | refusal`）。 |
| **Continuable**
（可续聊） | 子代理是一个**持久化子会话**，进程内至多一个激活。只在直接父子之间经 `send_message` 通信（收件箱是唯一队列）；子代理结算时向父代理投递 `subagent-settled` 通知；`interrupt()` 打断但不清空其待办收件箱。 |

#### 实战建议

- 子代理**看不到主对话**（spawn 不继承上下文）：委派 prompt 要自包含——目标、涉及文件、验收标准、返回格式都写全。
- 适合委派的活：大范围检索/调研、批量重复操作、需要独立上下文的隔离实验、可并行的独立子任务。不适合：需要连续交互澄清的探索。
- 每次委派（`subagent/start` / `subagent/end` 事件）都记入会话日志，Trajectory 视图可按“委派父会话”过滤审查。
- 并发规则：不同子代理可并发运行，取消/失败/结算彼此独立；移除 provider 只挡新委派，不收回已受理的运行。

### Agent Teams：多代理团队协作（实验性）

Agent Team 是**隐式根（implicit-root）团队域**：Lead（主会话）作为队长，队员（Teammate）是 Lead 直接派生的子会话。一切状态（花名册、任务板、信箱）都由 **Lead 会话日志**折叠（`foldTeam()`）重建，因此天然可回放、可恢复。

- **组队**：Lead 调 `spawnTeammate` 生成队员，携带不可变的 name、description、prompt、上下文模式（fresh / fork）与 provider。成员生命周期：`provisioning → active | failed`。
- **持久信箱**：消息先由 Lead 落库，送达回执只在目标收件箱持久化后确认；未送达部分构成“queued-minus-delivered”恢复信箱。投递统一走 Steer：忙的队员在最近步边界收到，空闲的立即开一轮，不活跃的冷恢复。
- **共享任务 DAG**：任务 id 形如 `task-<n`，每次变更加一版 revision（比较-交换）。状态 `pending / in_progress / completed / deleted`；`blockedBy` 依赖边必须无环；`writeScopes` 是**建议性路径前缀**而非硬锁。
- **控制**：`interrupt` 可停某队员当前轮次（不清其收件箱）；`waitForChange`（10 秒–1 小时）用于等待任务板变化。

适用场景：多文件重构、并行调研 + 汇总、长任务流水线。注意 writeScopes 是“君子协定”，真正的文件写入仍受权限与沙箱约束。

### Workflows：脚本化编排子代理（进阶）

工作流是**“模型自己写的编排脚本”**：一段普通 JS（允许顶层 `await`，必须以 `return <json>` 结束），在 worker 线程里运行，脚本内用 `agent()` 派生并等待多个子代理。与 Subagent 的区别：Subagent 是“一次派一个”，Workflow 是“一次编排一整张执行图”。

```
# 示意写法（说明结构，非逐字官方示例）——模型经 workflow 工具提交：
script: |
  phase("调研")
  const [api, ui] = await parallel([
    agent("梳理 src/server 所有路由及参数，输出清单"),
    agent("梳理 src/web 所有页面及依赖接口，输出清单"),
  ])
  phase("汇总")
  const gap = await agent(`对比两份清单，找出后端缺失的接口：${JSON.stringify({api, ui})}`)
  return { api, ui, gap }
meta:
  name: api-ui-gap-analysis        # 必填，kebab-case
  description: 并行调研前后端并输出接口差距报告  # 必填
  whenToUse: 需要跨层对齐接口时
  phases: [调研, 汇总]              # 可选，仅用于进度展示的词汇表
args: { }                            # 可选，脚本内以 args 全局变量原样可用
```

- 脚本全局可用：`agent()`（派子代理）、`phase(title)`（阶段标记，与 meta.phases 匹配供观察者展示）、`log(message)`、组合器 `parallel()` / `pipeline()`。
- **先验证后执行**：引擎在运行任何东西之前校验 meta（纯 JSON，绝不靠执行脚本来取），不合法就“响亮拒绝”。
- 请求级控制：`subagentProvider`（整局换子代理后端）、`maxTotalAgents`（本轮子代理上限）。
- 结果永不 reject：失败以 `stopReason: 'error'` 结算；取消（closed union `completed | cancelled | error`）在有界宽限期内强制结算。

### 会话管理：续跑 / 分叉 / 回放

- **Resume**：从持久化会话继续。终端里用 headless：`dsh --profile headless --session-id <id> "继续"`（未知 id 直接报错）；Web UI 则直接在会话列表打开原会话继续对话。注意仓库**没有内置 `tui` profile**，内置模板只有 web / headless / sdk / sdk-minimal / acp 五个。
- **Fork**：从任意事件分叉出新会话（fork 的子代理继承父上下文即源于此）。
- **Search / Replay**：会话查询服务支持有界读取、关系追踪、语义过滤与全文分页；回放按同一条事件流进行。
- **压缩（Compaction）**：上下文过长时触发压缩事件与 CompactionEngine 摘要，长期任务不丢关键信息。
- **Spill**：超长文本可卸载为 spill 文件（默认在 OS 私有临时目录，默认保留 30 天）。

### 权限、审批与沙箱

- **审批（Approval）**：每会话可设审批策略，敏感操作走一次性审批缝（`ApprovalRequest/Outcome`），全程留审计事件。
- **权限预设（Permission Presets）**：预设档位 + 自定义态，切换记录进日志。
- **沙箱（Sandbox）**：按策略做进程隔离与文件效果管控（file-effect 模式、受限 argv），**fail-closed**——策略缺失时拒绝而非放行。官方 AGENTS.md 的处理原则值得抄给项目：“被沙箱拦下的命令，以**最小粒度升级**重试”。Windows 上若未配置自定义 runner，sandbox-local 会自动注册一个内置技能 `diagnose-windows-sandbox-acl`，模型或用户可直接调用它排查「写入被拒」的真实成因。
- **人机提问（`ask_user_question`）**：模型可以把问题抛回给用户、暂停本次工具调用。默认（`mode: 'legacy'`）阻塞等待回答；配置 `mode: 'timed'` 后前台等待 `timeout`（默认 120 秒）即自动继续，而问题仍保持可答——迟到的回答以 `user/message` 进入会话。`exit_plan_mode` 也走同一条 `ctx.userQuestions` 接缝。

### 自定义模型 Provider（多模型混用）

Web UI → **Settings → Models → Add provider**：内置目录含 `anthropic`、`openai`、`moonshotai`（Kimi）、`zai`（GLM）等；也可添加任意 OpenAI 兼容网关（UI 提供三种协议三选一：`openai-completions` / `openai-responses` / `anthropic-messages`；源码实际还支持 azure-openai-responses、openai-codex-responses、bedrock-converse-stream 等）。表单之外的精调写在**当前 profile 的 `$DSH_HOME/profiles/<name>/cordis.patch.yml`** 中，形态是**带条目 id 的 Cordis 覆盖**：

```
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY        # 用环境变量引用密钥，不内联
        api: openai-completions
        baseURL: https://gateway.example/v1
        models:
          - id: legacy-chat               # 手工登记的模型默认纯文本
          - id: vision-preview
            input: [text, image]          # 显式开启图像输入
      anthropic:
        modelOverrides:                   # 内置 provider 的模型覆写
          claude-sonnet-4-5:
            input: [text]

- id: llm-deepseek
  config:
    reasoningEffort: max                  # DeepSeek 官方路由的默认推理力度（独立条目，不与 llm-pi-ai 混写）
```

> ⚠️ Cordis 配置覆盖会**整体替换该条目的 config**，编辑已有覆盖时务必保留其他 provider 与字段。

其他可用项：每模型的 `reasoningEfforts` 映射、思维默认开启的模型配 `compat.thinkingFormat: deepseek`、兼容开关（如 `supportsDeveloperRole`、`maxTokensField`）、`defaultInput`。改动后下一次请求即生效。

### 定时任务、Webhook 与插件开发

- **Schedule（定时/提醒）**：会话本地提醒与持久化转移，现由官方**可选 bundle** `@deepseek-ai/dsh-experimental-schedule-bundle` 提供——在插件管理页把对应的可选能力打开即可，不再需要自写 overlay。同一批可选 bundle 还有 agent-team-profile、voice-input-bundle 与 auto-review。`apps/cli/config/examples/` 目前提供 `github-review/` 与 `mcp-memory/` 两组示例（含 `cordis.yml` 与 `.cordis.yml` 变体）。
- **Webhook + GitHub Review**：经过鉴权的 provider 推送可编程地创建工作区会话，用于“GitHub 上收到评审事件 → 自动开会话处理”（可选 overlay）。
- **插件开发**：能力缝（Capability Seam）要求同时实现三个角色——Service Definition / Provider / Consumer；模型可见的变更必须可从会话日志重建。仓库 `docs/cookbook/` 有 “adding-a-tool”“adding-an-llm-adapter”“extension-cookbook” 等上手菜谱；自研插件打 `dsh-plugin` 主题标签发布。
- **Python SDK**：官方提供 Python 运行时（wheel 同样打包 `dsh` 命令）与 SDK 指南（`docs/user/guide/python-sdk.md`），`sdk` / `sdk-minimal` Profile 面向 SDK 客户端。

## 速查表

#### 命令速查

| `dsh -V` / `dsh --version` | 查看版本号（核对手册适用版本） |
| --- | --- |
| `npx @deepseek-ai/dsh web` | 启动 Web UI |
| `dsh --profile headless "任务"` | 一次性执行 |
| `dsh --profile sdk` | SDK JSON-RPC 服务 |
| `dsh --patch <overlay.yml>` | 叠加补丁层 |
| `dsh --dump-config` | 查看合成配置 |
| `dsh --dump-config-schema` | 导出配置 JSON Schema（v0.1.7-alpha.1 起提供） |
| `dsh plugin --profile …` | 管理 Profile 插件 |

#### 环境变量速查

| `DSH_HOME` | Harness Home（默认 `~/.dsh`） |
| --- | --- |
| `DSH_AGENTS_HOME` | agents 目录（默认 `~/.agents`） |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 |
| `DEEPSEEK_BASE_URL` | 自定义 API 端点 |
| `DSH_BUNDLED_SKILL_DIR` | 内置技能目录覆盖 |
| `DSH_PERMISSION_MODE` | 权限模式，默认 `workspace-write`；`danger-full-access` 会把审批策略放宽为 `never` |
| `DSH_TOOLS_MODE` | 工具暴露形态：`native` / `ptc` / `both` |
| `DSH_TELEMETRY_MODE` | 遥测模式，默认 `FEEDBACK_ONLY` |
| `DSH_TELEMETRY_DISABLED` | 取任何非空值即退出遥测 |

#### 文件位置速查

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/AGENTS.md` | 用户级全局指令 |
| `<项目根>/AGENTS.md` | 项目级指令（自动发现） |
| `<项目根>/.dsh/skills/<name>/SKILL.md` | 项目技能（最高优先级） |
| `~/.dsh/skills/` · `~/.agents/skills/` | 用户级技能 |
| `~/.dsh/cordis.patch.yml` | 机器级补丁（常驻 MCP 等） |
| `~/.dsh/profiles/<name>/cordis.patch.yml` | Profile 级补丁 |
| `~/.dsh/profiles/<name>/cordis.patch.yml` | 当前 Profile 的用户设置与精调（原 `settings.yaml`） |
| `~/.dsh/.credentials.yaml` | 密钥（勿提交） |

## 故障排查 FAQ

| 现象 | 排查建议 |
| --- | --- |
| MCP 工具（`mcp__…`）没出现 | 发现是异步的，稍候刷新；用 `dsh --dump-config` 确认补丁真的合入；stdio 服务器确认命令可独立运行（dsh 只拉起、不装包）。 |
| MCP 工具中途消失 | 重连退避预算耗尽会注销工具：reload 或重启后恢复；顺带检查上游服务是否崩溃。 |
| `MISSING_CREDENTIAL` | 在 Models 页保存密钥，或设置 Provider 引用的 `apiKeyEnv` 环境变量。 |
| `UNKNOWN_MODEL` | 选择已配置的模型，或把模型 id 加进自定义 Provider 的 `models` 列表。 |
| 图片发送前被拒 | 手工登记的模型默认纯文本：在模型上加 `input: [text, image]`。 |
| 技能没被加载 | 检查目录层级（只认 `<name>/SKILL.md` 或 `<name>.md` 两层，嵌套无效）；名字必须 kebab-case；确认优先级更高的同名技能没有遮蔽。 |
| AGENTS.md 没生效 | 确认文件位于项目根（含 `.git` 的目录）；文件过大触发字节上限截断；检查是否被同目录更高优先级的叠加文件覆盖。 |
| 命令被沙箱拦截 | 按“最小粒度升级”调整沙箱/审批策略后重试；沙箱 fail-closed，不会静默放行。 |

## 参考资料与来源

- 官方介绍：[DeepSeek Harness — Everything is a Plugin](https://www.deepseek.com/harness/en/)
- 源码仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（README / `SAFETY.md` / `AGENTS.md`）
- 文档站：[Quickstart](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart) · 仓库内 `docs/`（config-catalog、subsystems/\*、user/guide/\*）
- 关键子系统文档：skills · subagent · agent-team · workflow · settings · mcp-memory · providers · system-prompt
- 官方 MCP overlay 示例：`apps/cli/config/examples/`（`github-review` / `mcp-memory`）
- 社区插件：[GitHub Topic: dsh-plugin](https://github.com/topics/dsh-plugin) · 社区资源合集 [awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness/blob/main/README.zh-CN.md)
- Cordis 框架：[cordiverse/cordis](https://github.com/cordiverse/cordis)

## 附录：5 分钟接入现有项目

1. **启动**：在项目根目录执行 `npx @deepseek-ai/dsh web`，浏览器打开 `http://127.0.0.1:3080`，Settings → Models 填 DeepSeek API Key，选择本项目为工作区。
2. **写 AGENTS.md**：把 3.1 节的模板填成你的项目实情，提交进仓库。
3. **加一个技能**：创建 `.dsh/skills/code-review/SKILL.md`（照 3.2 节的模板），写清“何时触发 + 检查步骤”。
4. **接一个 MCP**：把 3.3 节的 overlay 改成你要的服务，先 `--patch` 试跑，稳定后合并进 `~/.dsh/profiles/myproj/cordis.patch.yml`。
5. **试进阶**：对它说“用子代理并行梳理前端和后端，再汇总成报告”，观察 Subagent/Workflow 的编排与 Trajectory 日志。

> [!DANGER] 🛑 安全提醒
> Agent 拥有真实的文件写入与 Shell 执行能力。生产密钥不进工作区；重要目录善用审批策略与沙箱；执行不可逆操作（删除、发布、推送）前保持人工确认。运行前请阅读官方 `SAFETY.md`。
