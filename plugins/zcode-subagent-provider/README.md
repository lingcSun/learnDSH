# zcode-subagent-provider（ZCode CLI 子代理 provider）

把 ZCode CLI（`zcode.cjs`）接入 DSH 的 **subagent 委托缝隙**（`ctx.subagents`），替代 `zcode-subagent/` 里的动态工具方案：主 agent 通过标准委托工具 `subagent_zcode` 委派自包含任务给一个真实的 ZCode 会话，架构与 `subagent-codex` / `subagent-claude-code` 一致：

- 每次委派 = 一个全新 `zcode.cjs --prompt --json` 进程（宿主 node 直接跑，无 shell），在父会话工作区内运行，结束后整棵进程树回收。
- 前台调用返回最终回答；`run_in_background: true` 返回 Job id，用 `job_output` / `job_kill` 收取或取消。
- 取消 / 中断经 `request.signal` → spawn 信号 → 进程树终止，结算为 `aborted`。
- ZCode 的供应商 / 模型 / 凭证保持原生（`~/.zcode/cli/config.json`），不占 BigModel 之外的额度。

## 相比旧 zcode-subagent 动态工具的变化

| | 旧动态工具 | 本 provider |
|---|---|---|
| 挂载方式 | dshmarket 动态插件（.host.js 函数体） | 正式 bundle，走 `ctx.subagents` |
| 后台 / Job | 无 | `run_in_background` + `job_output`/`job_kill` |
| 取消 | 工具内自实现 | 委托缝隙统一（`aborted` 结算） |
| 会话事件 | 无 | `subagent/start` / `subagent/end` 可观测 |
| `resume_session` 续接 | 支持 | **不支持**（一次性；续接靠重新委派写全上下文） |
| 每次调用选 workspace / 超时 | 支持 | 固定于 provider 实例配置 |

两个可并存：续接密集的流程继续用旧工具，正式委派走本 provider。

## 文件

```
zcode-subagent-provider/
├── package.json        # dsh.bundle 声明，patch 指向 cordis.patch.yml
├── cordis.patch.yml    # 注册 dormant provider + 一条 delegation 工具行
└── src/
    ├── index.js        # 配置 schema（schemastery）+ provider 注册
    └── run.js          # 运行生命周期：spawn、JSON 报告解析、结果结算
```

## 前置条件：zcode CLI 自身的模型配置（2026-09-09 已修）

无头运行要求 `~/.zcode/cli/config.json` 含 `provider`（供应商定义）与 `model`（如 `bigmodel/GLM-5.3-Flash`）。该文件的这组键曾丢失（桌面版把模型配置迁到了 `~/.zcode/v2/config.json`，CLI 仍读 v1），已从 v2 的 `bigmodel-coding-plan` 迁回并验证可跑；原文件备份在 `~/.zcode/cli/config.json.bak-subagent-20260909`。若日后再报 `Model config is missing`，按同样方式迁移。

## 安装（web profile，2026-09-09 已装）

> ⚠️ `dsh plugin add ./目录` 在 Windows 上以 shell 拼接参数，**路径含空格会被拆碎**（本机 plugins 目录正好带空格）。实际生效的安装方式是直接操作 profile：

```bash
cd ~/.dsh/profiles/web
pnpm add "link:D:/deepseek harness/plugins/zcode-subagent-provider"
# 再把 "dsh-plugin-subagent-zcode" 加进 package.json 的 dsh.profile.bundles 数组
# 验证组合：node D:\deepseek-harness\apps\cli\lib\bin.js --profile web --dump-config | grep subagent-zcode
# 重启 dsh web 后生效；移除：pnpm remove dsh-plugin-subagent-zcode 并从 bundles 删名
```

pnpm 会把本目录**符号链接**进 profile（已实测），改代码即时生效。

### 依赖解析桥（已就位）

运行时经 `plugins/node_modules/@deepseek-ai/` 下的 junction 引用仓库内包（`dsh-subagent`、`schemastery`、`dsh-brand`、`dsh-timeout`）。junction 若被清理需按 `cursor-subagent/README.md` 的命令重建。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `providerName` | `zcode` | `ctx.subagents` 上的注册名 |
| `entryPath` | `D:\ZCode\resources\glm\zcode.cjs` | CLI 入口脚本绝对路径，首次运行时校验存在 |
| `mode` | `yolo` | `--mode` 透传；v0.16.5 仅 `yolo` 能在无头下执行工具 |
| `env` | `{}` | 叠加在凭证清洗后的父环境之上 |
| `cwd` | 父会话 cwd | 子代理工作区绝对路径覆盖 |
| `disposeGraceMs` | `3000` | 进程树终止宽限 |
| `maxRunMs` | `1800000`（30 分钟） | 总时长上限：spawn 后这么久仍无报告则按 error 结算（保留已收集输出） |

## 注意事项

- **task 必须自包含**：子代理看不到主 agent 对话；背景、目标、约束、验收标准写全。
- **结算由报告驱动（2026-09-09 修复）**：stdout 中一旦解析出最终 JSON 报告立即结算并回收进程树，不再等待子进程退出/runner 上报——此前 runner 在 zcode 拉起插件宿主/MCP 子进程的场景下从不上报子进程退出，导致 job 永远 `running`、主 agent 永等。`maxRunMs` 兜底防无限挂起。
- **失败/中止保留部分输出**：取消或异常时返回已收集的 stdout（截断到 60000 字符），完成但未结算的答案不再丢失；也可从 zcode 会话流水（`~/.zcode/cli/rollout/`）找回。
- **报告上限**：`response` 超 60000 字符会截断（保护父会话上下文）。
- 类型检查：`node D:\deepseek-harness\node_modules\typescript\bin\tsc -p "D:\deepseek harness\plugins\tsconfig.json"`。
