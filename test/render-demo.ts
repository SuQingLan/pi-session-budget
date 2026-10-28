// 离线渲染演示：把某个会话文件当作输入，跑一次 session-budget 的渲染，打印到终端。
// 用途：不启动 pi 也能检查费用/子代理/命中率的计算结果。
//
//   bun run test/render-demo.ts <session.jsonl> [agentDir]
//
// agentDir 默认为 PI_CODING_AGENT_DIR 或 ~/.pi/agent（用于读 cheapmodel-pricing.json 与 settings.json）。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const sessArg = process.argv[2];
if (!sessArg) {
	console.error("用法: bun run test/render-demo.ts <session.jsonl> [agentDir]");
	process.exit(1);
}
const SESS = resolve(sessArg);
const agentDir = process.argv[3] || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
// 扩展在模块加载时读取 agent 目录，所以必须先设好环境变量再动态 import
process.env.PI_CODING_AGENT_DIR = agentDir;
const ext = (await import("../extensions/session-budget.ts")).default;

const entries: any[] = [];
for (const line of readFileSync(SESS, "utf8").split("\n")) {
	if (!line.trim()) continue;
	let d: any;
	try {
		d = JSON.parse(line);
	} catch {
		continue;
	}
	if (d?.type === "message" && d.message?.role === "assistant") entries.push({ type: "message", message: d.message });
	else if (d?.type === "compaction" || d?.type === "branch_summary") entries.push({ type: d.type, usage: d.usage, timestamp: d.timestamp });
}

let latest: string[] = [];
const handlers: Record<string, any> = {};
const pi: any = {
	on: (ev: string, h: any) => {
		handlers[ev] = h;
	},
	registerCommand: () => {},
	appendEntry: () => {},
};
ext(pi);

const ctx: any = {
	sessionManager: {
		getEntries: () => entries,
		getSessionFile: () => SESS,
	},
	model: { provider: "magpie", id: "auto/claude-opus-5-5" },
	modelRegistry: { find: () => undefined },
	ui: {
		setWidget: (_k: string, lines: string[][]) => {
			latest = lines;
		},
		notify: (m: string) => console.log("[notify]", m),
	},
	getContextUsage: () => undefined,
};

console.log(`agentDir: ${agentDir}`);
await handlers["session_start"]({}, ctx);
console.log(latest.join("\n"));

const t0 = Date.now();
for (let i = 0; i < 20; i++) await handlers["message_end"]({}, ctx);
console.log(`\n20 次渲染耗时 ${Date.now() - t0} ms（子代理扫描 1 秒节流 + mtime 缓存）`);
