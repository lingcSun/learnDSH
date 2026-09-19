# 任务规格书:实现 DSH 动态插件「zcode_subagent 原生工具」

## 目标

编写一个 DeepSeek Harness(DSH)动态 Cordis 插件的 Host 半区代码,把 ZCode CLI 封装为 harness 的原生模型工具 `zcode_subagent`。完成后,当前会话的模型可以在后续对话轮里直接 function call 这个工具来委派任务给你这样的 ZCode 子代理。

## 唯一输出文件

`D:\deepseek harness\zcode-subagent\plugin\zcode-tool.host.js`

文件内容 = 一个 JS 函数体(不是完整模块):开头可以有注释,然后直接以 `return {` 开始、以 `};` 结束。宿主会把这段文本放进 `function (ctx, harness, console, btoa, atob, TextEncoder, TextDecoder) { ... }` 里执行。除本文件外,你可以在同目录创建 `dev-check.mjs` 做语法自检(用 `new Function(...)` 包裹函数体,捕获 SyntaxError),但完成前必须删除它。禁止改动其他任何文件。

## 运行环境硬约束(违反即失败)

- 纯 JavaScript。禁止 `import`、`require`、TypeScript 语法、JSX。
- 可用标识符只有:`ctx`(Cordis 上下文)、`harness`(宿主助手)、`console`、`btoa`、`atob`、`TextEncoder`、`TextDecoder`,以及 ECMAScript 标准内置(Promise、JSON、Math、AbortController、AbortSignal、Error 等)。
- **没有** `process`、`Buffer`、`require`、`import`、`setTimeout`/`setInterval`(定时器必须走 timer 服务)、`fetch`、`__dirname`。
- 函数体必须返回插件对象:`{ inject: ['subprocess', 'timer'], apply(ctx) { ... } }`。
- `inject` 声明后才能用 `ctx.subprocess`、`ctx.timer`;不要用 `ctx.get()` 之外的未声明属性访问。

## 工具注册协议(已核实,勿凭想象修改)

```js
apply(ctx) {
  const definition = { /* ToolDefinition,见下 */ }
  harness.registerTool(ctx, definition) // 注册进当前插件 Fiber;停止/更新插件时自动注销
}
```

ToolDefinition 的精确形状(源自 dsh-tools 类型定义,省略可选项):

```js
{
  name: 'zcode_subagent',            // string,工具名,模型可见
  description: '...',                // string,给模型的使用说明
  parameters: {                      // JSON Schema 对象(模型入参)
    type: 'object',
    properties: { /* ... */ },
    required: ['task'],
    additionalProperties: false,
  },
  output: {                          // 必需:规范化输出声明
    schema: { /* 校验 execute 返回值的 JSON Schema,对象型 */ },
    render(args, value) {            // 纯函数:值 → 模型/界面内容块
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  },
  timeoutMs: 31 * 60 * 1000,         // 可选:协作式超时预算(到点会 abort exec.signal)
  execute(args, exec) { /* 返回 Promise<规范化值> */ },
}
```

`exec.signal` 是 AbortSignal(模型/用户取消时会触发);异步工作必须观察它。

## subprocess 服务契约(已核实,勿凭想象修改)

`ctx.subprocess.spawn(spec)` 返回句柄;spec 与句柄的精确形状:

```js
// SubprocessSpawnSpec —— 所有字段必填(除 signal/env),无默认值
{
  argv: [/* string 数组,argv[0] 是程序;绝不经过 shell 解释 */],
  cwd: 'D:\\deepseek harness',       // 必须显式给出
  stdio: {
    stdin: 'ignore',                 // 'ignore' | 'pipe' | { data: string }
    stdout: { maxBytes: 524288 },    // 'pipe' | 'inherit' | { maxBytes, spill?: { maxBytes } }
    stderr: { maxBytes: 16384 },     // 溢出时保留尾部
  },
  graceMs: 5000,                     // 终止升级与管道排空的宽限
  signal: ac.signal,                 // 可选:触发即沿进程树终止
}
// SubprocessHandle
{
  pid: number,
  done: Promise<{ exitCode: number|null, signal: string|null }>, // 仅 spawn 失败时 reject
  collected: {
    stdout: { readFrom(fromByte) /* → { text, nextOffset, lossy, spillPath? } */ },
    stderr: { readFrom(fromByte) },
  },                                 // 进程退出后仍可读
  terminate(),                       // 幂等;树级终止
  waitForExit(signal?),              // Promise<boolean>:整棵进程树是否退出
}
// 另有:ctx.subprocess.resolveExecutable('node', env?, signal?) → Promise<string> 解析可执行文件绝对路径
```

