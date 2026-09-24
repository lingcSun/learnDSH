# cursor-subagent（Cursor CLI 子代理 provider）

把 Cursor CLI（`cursor-agent`）接入 DSH 的 **subagent 委托缝隙**（`ctx.subagents`）：主 agent 通过标准委托工具 `subagent_cursor` 把一个自包含任务交给一个真实的 Cursor agent 会话执行，取回最终回答。与 `subagent-codex` / `subagent-claude-code` 官方 provider 同一架构：

- 每次委派 = 一个全新 `cursor-agent --print` 进程，在父会话工作区内运行，结束后整棵进程树回收。
- 前台调用返回最终回答；`run_in_background: true` 返回 Job id，用 `job_output` / `job_kill` 收取或取消。
- 子代理的中间输出、工具流量、stderr 不进入父会话；失败只返回粗粒度安全诊断（阶段 / 类别 / 退出码 / stderr 尾部）。
- Cursor 登录态与配置保持原生（`cursor-agent login` / `~/.cursor`）；子进程环境经凭证清洗后再叠加本插件 `env` 配置。

## 文件

```
cursor-subagent/
├── package.json        # dsh.bundle 声明，patch 指向 cordis.patch.yml
├── cordis.patch.yml    # 注册 dormant provider + 一条 delegation 工具行
└── src/
    ├── index.js        # 配置 schema（schemastery）+ provider 注册
    └── run.js          # 运行生命周期：命令解析、spawn、结果结算
```

## 安装（web profile，2026-09-09 已装）

> ⚠️ `dsh plugin add ./目录` 在 Windows 上以 shell 拼接参数，**路径含空格会被拆碎**（本机 plugins 目录正好带空格）。实际生效的安装方式是直接操作 profile：

```bash
cd ~/.dsh/profiles/web
pnpm add "link:D:/deepseek harness/plugins/cursor-subagent"
# 再把 "dsh-plugin-subagent-cursor" 加进 package.json 的 dsh.profile.bundles 数组
# 验证组合：node D:\deepseek-harness\apps\cli\lib\bin.js --profile web --dump-config | grep subagent-cursor
# 重启 dsh web 后生效；移除：pnpm remove dsh-plugin-subagent-cursor 并从 bundles 删名
```

pnpm 会把本目录**符号链接**进 profile（已实测），所以改代码即时生效，无需重装。

### 依赖解析桥（已就位）

本插件在仓库外，运行时通过 `plugins/node_modules/@deepseek-ai/` 下的 junction 引用 `D:\deepseek-harness` 内的包（`dsh-subagent`、`schemastery`、`dsh-brand`、`dsh-timeout`，均已建好）。**若 `pnpm install` 或清理删掉了这些 junction，需重建**：

```powershell
node -e "require('fs').symlinkSync('D:/deepseek-harness/packages/subagent/subagent', 'D:/deepseek harness/plugins/node_modules/@deepseek-ai/dsh-subagent', 'junction')"
# schemastery / dsh-brand / dsh-timeout 同理（vendor/schemastery、packages/util/brand、packages/util/timeout）
```

## 配置（cordis.patch.yml 的 tool 行或 provider 行均可加 config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `providerName` | `cursor` | `ctx.subagents` 上的注册名 |
| `command` | `cursor-agent` | 可执行文件：PATH 名或绝对路径；官方 `.cmd` 垫片会自动解包到 `versions\<最新>\node.exe index.js` |
| `model` | 原生选择 | 固定模型（如 `composer-1`），经 `--model` 传入 |
| `outputFormat` | `json` | `json` 解析结果文档（`result` 字段为最终回答）；`text` 取整个 stdout |
| `permissionMode` | `default` | `plan`/`ask` 只读（`--mode`）；`default` 不加旗标；`force` 加 `--force` 自动批准 |
| `extraArgs` | `[]` | 透传其余旗标（如 `["--trust"]`、`["--sandbox","disabled"]`） |
| `env` | `{}` | 叠加在凭证清洗后的父环境之上（无头认证的 `CURSOR_API_KEY` 放这里） |
| `cwd` | 父会话 cwd | 子代理工作区绝对路径覆盖 |
| `disposeGraceMs` | `3000` | 进程树终止宽限 |
| `maxRunMs` | `1800000`（30 分钟） | 总时长上限：spawn 后这么久仍无结果则按 error 结算（保留已收集输出） |

## 注意事项

- **一次性语义**：没有续接、进度流或会话恢复；多轮迭代靠重新委派并写全上下文。需要续接可配置 `--resume <chatId>`（extraArgs）自行管理 chatId。
- **结算由报告驱动（2026-09-09 修复）**：`json` 格式下 stdout 一旦解析出 `type: 'result'` 文档（可跳过其前的进度叙述行）立即结算并回收进程树，不再等待子进程退出/runner 上报——此前 runner 在子进程退出后可能永不上报，导致 job 永远 `running`、主 agent 永等（已实测复现）。`text` 格式无流内完成标记，保持退出驱动，同样受 `maxRunMs` 兜底。
- **失败/中止保留部分输出**：取消或异常时返回已收集的 stdout（截断到 60000 字符），完成但未结算的答案不再丢失。
- **工作区信任**：首次在新目录运行若卡在信任提示，给 `extraArgs` 加 `"--trust"`。
- 版本兼容性以实测的 CLI 行为为准（当前安装 2026.08.11-e8db854）；Cursor CLI 的 `json` 输出文档化程度一般，升级后如解析失败可临时切 `outputFormat: text`。
- 类型检查：`node D:\deepseek-harness\node_modules\typescript\bin\tsc -p "D:\deepseek harness\plugins\tsconfig.json"`。
