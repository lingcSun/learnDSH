// zcode-bridge.mjs — 把 ZCode CLI 封装为可编程子代理
// 适配 zcode 0.16.5（D:\ZCode 桌面版内嵌）。实测可用参数：
//   --prompt --json --cwd --resume --mode --attach
// 实测不可用（帮助里有但解析器拒绝，勿传）：
//   --max-turns --allowed-tools --disallowed-tools --settings
// 权限现实：无头模式只有 yolo 能执行工具；build/edit/plan 下工具一律被拒
// （"No permission client configured"）。安全边界靠 workspace 隔离。
import { spawn } from "node:child_process";

const ZCODE_CJS = "D:\\ZCode\\resources\\glm\\zcode.cjs";

/**
 * 委派一个任务给 zcode 子代理。
 * @param {string} task  自包含的任务描述（子代理看不到调用方的对话历史）
 * @param {{cwd?:string, resume?:string, mode?:string, timeoutMs?:number, attach?:string[]}} opts
 * @returns {Promise<{ok:true, sessionId:string, response:string, usage:object}
 *                  |{ok:false, error:string, timedOut?:boolean}>}
 */
export function zcodeTask(task, opts = {}) {
  const {
    cwd,
    resume, // "sess_xxx"，续接同一子代理的多轮对话
    mode = "yolo",
    timeoutMs = 15 * 60_000,
    attach = [],
  } = opts;

  const args = [ZCODE_CJS, "--prompt", task, "--json", "--mode", mode];
  if (cwd) args.push("--cwd", cwd);
  if (resume) args.push("--resume", resume);
  for (const f of attach) args.push("--attach", f);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, timedOut: true, error: `超过 ${Math.round(timeoutMs / 1000)}s 未完成，已终止`, stdoutTail: out.slice(-800) });
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e) }); });
    child.on("close", () => {
      clearTimeout(timer);
      const json = lastJsonBlock(out);
      if (json?.response !== undefined) {
        resolve({ ok: true, sessionId: json.sessionId, response: json.response, usage: json.usage });
      } else {
        resolve({ ok: false, error: err.trim() || "无 JSON 输出", stdoutTail: out.slice(-800) });
      }
    });
  });
}

/** --json 输出应为单个 JSON 对象；容错提取 stdout 中最后一个可解析的 JSON 块 */
function lastJsonBlock(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const i = trimmed.lastIndexOf("\n{");
  if (i >= 0) { try { return JSON.parse(trimmed.slice(i + 1)); } catch {} }
  return null;
}

// 直接运行时进入手动调试模式：node zcode-bridge.mjs "任务" [--cwd 目录] [--resume sess_xxx]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const task = process.argv[2];
  if (!task) { console.error('用法: node zcode-bridge.mjs "任务" [--cwd 目录] [--resume sess_xxx]'); process.exit(1); }
  const get = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  const result = await zcodeTask(task, { cwd: get("--cwd"), resume: get("--resume") });
  console.log(JSON.stringify(result, null, 2));
}
