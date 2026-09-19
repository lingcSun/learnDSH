# AGENTS.md

本项目是 **DeepSeek Harness（DSH）** 的学习与实践目录，用于研究 DSH 的架构与实现，并在此基础上进行自己的 agent 开发实践。

## 目录结构

| 目录/文件 | 说明 |
|---|---|
| `plugins/` | 自定义插件目录，存放自己编写的 DSH 插件（开发规范见 `plugins/AGENTS.md`） |
| `learnDSH/` | 模仿 deepseek-harness 实现的一些 agent 练习代码 |
| `deepseek-harness/` | 从 GitHub 克隆的 DSH 官方源码库，版本会随 GitHub 上的更新定期拉取（`git pull`） |
| `DeepSeek-Harness-使用手册.html` | DSH 使用手册（本地文档，基于某一版本源码生成） |
| `deepseek-harness-tutorial.html` | DSH 教程（本地文档，基于某一版本源码生成） |
| `DeepSeek-Harness-设计沉淀.md` | DSH 的 AGENTS.md 体系、Agent Notes 与 Gate 脚本设计思路沉淀（基于特定版本源码整理，见文首版本说明） |

## 使用约定

1. **deepseek-harness 目录是只读参考**：它是上游源码，不要在其中直接修改代码；更新方式为进入该目录执行 `git pull`。
2. **自己的实践代码放在 learnDSH/**：模仿 DSH 的 agent 实现都写在这里，可以自由修改和实验。
3. **自定义插件放在 plugins/**：开发或测试的 DSH 插件统一放在此目录，插件开发规范见 [plugins/AGENTS.md](plugins/AGENTS.md)。
4. 阅读 DSH 源码时，可结合两份 HTML 文档（使用手册、教程）对照理解。但这两份文档基于特定版本源码生成，**可能不是最新的**；需要更新文档或核实内容时，**优先以源码为准，网络资讯仅供参考**。

## 更新上游源码

拉取 `deepseek-harness` 代码时，**不求拉取最新代码**：alpha 版本多为破坏性变更（breaking changes），不要随意跟进；rc 版本则可以拉取。

```bash
cd deepseek-harness
git pull
```
