// 契约测试：扩展注册面 + 渲染入口 + /budget 命令的写入行为。
// 使用假的宿主（pi / ctx），不启动真实 pi，也不读写用户真实的 agent 目录：
// 每个测试自建临时 agent 目录 + sessions 目录，把 PI_CODING_AGENT_DIR 指向它，
// 再动态 import 一份全新的扩展实例，用完即清理——保证测试间隔离。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TS = 1767225600000; // 2026-01-01T00:00:00.000Z
const MODELS_PRICE = { cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 } };

let importSeq = 0;
/** 把 PI_CODING_AGENT_DIR 指到临时目录后动态 import 一份全新扩展实例（缓存穿透） */
async function loadExt(agentDir: string) {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.SESSION_BUDGET_DEBUG;
	return await import(`../../extensions/session-budget.ts?sb=${++importSeq}`);
}

/** 自建临时根目录，fn 结束后递归删除 */
async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "sb-"));
	try {
		await fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function makeHost() {
	const handlers: Record<string, any[]> = {};
	const commands: Record<string, any> = {};
	const appended: { type: string; data: any }[] = [];
	const pi: any = {
		on: (ev: string, h: any) => {
			(handlers[ev] ??= []).push(h);
		},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		appendEntry: (type: string, data: any) => {
			appended.push({ type, data });
		},
	};
	return { pi, handlers, commands, appended };
}

function makeCtx(opts: {
	entries?: any[];
	sessionFile?: string;
	model?: any;
	find?: (provider: string, model: string) => any;
	ui?: boolean;
} = {}) {
	const widgets: { key: string; lines: string[] }[] = [];
	const notes: { msg: string; level?: string }[] = [];
	const ctx: any = {
		sessionManager: {
			getEntries: () => opts.entries ?? [],
			getSessionFile: () => opts.sessionFile,
		},
		model: opts.model ?? { provider: "magpie", id: "deeps" },
		modelRegistry: {
			find: opts.find ?? (() => MODELS_PRICE),
		},
		getContextUsage: () => undefined,
	};
	if (opts.ui !== false) {
		ctx.ui = {
			setWidget: (key: string, lines: string[]) => widgets.push({ key, lines }),
			notify: (msg: string, level?: string) => notes.push({ msg, level }),
		};
	}
	return { ctx, widgets, notes };
}

async function fire(handlers: Record<string, any[]>, ev: string, ctx: any, event: any = {}) {
	for (const h of handlers[ev] ?? []) await h(event, ctx);
}

/** 捕获 SESSION_BUDGET_DEBUG 打到 stderr 的调试行 */
async function withDebug(fn: () => Promise<void>): Promise<string[]> {
	const errs: string[] = [];
	const orig = console.error;
	process.env.SESSION_BUDGET_DEBUG = "1";
	console.error = (...a: any[]) => errs.push(a.map(String).join(" "));
	try {
		await fn();
	} finally {
		console.error = orig;
		delete process.env.SESSION_BUDGET_DEBUG;
	}
	return errs;
}

/** 一条主会话 assistant entry（message.timestamp 用毫秒数，与子会话解析口径一致） */
function msgEntry(opts: { id: string; provider?: string; model?: string; ts?: number; usage: any }): any {
	return {
		type: "message",
		id: opts.id,
		timestamp: new Date(opts.ts ?? TS).toISOString(),
		message: {
			role: "assistant",
			provider: opts.provider ?? "magpie",
			model: opts.model ?? "deeps",
			timestamp: opts.ts ?? TS,
			usage: opts.usage,
		},
	};
}

/** 在临时根目录下搭 sessions/<proj>/<file>.jsonl 结构，返回主会话文件路径 */
function makeSessionTree(root: string, children: { name: string; lines: string[] }[]): { mainFile: string } {
	const sessions = join(root, "sessions");
	const mainDir = join(sessions, "proj-main");
	mkdirSync(mainDir, { recursive: true });
	const mainFile = join(mainDir, "main.jsonl");
	writeFileSync(mainFile, JSON.stringify({ type: "session", id: "main" }) + "\n", "utf8");
	for (const c of children) {
		const dir = join(sessions, c.name);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "child.jsonl");
		const header = { type: "session", id: c.name, parentSession: mainFile };
		writeFileSync(file, [JSON.stringify(header), ...c.lines].join("\n") + "\n", "utf8");
	}
	return { mainFile };
}

