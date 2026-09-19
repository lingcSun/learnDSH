// zcode_subagent 原生工具 —— DSH 动态插件(Host 半区)
// 本文件只是一个函数体:宿主把它放进
//   function (ctx, harness, console, btoa, atob, TextEncoder, TextDecoder) { ... }
// 内执行;函数体返回插件对象,由宿主装载。
// 注入「子进程」与「定时器」两个服务:前者启动 ZCode CLI,后者实现工具内 deadline。
return {
  inject: ['subprocess', 'timer'],
  apply(ctx) {
    const definition = {
      name: 'zcode_subagent',
      description: '委派一个 ZCode 子代理执行编码任务:通过 ZCode CLI 在指定工作区内完成多步骤的代码实现、排查与修改,子代理拥有工作区内完整的文件读写与命令执行能力;所用模型与供应商跟随 ZCode CLI 自身配置,本工具不指定模型。task 必须自包含:子代理看不到调用方的对话历史,请把全部背景、目标、约束与验收标准写进 task。可用 resume_session 传入上次返回的 sessionId,续接同一个子代理对话,在同一任务上多轮迭代。子代理任务耗时以分钟计,不要用它处理几秒钟就能回答的小问题。',
      parameters: {
        task: {
          type: 'string',
          description: '自包含的任务描述:子代理看不到调用方对话,需包含完整背景、目标、约束与验收标准',
          required: true,
        },
        workspace: {
          type: 'string',
          description: '子代理工作目录的绝对路径(以盘符或 / 、\\ 开头),默认 "D:\\deepseek harness"',
        },
        resume_session: {
          type: 'string',
          description: '上次调用返回的 sessionId,用于续接同一子代理对话',
        },
        timeout_minutes: {
          type: 'number',
          description: '子代理运行时限(分钟):默认 15,下限 0.5,上限 30,超出范围会被钳制',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['done', 'timeout', 'cancelled', 'error'] },
            sessionId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            response: { type: 'string' },
            usage: {
              type: 'object',
              properties: {
                totalTokens: { type: 'number' },
                inputTokens: { type: 'number' },
                outputTokens: { type: 'number' },
                modelRequestCount: { type: 'number' },
              },
              additionalProperties: false,
            },
            truncated: { type: 'boolean' },
            detail: { type: 'string' },
            stdoutTail: { type: 'string' },
          },
          additionalProperties: false,
        },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
      },
      timeoutMs: 31 * 60 * 1000,
      async execute(args, exec) {
        args = args || {};
        const errText = (e) => {
          if (e instanceof Error) return e.message || e.name || '未知错误';
          if (typeof e === 'string') return e;
          try { return JSON.stringify(e); } catch (err) { return String(e); }
        };
        const pickUsage = (u) => {
          const out = {};
          if (u && typeof u === 'object') {
            const keys = ['totalTokens', 'inputTokens', 'outputTokens', 'modelRequestCount'];
            for (let i = 0; i < keys.length; i++) {
              const v = u[keys[i]];
              if (typeof v === 'number' && Number.isFinite(v)) out[keys[i]] = v;
            }
          }
          return out;
        };

        // 1. 参数校验:非法入参一律返回 error,不 throw
        const task = typeof args.task === 'string' ? args.task : '';
        if (task.trim() === '') {
          return { status: 'error', detail: 'task 不能为空' };
        }
        const workspace = typeof args.workspace === 'string' ? args.workspace : 'D:\\deepseek harness';
        if (!/^([A-Za-z]:|[\\/])/.test(workspace)) {
          return { status: 'error', detail: 'workspace 非法:必须是绝对路径(以盘符或 / 、\\ 开头),实际收到 ' + JSON.stringify(workspace) };
        }
        const resume = typeof args.resume_session === 'string' ? args.resume_session.trim() : '';
        let minutes = typeof args.timeout_minutes === 'number' && Number.isFinite(args.timeout_minutes) ? args.timeout_minutes : 15;
        minutes = Math.min(30, Math.max(0.5, minutes));

        // 2. 解析 node 可执行路径并组装 argv
        let nodePath;
        try {
          nodePath = await ctx.subprocess.resolveExecutable('node');
        } catch (err) {
          if (exec && exec.signal && exec.signal.aborted) return { status: 'cancelled' };
          return { status: 'error', detail: '解析 node 可执行文件失败:' + errText(err) };
        }
        const argv = [nodePath, 'D:\\ZCode\\resources\\glm\\zcode.cjs', '--prompt', task, '--json', '--mode', 'yolo', '--cwd', workspace];
        if (resume !== '') argv.push('--resume', resume);

        // 3. 超时与取消:一个 AbortController 同时汇聚内部 deadline 与调用方取消
        const callerSignal = (exec && exec.signal) || new AbortController().signal;
        const ac = new AbortController();
        let timedOut = false;
        const forwardAbort = () => { ac.abort(); };
        if (callerSignal.aborted) {
          ac.abort();
        } else {
          callerSignal.addEventListener('abort', forwardAbort, { once: true });
        }
        const disposeTimer = ctx.timeout(() => { timedOut = true; ac.abort(); }, minutes * 60 * 1000);

        try {
          if (callerSignal.aborted) return { status: 'cancelled' };

          // 4. 在 workspace 下启动子代理;done 仅在 spawn 级失败时 reject
          let handle;
          try {
            handle = ctx.subprocess.spawn({
              argv: argv,
              cwd: workspace,
              stdio: { stdin: 'ignore', stdout: { maxBytes: 524288 }, stderr: { maxBytes: 16384 } },
              graceMs: 5000,
              signal: ac.signal,
            });
          } catch (err) {
            if (timedOut) return { status: 'timeout', detail: '超时已终止,可用 resume_session 续接', sessionId: null };
            if (callerSignal.aborted) return { status: 'cancelled' };
            return { status: 'error', detail: 'spawn 失败:' + errText(err) };
          }

          let exitInfo = null;
          try {
            exitInfo = await handle.done;
          } catch (err) {
            if (timedOut) return { status: 'timeout', detail: '超时已终止,可用 resume_session 续接', sessionId: null };
            if (callerSignal.aborted) return { status: 'cancelled' };
            return { status: 'error', detail: 'spawn 失败:' + errText(err) };
          }

          // 5. 等整棵进程树退出、管道排空后再读 stdout
          try {
            await handle.waitForExit();
          } catch (err) {
            return { status: 'error', detail: '等待子代理进程树退出失败:' + errText(err) };
          }
          let stdoutText = '';
          try {
            stdoutText = handle.collected.stdout.readFrom(0).text || '';
          } catch (err) {
            stdoutText = '';
          }

          // 解析最后一个可解析的 JSON 块:先整体 parse,失败则取最后一个 "\n{" 之后的部分再 parse
          let parsed;
          try { parsed = JSON.parse(stdoutText); } catch (err) { parsed = undefined; }
          if (parsed === undefined) {
            const idx = stdoutText.lastIndexOf('\n{');
            if (idx >= 0) {
              try { parsed = JSON.parse(stdoutText.slice(idx + 1)); } catch (err) { parsed = undefined; }
            }
          }

          // 6. 分类返回
          if (parsed && typeof parsed === 'object' && typeof parsed.response === 'string') {
            const raw = parsed.response;
            const result = {
              status: 'done',
              sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
              response: raw.length > 60000 ? raw.slice(0, 60000) : raw,
              usage: pickUsage(parsed.usage),
            };
            if (raw.length > 60000) result.truncated = true;
            return result;
          }
          if (timedOut) return { status: 'timeout', detail: '超时已终止,可用 resume_session 续接', sessionId: null };
          if (callerSignal.aborted) return { status: 'cancelled' };

          let detail = '未能从子代理输出解析出结果 JSON(exitCode=' + (exitInfo && typeof exitInfo.exitCode === 'number' ? exitInfo.exitCode : 'null');
          if (exitInfo && typeof exitInfo.signal === 'string' && exitInfo.signal !== '') detail += ', signal=' + exitInfo.signal;
          detail += ')';
          try {
            const stderrText = handle.collected.stderr.readFrom(0).text || '';
            if (stderrText !== '') detail += ';stderr 尾部:' + (stderrText.length > 400 ? '...' + stderrText.slice(-400) : stderrText);
          } catch (err) {
            // stderr 读取失败只影响诊断信息,不影响本分支
          }
          const stdoutTail = stdoutText.length > 800 ? stdoutText.slice(-800) : stdoutText;
          return { status: 'error', detail: detail, stdoutTail: stdoutTail };
        } finally {
          // 正常结束 / 超时 / 调用方取消:统一清理定时器并移除 abort 监听
          disposeTimer();
          callerSignal.removeEventListener('abort', forwardAbort);
        }
      },
    };
    harness.registerTool(ctx, harness.defineTool(definition));
  },
};
