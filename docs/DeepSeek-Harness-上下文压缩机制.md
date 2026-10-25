# DeepSeek-Harness 上下文压缩机制（Compaction）解析

> [!NOTE]
> 本文基于 **DSH v0.2.1-rc.2**（tag `dsh-v0.2.1-rc.2`，commit `687f282e86`）的源码写成，所有 `文件:行号` 引用均以该版本为准，后续版本可能漂移。核实内容时请以源码为准。

上下文压缩（compaction）是 DSH 在会话变长时保住上下文窗口的核心机制：把较早的对话区段用一次 LLM 总结替换成单个"检查点"消息，从而为后续请求腾出空间。它不是一个函数，而是一套由**触发策略、日志事务、前缀重放总结、表面替换**组成的完整子系统，散布在约 5 个包里：

| 包 | 职责 |
|---|---|
| `packages/compaction/compaction` | 抽象服务定义：`CompactionEngine` 基类、错误分类、工具配对平衡、检查点消息源 |
| `packages/compaction/compaction-basic` | 默认实现：触发策略、范围选择、总结事务、LLM 总结器 |
| `packages/compaction/compaction-tool-result-pruner` | 免模型的工具结果截断（压前预清理） |
| `packages/compaction/compaction-image-offload` | 图片预算超限时的旁路恢复 |
| `packages/compaction/command-compact` | 人工 `/compact` 命令 |

---

## 1. 前提：会话的双层模型

理解压缩先要理解 DSH 会话的存储模型（`packages/core/session/src/surface.ts`）：

