# ZCode 子代理编排（DeepSeek 主 agent）

```
┌─────────────────┐  function call: zcode_subagent   ┌──────────────────────┐
│  DeepSeek 主agent │ ───────────────────────────────▶ │ zcode-bridge.mjs      │
│  (拆解/验收/汇总)  │ ◀─────────────────────────────── │ spawn zcode.cjs       │
└─────────────────┘   JSON: report + sessionId        └──────────┬───────────┘
                                                                 │ --prompt --json
                                                       ┌─────────▼───────────┐
                                                       │ ZCode CLI (GLM-5.3)  │
                                                       │ 插件/技能/MCP/AGENTS.md │
                                                       └──────────────────────┘
```

## 文件

- `zcode-bridge.mjs` — CLI 封装：spawn、JSON 解析、超时终止、会话续接。可当库用，也能命令行手动调试。
- `deepseek-orchestrator.mjs` — DeepSeek 主 agent 编排循环示例（OpenAI 兼容接口 + tool calling）。

## 快速开始

```bash
# 手动调一个子代理
node zcode-bridge.mjs "列出当前目录结构并总结" --cwd C:\path\to\project

# 跑完整编排（需要 DeepSeek API key）
DEEPSEEK_API_KEY=sk-xxx node deepseek-orchestrator.mjs "给 xx 项目补上单元测试"
```

## 前置条件（本机已就绪）

- `~/.zcode/cli/config.json` 已配置 `provider.bigmodel`（coding plan key）+ `model`（GLM-5.3 / GLM-5.3-Flash）
- 消耗 BigModel Coding Plan 额度，与桌面版共享

## v0.16.5 实测约束（重要）

| 事项 | 结论 |
|---|---|
| 无头可用参数 | `--prompt --json --cwd --resume --mode --attach` |
| 帮助有但解析器拒绝 | `--max-turns` `--allowed-tools` `--disallowed-tools` `--settings` |
| 工具执行 | 只有 `--mode yolo`（默认）能执行工具；`build` 等模式工具全部被拒（无权限客户端） |
| 工具限制 | 无参数级白名单可用 → 安全边界靠 workspace 隔离 / 容器 / config.json 里配 PermissionRequest hook |
| 续接 | `--resume sess_xxx` 保留子代理对话记忆；`-c` 续接该目录最近会话 |
| 超时 | 进程被杀后进度不丢，可用 `-c` 或再次 `--resume` 继续 |

## 设计要点

1. **task 必须自包含**：子代理看不到主 agent 对话，每次委派写全背景/目标/文件/验收标准。
2. **会话策略**：同一任务迭代用 `resume_session`；独立子任务开新会话防上下文污染。
3. **主 agent 负责验收**：子代理报告不等于完成，验收不通过就带 sessionId 续接返工。
4. **并发**：多个子代理 = 多个 node 进程，可并行，额度共享注意频率。
