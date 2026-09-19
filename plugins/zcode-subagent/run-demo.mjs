// run-demo.mjs — 读取 demo-task.txt 作为自包含任务书,委派给 zcode 子代理
import { readFileSync } from "node:fs";
import { zcodeTask } from "./zcode-bridge.mjs";

const task = readFileSync(new URL("./demo-task.txt", import.meta.url), "utf8");
const r = await zcodeTask(task, {
  cwd: "D:\\deepseek harness\\zcode-demo",
  timeoutMs: 30 * 60_000,
});
console.log(JSON.stringify(r, null, 2));
