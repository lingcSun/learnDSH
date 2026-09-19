# java-examples —— 教材配套 Java 骨架

本目录**只提供基础框架**，agent 代码请按教材手敲——手敲是这门课刻意保留的学习环节。

## 框架里有什么

- `pom.xml`：JDK 17 + 唯一依赖 jackson-databind（JSON 处理）+ exec 运行插件，已配好
- `src/main/java/`：空目录，你要在这里创建代码文件

## 手敲任务清单

| 教材章节 | 你要创建的文件 | 运行命令 |
|---|---|---|
| 第 0 章 实操 0-A | `src/main/java/BareAgent.java` | `mvn compile exec:java` |
| 第 4 章 实操 4-A | `src/main/java/StreamingAgent.java` | `mvn compile exec:java -Dexec.mainClass=StreamingAgent` |

代码内容见教材对应章节的「☕ Java 版实现」折叠块，逐行敲进去（建议先自己写、再对照教材）。

## 前置条件

- JDK ≥ 17、Maven ≥ 3.9
- 环境变量 `DEEPSEEK_API_KEY`（platform.deepseek.com 申请）