test("导出面：default + 具名能力", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		assert.equal(typeof mod.default, "function");
		assert.equal(typeof mod.usageFingerprint, "function");
		assert.equal(typeof mod.parseUsageText, "function");
		assert.equal(typeof mod.emptyCostSplit, "function");
		assert.equal(typeof mod.addToSplit, "function");
	});
});

test("注册了名为 budget 的命令", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, commands } = makeHost();
		mod.default(pi);
		assert.ok(commands["budget"], "应注册 budget 命令");
		assert.equal(typeof commands["budget"].handler, "function");
	});
});

test("session_start → message_end 触发 setWidget，且 message_end 使调用次数 +1", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, handlers } = makeHost();
		mod.default(pi);
		const entries = [msgEntry({ id: "m1", usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, cost: { total: 12.34 } } })];
		const { ctx, widgets } = makeCtx({ entries });
		await fire(handlers, "session_start", ctx);
		assert.ok(widgets.length >= 1, "session_start 应调用 setWidget");
		const before = widgets.length;
		await fire(handlers, "message_end", ctx, { message: { role: "assistant", usage: { input: 1 }, provider: "magpie", model: "deeps" } });
		assert.equal(widgets.length, before + 1, "message_end 应使 setWidget 调用次数 +1");
		const last = widgets[widgets.length - 1];
		assert.equal(last.key, "session-budget");
		const joined = last.lines.join("\n");
		assert.ok(joined.includes("💰"), `应含 💰：${joined}`);
		assert.ok(joined.includes("🔢"), `应含 🔢：${joined}`);
		assert.ok(joined.includes("次调用"), `应含调用次数：${joined}`);
	});
});

test("models.json 单价（估算）时总额带 ≈ 前缀", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, handlers } = makeHost();
		mod.default(pi);
		const entries = [msgEntry({ id: "m1", usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, cost: { total: 12.34 } } })];
		const { ctx, widgets } = makeCtx({ entries });
		await fire(handlers, "session_start", ctx);
		const joined = widgets[widgets.length - 1].lines.join("\n");
		assert.ok(/💰 ≈\$/.test(joined), `估算口径应有 ≈ 前缀：${joined}`);
	});
});

test("只有 usage.cost.total（真实成本）时不带 ≈ 前缀", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, handlers } = makeHost();
		mod.default(pi);
		const entries = [msgEntry({ id: "m1", usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, cost: { total: 12.34 } } })];
		const { ctx, widgets } = makeCtx({ entries, find: () => undefined });
		await fire(handlers, "session_start", ctx);
		const joined = widgets[widgets.length - 1].lines.join("\n");
		assert.ok(/\$12\.34/.test(joined), `应显示真实成本 $12.34：${joined}`);
		assert.ok(!joined.includes("≈"), `真实成本不应带 ≈：${joined}`);
	});
});

test("budget 5 → appendEntry 写入 usd: 5", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, commands, appended } = makeHost();
		mod.default(pi);
		const { ctx, notes } = makeCtx({ entries: [msgEntry({ id: "m1", usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, cost: { total: 12.34 } } })] });
		await commands["budget"].handler("5", ctx);
		assert.equal(appended.length, 1);
		assert.equal(appended[0].type, "session-budget");
		assert.equal(appended[0].data.usd, 5);
		assert.equal(appended[0].data.cur, "¥");
		assert.ok(notes.some((n) => n.msg.includes("成本构成：")), "输出末尾应有成本构成行");
	});
});

test("budget off → appendEntry 写入 usd: null", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, commands, appended } = makeHost();
		mod.default(pi);
		const { ctx } = makeCtx({ entries: [] });
		await commands["budget"].handler("off", ctx);
		assert.equal(appended.length, 1);
		assert.equal(appended[0].data.usd, null);
	});
});

