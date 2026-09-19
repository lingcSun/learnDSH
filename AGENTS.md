# AGENTS.md

本项目是 **DeepSeek Harness（DSH）** 的学习与实践目录，用于研究 DSH 的架构与实现，并在此基础上进行自己的 agent 开发实践。

## 目录结构

| 目录/文件 | 说明 |
|---|---|
| `docs/` | 文档区：自己的沉淀产出（md+html 配对，输出约定见下）与源码生成的参考资料（使用手册、教程） |
| `plugins/` | 自定义插件目录，存放自己编写的 DSH 插件（开发规范见 `plugins/AGENTS.md`） |
| `learnDSH/` | 模仿 deepseek-harness 实现的 agent 练习代码，按主题分子目录，每个子目录自带 README（练什么、怎么跑） |
| `deepseek-harness/` | 从 GitHub 克隆的 DSH 官方源码库，版本会随 GitHub 上的更新定期拉取（`git pull`） |
| `scripts/` | 辅助脚本（`md2html.py`：Markdown→HTML 转换，见下方"输出约定"） |

## 使用约定

1. **deepseek-harness 目录是只读参考**：它是上游源码，不要在其中直接修改代码；更新方式为进入该目录执行 `git pull`。
2. **自己的实践代码放在 learnDSH/**：模仿 DSH 的 agent 实现都写在这里，可以自由修改和实验。
3. **自定义插件放在 plugins/**：开发或测试的 DSH 插件统一放在此目录，插件开发规范见 [plugins/AGENTS.md](plugins/AGENTS.md)。
4. 阅读 DSH 源码时，可结合 `docs/` 下两份 HTML 参考资料（使用手册、教程）对照理解。但这两份文档基于特定版本源码生成，**可能不是最新的**；需要更新文档或核实内容时，**优先以源码为准，网络资讯仅供参考**。

## 输出约定

本项目自己产出的每份输出文档（设计沉淀、学习笔记、分析报告等）统一放在 `docs/`，一律**双格式交付，同名配对**：

- **`<名称>.md`（Markdown 版）**：给 agent 用——内容源，供后续会话读取、检索与引用。
- **`<名称>.html`（HTML 版）**：给人看——由 md 版转换生成的阅读版。

执行规则：

1. Markdown 是唯一内容源：先写/改 `.md`，再生成 `.html`，**不要手工维护两份内容**。
2. 用 `python scripts/md2html.py <文件.md>` 生成 HTML（自包含单文件，浏览器直接打开）。
3. 更新输出时同步重新生成配对文件，两份在同一次提交中交付。
4. `docs/` 下既有的两份 HTML 手册/教程由 DSH 源码生成，是参考资料，不属于本约定范围。

## 更新上游源码

拉取 `deepseek-harness` 代码时，**不求拉取最新代码**：alpha 版本多为破坏性变更（breaking changes），不要随意跟进；rc 版本则可以拉取。

```bash
cd deepseek-harness
git pull
```