- **日志（log）**：append-only 的事件序列，是唯一事实源。任何东西——包括压缩——都**不删除**已写入的事件。
- **表面（surface）**：叠在日志上的有序视图，只收录会产生 LLM 消息的五类事件：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`（surface.ts:50-56）。发给模型的请求消息由 `deriveMessages()` 从当前表面派生。

表面节点带 `surfaceOp` 标记，区分两种来源（surface.ts:78-106）：

- **append**：在自己日志位置进入表面的原始事件——这是人类转录的事实材料；
- **replace**：替换了某个已有区间的"替代副本"（替代品只在模型视图中可见，被替换的原始事件仍留在日志里）。

压缩的全部魔法就建立在这一点上：**改写模型看到的视图，同时原样保留历史**。

---

## 2. 三个触发入口

压缩有三个触发时机，前两个自动、一个手动，全部汇聚到同一个事务实现。

### 2.1 步前压力触发（主路径，自动）

`compaction-basic` 在 `agent/pre-step` 事件上挂钩子（`compaction-basic/src/index.ts:158`）。该事件在 agent 主循环**每个 step 发出模型请求之前**触发（`packages/core/agent-loop/src/agent.ts:267` 的 `preStep()`），因此恢复会话后的第一个 step 同样会被检查。

每次检查的流程（`compactIfNeeded(agent, 'pressure', signal)`，index.ts:269）：

1. 按会话最近路由的 provider/model 解析策略覆盖（`resolveTargetPolicy`）；
2. `ctx.llm.resolveModelInfo` 取该模型的 `contextWindow`；缺失则抛 `TargetPressureConfigError`（每个目标只告警一次，不阻塞回合，index.ts:167-170）；
3. 计算阈值（见 2.4），用 `ctx.tokenMeter` 估算当前表面总 token；
4. `totalTokens < thresholdTokens` → 返回 null，什么都不做；
5. 达标 → 先跑免模型的工具结果修剪（若装了 `toolResultPruner`，index.ts:323-326），重新计量后仍超标才进入总结压缩；
6. 压缩后若仍超标，最多再重试 `compactionRetries`（默认 1）次；仍失败则抛错——但错误被钩子捕获后只告警并放行回合（"step compaction failed; continuing the turn"），**压缩失败不阻塞对话**。

### 2.2 溢出兜底恢复（自动）

`agent/request-error` 钩子（index.ts:190）：当请求以 `CONTEXT_WINDOW_EXCEEDED` 失败时（估算偏差导致没提前压住的情形），**绕过阈值**强制压缩一次，然后返回 `{ kind: 'retry' }` 让当前 step 重发。

细节：

- 每个 agent 有重试计数，受 `maxOverflowRetries`（默认 1）限制；收到成功的 `assistant/message` 或 agent 转入 idle 时清零（index.ts:178-188）；
- 溢出路径选区时 `retainTokens` 传 **0**（index.ts:299）——既然 provider 已确认超限，就不再保尾部预算，压一次"有用的平衡缩减"；
- 部分成功也算数：若压缩过程抛错，但表面 `replaceGeneration` 已前进（说明免模型修剪已持久落地），仍然重试（index.ts:212-218）。

### 2.3 手动 `/compact` 命令

`command-compact` 包提供无参数的 `/compact`，调用 `compactNow()`（index.ts:383）：

- 要求 agent **空闲**：通过 `agent.runMaintenance()` 执行，agent 不空闲时同步抛 `busy`；
- 不受阈值限制：选区时 `retainTokens` 传 0，尽量压缩整个可安全替换的区段；
- 以"独立括号"执行（`owner: null`，不依附于打开的 turn），稳定性要求也更宽松（见 3.6）；
- 成功关闭括号后强制 flush 会话到磁盘（`ctx.sessions.flush`，index.ts:410-412）。

自动压缩由配置项 `auto`（默认 `true`）总开关控制（index.ts:140）。

### 2.4 阈值与预算公式

默认值定义在 `compaction-basic/src/config.ts`：

| 参数 | 默认值 | 含义 |
|---|---|---|
| `thresholdRatio` | 0.8（:20） | 上下文窗口的压力比例 |
| `headroomTokens` | 65536（:75） | 给压缩工作本身预留的空间 |
| `retainRatio` | 0.16（:23） | 尾部原样保留比例（按消息预算） |
| `compactionRetries` | 1（:105） | 压力路径的压缩重试次数 |
| `maxOverflowRetries` | 1（:106） | 溢出路径的恢复重试次数 |
| `auto` | true（:108） | 自动压缩总开关 |

阈值推导（`resolveCompactSpec`，config.ts:153-217）：

```text
reservedCompletion = 请求配置的 maxTokens ?? 适配器默认 maxTokens ?? 0   // (index.ts:65-68)
messageBudget     = contextWindow − reservedCompletion                  // (config.ts:172)
pressureBudget    = messageBudget − headroomTokens                      // (config.ts:181)
thresholdTokens   = ⌊min(contextWindow × thresholdRatio, pressureBudget)⌋  // (config.ts:191)
retainTokens      = 显式 retainTokens ?? ⌊messageBudget × retainRatio⌋   // (config.ts:195)
约束               : retainTokens < thresholdTokens（config.ts:198，装载期即校验）
```

即触发线取"窗口的 80%"与"扣除输出预留和压缩余量后的余额"两者中较小者。所有策略字段都可用 `modelPolicies` 按 `provider + model` 精确覆盖。

---

## 3. 压缩事务：一次完整生命周期

核心入口是 `compactSurfaceRegion`（`compaction-basic/src/region.ts:173`）。它是一个**日志事务**：要么完整落地一组事件，要么留下可追溯的失败记录。

```text
选区 selectCompactableRange
 │  只读：尾部预算 + system 头保护 + 工具配对平衡
 ▼
入口校验 + 压缩锁检查（未配对的 compaction/start 即 busy）
 ▼
写 compaction/start ◄──── 这就是持久锁
 ▼
prepareCompaction：区间定价快照 + 重建重放输入
 ▼
summarize：LLM 总结（失败可经 waterfall 恢复后重试）
 ▼
稳定性检查（自动=整个表面未变；手动=选中区间未变）
 ▼
收缩检查：摘要代价必须严格小于被替换区间
 ▼
提交：compaction/summary → user/message(replace) → compaction/end
 ▼