test("budget 查看：成本构成行位于输出最后一行且格式固定", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, commands } = makeHost();
		mod.default(pi);
		const { ctx, notes } = makeCtx({ entries: [msgEntry({ id: "m1", usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, cost: { total: 12.34 } } })], find: () => undefined });
		await commands["budget"].handler("", ctx);
		const msg = notes[notes.length - 1].msg;
		const lines = msg.split("\n");
		assert.ok(lines.length >= 2, msg);
		assert.equal(lines[lines.length - 1], "成本构成：真实 $12.34 · 估算 ¥0.00");
		assert.ok(lines[lines.length - 1].startsWith("成本构成："), "构成行应位于最后一行");
	});
});

test("ui 缺失时渲染不抛异常", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, handlers } = makeHost();
		mod.default(pi);
		const { ctx } = makeCtx({ entries: [], ui: false });
		await assert.doesNotReject(() => fire(handlers, "session_start", ctx));
		await assert.doesNotReject(() => fire(handlers, "message_end", ctx, {}));
		await assert.doesNotReject(() => fire(handlers, "turn_end", ctx));
		await assert.doesNotReject(() => fire(handlers, "agent_end", ctx));
	});
});

// 去重集成：子代理会话文件里与主会话完全相同的 entry（fork/clone 副本）不计入 token / 费用。
test("子代理里与主会话重复的 entry 被去重（dupSkipped），独有 entry 照计", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const dupUsage = { input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 100_000, cost: { total: 12.34 } };
		const dupMessage = { role: "assistant", provider: "magpie", model: "deeps", timestamp: TS, usage: dupUsage };
		const uniqUsage = { input: 10, output: 2_000_000, cacheRead: 0, cacheWrite: 0 };
		const uniqMessage = { role: "assistant", provider: "magpie", model: "deeps", timestamp: TS + 1000, usage: uniqUsage };
		const { mainFile } = makeSessionTree(root, [
			{
				name: "proj-child",
				lines: [
					JSON.stringify({ type: "custom", customType: "pi-web:subagent", data: { profile: "worker" } }),
					JSON.stringify({ type: "message", id: "aaa111", timestamp: new Date(TS).toISOString(), message: dupMessage }),
					JSON.stringify({ type: "message", id: "bbb222", timestamp: new Date(TS + 1000).toISOString(), message: uniqMessage }),
				],
			},
		]);
		const mainEntries = [
			{ type: "session", id: "s1" },
			{ type: "message", id: "aaa111", timestamp: new Date(TS).toISOString(), message: dupMessage },
		];
		const mod = await loadExt(agentDir);
		const { pi, handlers } = makeHost();
		mod.default(pi);
		const { ctx, widgets } = makeCtx({ entries: mainEntries, sessionFile: mainFile });
		const errs = await withDebug(() => fire(handlers, "session_start", ctx));
		assert.ok(widgets.length >= 1, "session_start 应调用 setWidget");
		const lines = widgets[widgets.length - 1].lines;
		const subLine = lines.find((l) => l.startsWith("🤖 子代理"));
		assert.ok(subLine, `应有子代理行：${lines.join("\n")}`);
		const dbg = errs.join("\n");
		assert.match(dbg, /子代理 1 个/, `应识别到 1 个子会话：${dbg}`);
		assert.match(dbg, /dupSkipped 1\b/, `应有 1 条被去重：${dbg}`);
		assert.ok(subLine.includes("1 次调用"), `只应计 1 次调用：${subLine}`);
		assert.ok(subLine.includes("入 10 "), `入 token 只应有独有那条的 10：${subLine}`);
		assert.ok(subLine.includes("出 2.00M"), `出 token 只应有独有那条的 2.00M：${subLine}`);
		assert.ok(subLine.includes("≈$4.00"), `费用只应含独有那条的 $4.00：${subLine}`);
		assert.ok(!subLine.includes("1.00M"), `重复那条的输入不应出现：${subLine}`);
	});
});

