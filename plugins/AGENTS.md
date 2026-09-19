# plugins/AGENTS.md — 插件开发规范

本目录存放自定义 DSH 插件。本文件仅在会话工作目录位于 `plugins/`（或其子目录）内时被 DSH 自动加载；从项目根启动的会话请遵循根目录 [AGENTS.md](../AGENTS.md)。

## 插件是什么

DSH 插件是一个 npm 包，通过在 `package.json` 中声明 `dsh.bundle` 字段被识别为插件（bundle）。DSH 基于 Cordis 内核负责插件的挂载、卸载与依赖管理，插件之间通过服务（Service）与事件（Event）协作。

## 最小插件结构

```
plugins/
└── my-plugin/
    ├── package.json        # 必须包含 dsh.bundle 声明
    └── src/
        └── index.ts        # 插件入口
```

`package.json` 示例：

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "dsh": {
    "bundle": {
      "patch": "./src/index.ts"
    }
  }
}
```

## 开发约定

1. **每个插件一个独立目录**，目录名与插件功能一致（kebab-case）。
2. **命名**：包名建议加统一前缀（如 `dsh-plugin-*`）避免与官方包混淆。
3. **插件可提供的能力**：模型、工具、技能（skills）、命令、MCP 服务器接入、系统提示词注入、配置命名空间等，均通过 Cordis 服务/事件注册，不修改 DSH 源码。
4. **不要把插件代码写在 `deepseek-harness/` 里**：那是只读的上游源码。
5. 涉及 DSH 内部 API 的用法，**以 `deepseek-harness/` 源码为准**；本地 HTML 文档可能与当前版本不一致，网络资讯仅供参考。

## 安装与调试

```bash
dsh plugin add ./my-plugin   # 以本地路径安装插件
dsh plugin list              # 查看已启用的插件
dsh plugin remove my-plugin  # 移除插件
```

插件通过 profile 的 `dsh.profile.bundles` 层栈持久启用；`dsh plugin` 命令会按实际安装状态自动 reconcile 该层列表。

## 参考实现

官方插件源码位于 `../deepseek-harness/packages/extensions/`，写插件前先对照学习其结构与注册方式。

## 待补充

- [ ] 完成第一个插件后，把实际踩坑与最佳实践补充到本文件。