## timer 服务契约(已核实)

`inject: ['timer']` 后,`ctx.timeout(callback, delayMs)` 返回 dispose 函数 `() => void`;用它实现工具内deadline。

## 工具行为规格

入参(parameters):
- `task`(string,必需):自包含任务描述
- `workspace`(string,可选):子代理工作目录绝对路径,默认 `'D:\\deepseek harness'`
- `resume_session`(string,可选):上次返回的 sessionId,续接同一子代理对话
- `timeout_minutes`(number,可选):默认 15,下限 0.5,上限 30

execute 逻辑(全部为相对规格,术语见上文契约):
1. 校验:`task` 去空格后为空 → 返回 `{ status: 'error', detail: 'task 不能为空' }`;`workspace` 不以盘符或 `/`、`\` 开头视为非法路径 → 同样返回 error(不要 throw)。
2. 组装 argv:`[nodePath, 'D:\\ZCode\\resources\\glm\\zcode.cjs', '--prompt', task, '--json', '--mode', 'yolo', '--cwd', workspace]`;有 `resume_session` 再追加 `'--resume', resume_session`。`nodePath` 用 `resolveExecutable('node')` 获取(失败 → error)。
3. 超时与取消:`AbortController` 一个;`ctx.timeout(() => { timedOut = true; ac.abort(...) }, timeoutMs)` 设 deadline;同时转发 `exec.signal`(已 aborted 或 addEventListener once)→ ac.abort。所有路径都要 dispose 定时器、移除监听。
4. spawn(cwd = workspace)。`done` reject(spawn 级失败)→ 返回 error 带失败信息。
5. 结束后:先 `await handle.waitForExit()` 再 `readFrom(0)` 读 stdout 尾部;解析其中最后一个可解析的 JSON 块(先整体 parse,失败则取最后一个 `\n{` 之后的部分再 parse;再失败 → error,附 stdout 尾部 800 字符)。
6. 分类返回:
   - 解析出 `{ response, sessionId, usage }` → `{ status: 'done', sessionId, response, usage }`(`response` 超过 60000 字符则截断并加 `truncated: true`;`usage` 只透传 totalTokens/inputTokens/outputTokens/modelRequestCount 四个标量字段,多一字段都不行)
   - 未解析且 `timedOut` → `{ status: 'timeout', detail: '超时已终止,可用 resume_session 续接', sessionId: null }`
   - 未解析且因调用方取消 → `{ status: 'cancelled' }`
   - 其余 → `{ status: 'error', detail, stdoutTail(≤800 字符) }`
7. 每个分支返回值都必须匹配 output.schema:根为 object,`status` 枚举 `'done'|'timeout'|'cancelled'|'error'`,其余字段按分支可选。render 把规范化值 JSON.stringify(value, null, 2) 包成单个 text 块。

description 文案(给模型看的,中文,须包含):用途(委派 ZCode 子代理/GLM-5.3 执行编码任务,拥有工作区内完整文件与命令能力);task 必须自包含(子代理看不到调用方对话);resume_session 用于同一任务迭代;长任务耗时以分钟计,不要用于几秒能答的小问题;额度消耗 BigModel Coding Plan。

## 验收标准(自检后逐条在最终回复中确认)

1. `node dev-check.mjs` 方式(new Function 包裹)无 SyntaxError,检查后已删除 dev-check.mjs
2. 函数体内没有任何 `process`、`require(`、`import `、`setTimeout(`、`Buffer` 字样
3. `inject` 恰为 `['subprocess', 'timer']`,且代码中只通过 `ctx.subprocess`、`ctx.timer`/`ctx.timeout` 访问,无 `ctx.get('subprocess')` 混用问题
4. 三条清理路径(正常结束/超时/调用方取消)都会 dispose 定时器并移除 abort 监听
5. `usage` 透传严格为四个标量字段
6. 输出文件以外没有新增或修改任何文件(dev-check.mjs 已删)

最终回复请报告:文件路径与行数、你对验收标准 1-6 的逐条自查结论、以及关键设计点(超时/取消/解析)的说明。