// E1-1：摘要副本去重（主会话 compaction 与子会话同 id 同 usage 同 timestamp → 只计一次）
test("摘要副本去重：同 id 同 usage 的 compaction 在主/子会话只计一次", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const summaryUsage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 };
		const { mainFile } = makeSessionTree(root, [
			{ name: "proj-child", lines: [JSON.stringify({ type: "compaction", id: "comp-1", timestamp: new Date(TS).toISOString(), usage: summaryUsage })] },
		]);
		const mainEntries = [
			{ type: "session", id: "s1" },
			{ type: "compaction", id: "comp-1", timestamp: new Date(TS).toISOString(), usage: summaryUsage },
		];
		const mod = await loadExt(agentDir);
		const { pi, handlers } = makeHost();
		mod.default(pi);
		const { ctx, widgets } = makeCtx({ entries: mainEntries, sessionFile: mainFile });
		const errs = await withDebug(() => fire(handlers, "session_start", ctx));
		const lines = widgets[widgets.length - 1].lines;
		const subLine = lines.find((l) => l.startsWith("🤖 子代理"));
		assert.ok(subLine, `应有子代理行：${lines.join("\n")}`);
		assert.match(errs.join("\n"), /dupSkipped 1\b/, `dupSkipped 应为 1：${errs.join("\n")}`);
		assert.ok(subLine.includes("0 次调用"), `重复的摘要应被去重，0 次调用：${subLine}`);
		// 主会话 token 只计一次（不因子会话副本翻倍）
		const joined = lines.join("\n");
		assert.ok(joined.includes("入 100 "), `主会话输入只计一次 100：${joined}`);
		assert.ok(joined.includes("出 20 "), `主会话输出只计一次 20：${joined}`);
	});
});

// E1-2：不同子会话的同 usage 同时间戳摘要（id 不同）不被误合并
test("不同子会话的同 usage 摘要（id 不同）不被误合并", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const iso = new Date(TS).toISOString();
		const usage = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 };
		const { mainFile } = makeSessionTree(root, [
			{ name: "proj-a", lines: [JSON.stringify({ type: "compaction", id: "comp-a", timestamp: iso, usage })] },
			{ name: "proj-b", lines: [JSON.stringify({ type: "compaction", id: "comp-b", timestamp: iso, usage })] },
		]);
		const mod = await loadExt(agentDir);
		const { pi, handlers } = makeHost();
		mod.default(pi);
		const { ctx, widgets } = makeCtx({ entries: [{ type: "session", id: "s1" }], sessionFile: mainFile });
		const errs = await withDebug(() => fire(handlers, "session_start", ctx));
		const lines = widgets[widgets.length - 1].lines;
		const subLine = lines.find((l) => l.startsWith("🤖 子代理"));
		assert.ok(subLine, `应有子代理行：${lines.join("\n")}`);
		assert.ok(subLine.includes("2 次调用"), `两条摘要都应计入：${subLine}`);
		assert.ok(subLine.includes("入 20 "), `输入应为 10+10=20：${subLine}`);
		assert.ok(subLine.includes("出 8 "), `输出应为 4+4=8：${subLine}`);
		assert.doesNotMatch(errs.join("\n"), /dupSkipped [1-9]/, `不应误去重：${errs.join("\n")}`);
	});
});

// E1-3a：usage 无 cost 字段 → 「真实成本未记录」，widget 总额带 ≈
test("usage 无 cost 字段 → 构成「真实成本未记录」，widget 带 ≈", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, handlers, commands } = makeHost();
		mod.default(pi);
		const { ctx, widgets, notes } = makeCtx({ entries: [msgEntry({ id: "m1", usage: { input: 100, output: 20 } })], find: () => undefined });
		await fire(handlers, "session_start", ctx);
		const joined = widgets[widgets.length - 1].lines.join("\n");
		assert.ok(/💰 ≈/.test(joined), `无真实成本时应带 ≈：${joined}`);
		await commands["budget"].handler("", ctx);
		const msg = notes[notes.length - 1].msg;
		assert.ok(msg.includes("成本构成：真实成本未记录 · 估算 ¥0.00"), `构成应显示真实成本未记录：${msg}`);
	});
});