（可选）flush 持久化
```

### 3.1 选区（region.ts:117-155）

- 从表面节点**尾部向前**累加 token，凑够 `retainTokens` 为止——这段是原样保留的尾部（:135-140）；
- 区间起点跳过节点 0 的 `system/message`（:131），系统提示永不进入压缩区；
- 边界用工具配对平衡校正（见 3.2）；
- 剩余可压区间为空（`keepFromIdx <= firstIdx`）→ 返回 null。

注意区间永远从**最老的消息**开始——这个性质是第 4 章缓存命中设计的根基。

### 3.2 工具配对平衡（`packages/compaction/compaction/src/tool-pairing.ts`）

切割线绝不允许切开一对 assistant 工具调用与其 `tool/result`，否则派生出的消息序列是非法的。实现是按表面顺序折叠"未应答 tool-call 计数"（`assistant/message` 中每个 tool-call 块 +1，`tool/result` −1，:29-38），得到每个切割点的平衡表；平衡表按表面代数（`replaceGeneration`）缓存、增量扩展（:72-92）。`toolPairingBalancedBefore/After` 供两端边界检查；选区时若尾部预算切在配对中间，起界自动向前退到平衡位置（region.ts:143-147）。

### 3.3 压缩锁（region.ts:308-334、566-600）

入口时反向扫描日志找最近的 `compaction/start` / `compaction/end`：存在未配对的 `start` 即认为压缩进行中，拒绝新尝试（`busy`）。`compaction/start` 事件一旦写入就是锁，直到某次 `compaction/end`（成功或失败）关闭。唯一的豁免：若其后存在更新的 `session/end-seed` 边界（会话被构造子重播种），说明那个悬挂的锁属于更早的会话生命周期，不再挡路（:302-320）。

### 3.4 快照与重放输入（region.ts:361-384、544-563）

`prepareCompaction` 对选中区间做 token 定价快照（后面所有比较都以它为准），并构建总结输入：

- **system prompt**：取表面节点 0 的 `system/message` 派生结果（无则不加）；
- **tools**：取 `session.requestHeader()` 里的工具 schema——即上一轮请求实际发送的那份；
- **消息**：被压缩区间内各事件按表面顺序 `deriveEventMessage` 派生。

### 3.5 总结（`compaction-basic/src/summarizer.ts`）

`summarizeWithLlm`（:120）把重放前缀原样发给 LLM，只在末尾追加一条压缩指令 user 消息，走 `ctx.llm.stream()`（`purpose: 'compaction'`）。关键点：

- **指令是最终 user 消息而不是独立 system prompt**（:25-31）——改 system 会从第 0 个 token 失效缓存，追加则前缀全部命中（详见第 4 章）；
- 指令模板（:32-67）要求输出固定 8 节 Markdown 检查点：

  ```text
  ## Primary Request and Intent   用户原始与演化的目标（关键措辞逐字引用）
  ## Key Technical Concepts       技术栈、框架、模式与约定
  ## Files and Code               精确路径：为何重要、关键改动或片段
  ## Errors and Fixes             报错与解法（含相关用户反馈）
  ## Pending Jobs                 已明确要求但未完成的工作
  ## Current Work                 检查点时刻正在进行的事
  ## Next Step                    唯一的下一步动作（或 "(none)"）
  ## Critical Context             决策及理由、约束、偏好、未决问题
  ```

  并附保全规则：精确保留文件路径、命令、报错原文、标识符、数值、函数签名与语法片段；忠实记录用户纠正；不得提及"本请求来自压缩"；
- **二次压缩的合并语义**：若对话里已有 `<compacted-summary>` 块，它是一份**旧检查点**——不得原样照抄，要保留仍为真的事实、丢弃过时项、合并成单份新摘要（:66）。这解决了"压缩的压缩"会滚动膨胀的问题；
- **输出安全**（:169-171、197-221）：空文本判失败；图片输出判失败（`UNSUPPORTED_CONTENT`）；结束原因是 error/aborted 转为 `LlmError`；`max-tokens` 截断判失败（不完整的检查点不如没有）；
- **总结模型路由**（:127-137）：配置的 `summarizationProvider + summarizationModel`（必须成对配置）→ 会话最近路由的模型 → agent options，三级回退；
- **失败恢复**（region.ts:397-409）：总结抛错时——若已取消则原样上抛；否则先过稳定性检查，再触发 `compaction/summary-error` waterfall（`packages/compaction/compaction/src/index.ts:92-107`），任何监听者返回 true 表示"我已对选中输入做了持久修改"（例如修剪掉一段），事务随即重新校验、重新定价、重试总结；无人恢复则失败。

### 3.6 稳定性检查（region.ts:431-468）

总结是异步的，期间会话可能被写入。两种严格度：

- **自动压缩**：`assertWholeSurfaceUnchanged`——要求整个表面逐节点不变，否则 `SurfaceChangedError` 作废重来；
- **手动压缩**：`assertSelectedSpanStable`——只要求选中区间仍是同一个"存在、连续、等价、平衡"的替换目标；期间新增的表面节点不影响摘要有效性。

### 3.7 收缩检查（region.ts:410-421）

总结文本经 `frameSummary` 包裹后估算 token，必须**严格小于**被替换区间的路由定价 token 总数，否则整个事务失败。这条检查保证压缩不会"越压越大"——模型若把大段内容抄回摘要，事务直接作废。

### 3.8 提交（region.ts:471-522）

同步连续写三个日志事件：

1. **`compaction/summary`**：完整审计记录——摘要文本、原始模型输出、`shadowedRange/shadowedSeqs`（被遮蔽的区间与逐个 seq）、`shadowedTokenCount`、provider/model/maxTokens/usage、`compactionId` 及可选的 `sourceCommandId`；
2. **`user/message`（检查点）**：带 `surfaceOp: { op: 'replace', startSeq, endSeq }`，表面层把区间替换成这一个节点；消息的 `source` 用 `compactCheckpointSource(compactionId, ...)` 构造（消息源类型 `compact-checkpoint`，`compaction/src/index.ts:25-29`），`sourceEventSeqs` 记录被替代的原始事件（血缘）；
3. **`compaction/end`**：释放锁。

失败路径也写 `compaction/end`（附 `error` 错误链，region.ts:240-251）——**每次尝试都留在日志里可追溯**；若关闭本身也失败，则故意留下未配对的 `start`（它就是锁，也是事故现场）。

检查点消息的文本框架（`frameSummary`，summarizer.ts:188-194）：开场白声明"这是自动生成的检查点，浓缩了前文，当作既定背景直接继续"，摘要包在 `<compacted-summary>` 标签里——这个标签正是 3.5 中二次压缩合并语义的识别锚点。

---

## 4. 缓存命中率：把总结调用做成"真前缀"

provider 的 KV cache 按最长公共前缀匹配，从第 0 个 token 起任何差异都会使后续全部失效。DSH 的总结调用为此做了三点：

1. **压缩区永远从最老处开始**（3.1），所以重放内容（system + 区间消息）是上一轮请求消息序列的**严格前缀**；
2. **system、tools、消息全部原样重建**，压缩指令只追加在尾部——前缀逐 token 一致，只有新增的指令是新鲜 token；
3. **确定性派生 + 稳定性检查**保证前缀不会拿过期内容去打缓存：消息由与正常请求同源的投影管线派生，总结期间表面被锁在快照状态。

> [!NOTE]
> 这条保证只覆盖**总结这次辅助调用**。压缩落地后，主线对话的下一条请求从检查点位置起就是新前缀了，替换点之后（含保留的尾部）需要重新预填——这是改写历史的固有代价。DSH 的缓解是只压最老区段，让一次性重读的上界等于被替换区间，换取后续每轮 prompt 持久变小。

---

## 5. 大块代码 / JSON 的处理：两层防线 + 图片旁路

上下文中的大段代码和 JSON 几乎都来自工具输出。DSH 用两层不同的机制处理，再配一条图片专用旁路。

### 5.1 第一层（总结之前）：工具结果修剪——按位置剪，不靠模型理解

`compaction-tool-result-pruner`（`src/index.ts:136`）在压力达标后、总结之前运行（溢出路径同样先跑）：

- 扫描当前表面上所有 `tool/result` 节点，文本内容超过 `thresholdChars`（默认 **8192** 字符，按 Unicode 码点计）的，确定性截为**头 4096 + 固定标记 + 尾 1024**：

  ```text
  \n\n[... tool result middle pruned ...]\n\n     // PRUNE_MARKER，config.ts:7
  ```

- 按码点而非 UTF-16 编码单元切片，不会劈开代理对（:99-109）；
- 落地方式与压缩同构：先写 `compaction/prune` 影子定价事件，再 append 带 `surfaceOp: replace` 的同型 `tool/result` 替换件，`sourceEventSeqs` 指向原节点（:160-171）。原始内容仍在日志里。

也就是说大 JSON 的"肚子"是被**原样丢弃**的——便宜、确定、可重放；留下的头 4K 通常还能看到 JSON 的结构开头，尾 1K 看到结尾。

### 5.2 第二层（总结）：指令级保全约定

进入总结的内容靠指令约束（3.5）：路径、命令、报错原文、标识符、数值、函数签名要求逐字保留；`Files and Code` 节记录"精确路径：为何重要、关键改动或片段"。这是一份**约定而不是机械保证**——一段代码是否完整存活取决于总结模型的判断。DSH 的隐含假设是：编码 agent 的精确内容本就落盘在文件里，摘要存"路径 + 为什么重要"，需要时再读文件。真正不打折的是**保留尾部**（默认最近 16%）：刚产生的代码/JSON 逐字不动，只有变老的部分才会衰减。收缩检查兜住最坏情况：模型把大段内容抄回摘要导致"越压越大"时，事务失败而非落地劣质压缩。

### 5.3 图片旁路：`IMAGE_OFFLOAD_REQUIRED`

图片不走文本总结——多模态请求可能因图片预算（而非 token）被 provider 拒绝。此时适配器返回规范错误码 `IMAGE_OFFLOAD_REQUIRED`，失败信息携带还需要省略多少张图（`packages/llm/llm/src/error.ts:169-175`）；`compaction-image-offload` 的 `offloadOldestImages` 按**最旧优先**选取保留中的输入图片，记录一次持久的 `image/offload` 决定（被省略是永久的），随后 agent 或总结器用重新派生的输入重试。

### 5.4 修不了的：单点超大消息

若保留尾里有一条巨大消息（或请求信封本身超限），表面压缩无能为力——`CompactionEngine` 的契约明确写道"单个超大的保留单元或请求信封无法通过表面压缩修复"（`compaction/src/index.ts:128-129`），此时如实返回 null / 保持原始错误。

---

## 6. 失败模型与可观测性

人工命令侧的错误分类（`ManualCompactionError`，`compaction/src/index.ts:35-64`），由 `command-compact` 映射为人话（`command-compact/src/index.ts:28`）：

| code | 含义 |
|---|---|
| `busy` | 已有压缩进行中，或 agent 非空闲 |
| `cancelled` | 被取消 |
| `changed` | 总结期间被选历史发生变化（事务作废） |
| `summary` | 无法产出更小的有效摘要（含收缩检查失败） |
| `commit` | 提交阶段未干净完成 |
| `persistence` | 压缩成功但落盘失败（flush 抛错） |

自动路径则"尽力而为、失败留痕"：压力触发的失败只告警放行回合；配置类错误（`TargetPressureConfigError`）按目标去重只告警一次；每次压缩尝试无论成败都在日志里留下 `compaction/start` / `compaction/end`（含错误链）事件对。UI 侧（`packages/client/ui-chat`、`ui-trajectory`）据此渲染压缩节点与轨迹。

---

## 7. 计量：路由定价与影子定价

压缩全程依赖单例 `ctx.tokenMeter`（`packages/llm/token-meter`），且对同一表面节点维护两种价格（region.ts:376-381 的注释）：

- **路由定价（`tokens`）**：按实际路由模型的计价规则估算——用于保留预算、范围选择、收缩比较等"决策"场景；
- **启发式定价（`heuristicTokens`）**：固定规则估算——用于**影子定价协议（shadow-price protocol）**：任何替换件（压缩检查点、修剪后的工具结果）落地时，紧邻地写一条 `compaction/prune` 类计量事件，报告被遮蔽节点的启发式价格，让纯消费者（如 O(1) 增量投影折叠）能同步扣减而无需维护逐节点状态。

约定俗成的分工原因：替换件是新增日志事件，投影折叠若要 O(1) 就不能回头重算旧节点，因此用与折叠自身追加逻辑一致的固定启发式计价；而"要不要压、压多少、压完是否真变小"这些决策则必须用真实路由价格才准确。

---

## 8. 设计评注

> [!WARN]
> 本节是个人分析观点，不是源码事实。

1. **压缩即事件溯源事务**。很多 agent 实现压缩时直接改内存 messages 数组，DSH 把每次压缩变成日志里一组可重放的事件（start/summary/checkpoint/end），换来的能力是：会话文件重放后表面完全重建、失败可追溯、UI 可从日志还原压缩史、人类转录与模型视图分离。代价是日志只增不减——压缩省的是上下文窗口，不是磁盘。
2. **"真前缀"是精巧但脆弱的约定**。它依赖"压缩区从最老处开始 + 表面在总结期间冻结 + 派生确定性"三个条件同时成立；任何一个被未来改动破坏（比如总结前插入了别的水falls修改），命中率就静默退化，而不会有任何报错。这是典型的"性能正确性"——值得在魔改时重点看护。
3. **衰减管理靠合并语义而非版本链**。旧检查点不保留独立身份，二次压缩时要求合并去旧（3.5）。这意味着久远细节会逐轮衰减——对编码场景是合理取舍（精确内容在文件里），但对"很久之前用户说过的一句话"这类信息，只有 `Critical Context` 一节兜底。
4. **失败开放（fail-open）的自动路径**。压缩失败不阻塞对话，宁可让上下文继续膨胀靠溢出兜底——把可用性放在了窗口卫生前面，与"压缩失败不重试到死"的重试预算（默认 1）一致。

---

## 附录 A：源码索引

| 文件（相对 `deepseek-harness/`） | 关键内容 | 行号（v0.2.1-rc.2） |
|---|---|---|
| `packages/compaction/compaction/src/index.ts` | `CompactionEngine` 抽象、`CompactionTrigger`、`ManualCompactionError`、`compaction/summary-error` 事件 | 32、35、48、92、119 |
| `packages/compaction/compaction/src/tool-pairing.ts` | 工具配对平衡折叠与缓存 | 29、72、112 |
| `packages/compaction/compaction-basic/src/index.ts` | 三个触发钩子、`compactIfNeeded` 压力/溢出路径、`compactNow` | 158、190、269、294、319、383 |
| `packages/compaction/compaction-basic/src/config.ts` | 默认值、`resolveCompactSpec` 阈值公式 | 20、23、75、153 |
| `packages/compaction/compaction-basic/src/region.ts` | 选区、压缩事务、稳定性/收缩检查、提交 | 117、173、337、361、387、431、471、544 |
| `packages/compaction/compaction-basic/src/summarizer.ts` | 指令模板、`summarizeWithLlm`、检查点框架 | 22、32、70、120、188 |
| `packages/compaction/compaction-tool-result-pruner/src/index.ts` | 工具结果修剪与影子定价落地 | 83、136 |
| `packages/compaction/command-compact/src/index.ts` | `/compact` 命令与错误映射 | 14、28 |
| `packages/compaction/compaction-image-offload/src/image-offload.ts` | 图片最旧优先永久省略 | 18 |
| `packages/core/session/src/surface.ts` | 表面模型、append-origin / replacement 区分 | 50、78、95、415 |
| `packages/core/agent-loop/src/agent.ts` | `preStep()`——`agent/pre-step` 的发出点 | 267 |
| `packages/llm/llm/src/error.ts` | `IMAGE_OFFLOAD_REQUIRED` 规范错误 | 169 |

## 附录 B：配置速查

**BasicCompactionConfig**（`compaction-basic`，均可被 `modelPolicies[].{provider,model}` 按 route 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `auto` | `true` | 自动压缩总开关 |
| `thresholdRatio` | `0.8` | 压力线占窗口比例 |
| `headroomTokens` | `65536` | 压缩余量；`maxTokens` 未设时兼作总结调用上限 |
| `retainRatio` / `retainTokens` | `0.16` / — | 尾部原样保留（二选一，互斥；须小于阈值） |
| `summarizationProvider` + `summarizationModel` | 空 | 总结模型（必须成对设置） |
| `maxTokens` | `= headroomTokens` | 总结调用输出上限 |
| `compactionRetries` | `1` | 压力路径压缩重试 |
| `maxOverflowRetries` | `1` | 溢出路径恢复重试 |

**ToolResultPruneConfig**（`compaction-tool-result-pruner`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `thresholdChars` | `8192` | 触发修剪的文本长度（Unicode 码点） |
| `headChars` | `4096` | 保留头部 |
| `tailChars` | `1024` | 保留尾部 |
