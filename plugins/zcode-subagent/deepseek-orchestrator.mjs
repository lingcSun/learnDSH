// deepseek-orchestrator.mjs — DeepSeek 主 agent 编排循环示例
// 用法: DEEPSEEK_API_KEY=sk-xxx node deepseek-orchestrator.mjs "复杂任务目标"
// DeepSeek 走 OpenAI 兼容接口；如果你已有 harness，只需把 TOOLS + 工具执行分支移植过去。
import { zcodeTask } from "./zcode-bridge.mjs";

const API = "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const MAX_ROUNDS = 40;

const TOOLS = [{
  type: "function",
  function: {
    name: "zcode_subagent",
    description:
      "委派 ZCode 子代理（GLM-5.3，具备读写文件、执行命令的完整能力）完成一个编码子任务。" +
      "子代理看不到我们的对话，task 必须自包含：背景、目标、涉及文件路径、验收标准。" +
      "返回 JSON：status=done/timeout/error，sessionId 用于续接同一子代理继续迭代。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "完整、自包含的任务描述" },
        workspace: { type: "string", description: "子代理工作目录的绝对路径" },
        resume_session: { type: "string", description: "可选，上一次返回的 sessionId，用于同一任务的迭代修改" },
        timeout_minutes: { type: "number", description: "可选，超时分钟数，默认 15" },
      },
      required: ["task"],
    },
  },
}];

const SYSTEM = `你是编排主 agent，通过 zcode_subagent 工具把复杂编码任务委派给 ZCode 子代理执行。
原则：
1. 先在内部拆解任务和依赖顺序，再逐个委派；有依赖的子任务串行，独立的可以并行（多次工具调用）。
2. 每个委派的 task 必须自包含：写清背景、要改哪些文件、验收标准，不假设子代理知道任何上下文。
3. 同一任务的返工迭代传 resume_session 续接；互不相关的子任务各开新会话，避免上下文污染。
4. 子代理返回后先验收（对照验收标准，必要时委派专门的检查任务），全部通过再汇总最终答复。
5. 子代理拥有所在 workspace 内的完整执行权限，workspace 必须指向明确的项目目录，不要用系统盘根目录。`;

async function callDeepSeek(messages) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS }),
  });
  if (!r.ok) throw new Error(`DeepSeek API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function main() {
  const goal = process.argv[2];
  if (!goal || !process.env.DEEPSEEK_API_KEY) {
    console.error('用法: DEEPSEEK_API_KEY=sk-... node deepseek-orchestrator.mjs "目标"');
    process.exit(1);
  }
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: goal },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await callDeepSeek(messages);
    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      console.log("\n=== 主 agent 最终答复 ===\n" + msg.content);
      return;
    }
    for (const tc of msg.tool_calls) {
      if (tc.function.name !== "zcode_subagent") continue;
      const p = JSON.parse(tc.function.arguments);
      console.error(`[委派] ${p.task.slice(0, 60).replace(/\n/g, " ")}...${p.resume_session ? `（续接 ${p.resume_session}）` : ""}`);

      const result = await zcodeTask(p.task, {
        cwd: p.workspace,
        resume: p.resume_session,
        timeoutMs: (p.timeout_minutes ?? 15) * 60_000,
      });

      // 无论成败都把 sessionId 带回去，主 agent 可以决定续接重试
      const payload = result.ok
        ? { status: "done", sessionId: result.sessionId, report: result.response, totalTokens: result.usage?.totalTokens }
        : { status: result.timedOut ? "timeout" : "error", detail: result.error, stdoutTail: result.stdoutTail };

      console.error(`[完成] status=${payload.status}${payload.totalTokens ? ` tokens=${payload.totalTokens}` : ""}`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(payload) });
    }
  }
  console.error("达到最大编排轮数，停止。");
}

main();