// E1-3b：usage 有 cost.total=0 → 显式真实 0，widget 不带 ≈
test("usage 有 cost.total=0 → 构成「真实 $0.0000」，widget 不带 ≈", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mod = await loadExt(agentDir);
		const { pi, handlers, commands } = makeHost();
		mod.default(pi);
		const { ctx, widgets, notes } = makeCtx({ entries: [msgEntry({ id: "m1", usage: { input: 100, output: 20, cost: { total: 0 } } })], find: () => undefined });
		await fire(handlers, "session_start", ctx);
		const joined = widgets[widgets.length - 1].lines.join("\n");
		assert.ok(joined.includes("💰"), joined);
		assert.ok(!joined.includes("≈"), `显式 0 是真实成本，不应带 ≈：${joined}`);
		await commands["budget"].handler("", ctx);
		const msg = notes[notes.length - 1].msg;
		assert.ok(msg.includes("成本构成：真实 $0.0000 · 估算 ¥0.00"), `构成应显示真实 $0.0000：${msg}`);
	});
});

// E1-4：主真实 + 子估算 → 主行不带 ≈、子代理行带 ≈
test("主真实 + 子估算：主行不带 ≈、子代理行带 ≈", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const { mainFile } = makeSessionTree(root, [
			{
				name: "proj-child",
				lines: [
					JSON.stringify({
						type: "message",
						id: "child1",
						timestamp: new Date(TS).toISOString(),
						message: { role: "assistant", provider: "subprov", model: "submodel", timestamp: TS, usage: { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 } },
					}),
				],
			},
		]);
		const mainEntries = [
			{ type: "session", id: "s1" },
			msgEntry({ id: "main1", provider: "mainprov", model: "mainmodel", usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } } }),
		];
		const mod = await loadExt(agentDir);
		const { pi, handlers } = makeHost();
		mod.default(pi);
		const find = (p: string) => (p === "subprov" ? MODELS_PRICE : undefined);
		const { ctx, widgets } = makeCtx({ entries: mainEntries, sessionFile: mainFile, find });
		await fire(handlers, "session_start", ctx);
		const lines = widgets[widgets.length - 1].lines;
		const mainLine = lines[0];
		assert.ok(mainLine.includes("💰 $7.00"), `主行总额应为 $7.00：${mainLine}`);
		assert.ok(mainLine.includes("(主 $5.00 + 子 $2.00)"), `主行构成：${mainLine}`);
		assert.ok(!mainLine.includes("≈"), `主行有真实成本不应带 ≈：${mainLine}`);
		const subLine = lines.find((l) => l.startsWith("🤖 子代理"));
		assert.ok(subLine, lines.join("\n"));
		assert.ok(subLine.includes("≈$2.00"), `子代理纯估算应带 ≈：${subLine}`);
	});
});

// E1-5：/budget 构成金额与 widget 总额口径一致（同一通知内不出现两种口径）
test("/budget 构成金额与 widget 总额一致", async () => {
	await withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const { mainFile } = makeSessionTree(root, [
			{
				name: "proj-child",
				lines: [
					JSON.stringify({
						type: "message",
						id: "child1",
						timestamp: new Date(TS).toISOString(),
						message: { role: "assistant", provider: "subprov", model: "submodel", timestamp: TS, usage: { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 } },
					}),
				],
			},
		]);
		const mainEntries = [
			{ type: "session", id: "s1" },
			msgEntry({ id: "main1", provider: "mainprov", model: "mainmodel", usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } } }),
		];
		const mod = await loadExt(agentDir);
		const { pi, handlers, commands } = makeHost();
		mod.default(pi);
		const find = (p: string) => (p === "subprov" ? MODELS_PRICE : undefined);
		const { ctx, widgets, notes } = makeCtx({ entries: mainEntries, sessionFile: mainFile, find });
		await fire(handlers, "session_start", ctx);
		const widgetLine = widgets[widgets.length - 1].lines[0];
		assert.match(widgetLine, /\$7\.00/, `widget 总额 $7.00：${widgetLine}`);
		await commands["budget"].handler("", ctx);
		const msg = notes[notes.length - 1].msg;
		const lines = msg.split("\n");
		const breakdown = lines[lines.length - 1];
		assert.equal(breakdown, "成本构成：真实 $5.00 · 估算 $2.00");
		assert.match(breakdown, /真实 \$5\.00/);
		assert.match(breakdown, /估算 \$2\.00/);
		// 通知首行的子代理金额与构成里的估算额一致（真实 5 + 估算 2 = 总额 7）
		assert.ok(lines[0].includes("子代理 1 个 / $2.00"), `通知首行子代理金额应与构成一致：${lines[0]}`);
	});
});
