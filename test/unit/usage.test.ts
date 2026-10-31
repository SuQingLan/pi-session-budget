// 解析加固：parseUsageText 的记录抽取、坏行计数、超长行、compaction 不读 retainedTail
import test from "node:test";
import assert from "node:assert/strict";
import { parseUsageText, parseUsageLine } from "../../extensions/session-budget.ts";

const TS = 1767225600000; // 2026-01-01T00:00:00.000Z

function assistantLine(over: Record<string, any> = {}): string {
	return JSON.stringify({
		type: "message",
		id: "entry-1",
		timestamp: new Date(TS).toISOString(),
		message: {
			role: "assistant",
			provider: "magpie",
			model: "deeps",
			timestamp: TS,
			usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: { total: 0.5 } },
			...over,
		},
	});
}

test("正常 assistant 行 → 1 条 record，字段齐全", () => {
	const r = parseUsageText(assistantLine());
	assert.equal(r.badLines, 0);
	assert.equal(r.hasSubagentMarker, false);
	assert.equal(r.records.length, 1);
	const rec = r.records[0];
	assert.equal(rec.id, "entry-1");
	assert.equal(rec.ts, TS);
	assert.equal(rec.provider, "magpie");
	assert.equal(rec.model, "deeps");
	assert.equal(rec.usage.input, 100);
});

test("时间戳为 ISO 字符串时归一成毫秒", () => {
	const line = JSON.stringify({
		type: "message",
		id: "entry-2",
		message: { role: "assistant", provider: "p", model: "m", timestamp: "2026-01-01T00:00:00.000Z", usage: { input: 1 } },
	});
	assert.equal(parseUsageText(line).records[0].ts, TS);
});

test("坏行 → badLines=1，有效记录不丢", () => {
	const text = ["{\"type\":\"message\",", assistantLine(), "not json at all"].join("\n");
	const r = parseUsageText(text);
	assert.equal(r.badLines, 2);
	assert.equal(r.records.length, 1);
});

test("超长行（maxLineBytes=100）→ 跳过并计入 badLines", () => {
	const longLine = JSON.stringify({ type: "message", id: "long", padding: "a".repeat(200) });
	const shortLine = JSON.stringify({ type: "message", id: "ok", message: { role: "assistant", usage: { input: 1 } } });
	assert.ok(Buffer.byteLength(shortLine) <= 100);
	const r = parseUsageText([longLine, shortLine].join("\n"), { maxLineBytes: 100 });
	assert.equal(r.badLines, 1);
	assert.equal(r.records.length, 1);
	assert.equal(r.records[0].id, "ok");
});

test("空行不计入 badLines", () => {
	assert.equal(parseUsageText("\n\n  \n").badLines, 0);
});

test("compaction 行 → 计 1 条，retainedTail 里的 usage 不计入", () => {
	const line = JSON.stringify({
		type: "compaction",
		timestamp: new Date(TS).toISOString(),
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
		retainedTail: [
			{ type: "message", message: { role: "assistant", usage: { input: 9999, output: 9999 } } },
			{ usage: { input: 8888 } },
		],
	});
	const r = parseUsageText(line);
	assert.equal(r.records.length, 1);
	assert.equal(r.records[0].usage.input, 10);
	assert.equal(r.records[0].usage.output, 4);
	assert.equal(r.records[0].ts, TS);
});

test("compaction 记录带 id 与 summary 标记（指纹/计价分离）", () => {
	const line = JSON.stringify({ type: "compaction", id: "comp-1", timestamp: new Date(TS).toISOString(), usage: { input: 7 } });
	const rec = parseUsageText(line).records[0];
	assert.equal(rec.id, "comp-1");
	assert.equal(rec.summary, true);
	assert.equal(rec.provider, undefined);
	assert.equal(rec.model, undefined);
	assert.equal(rec.usage.input, 7);
});

test("branch_summary 行同样只计顶层 usage", () => {
	const line = JSON.stringify({ type: "branch_summary", timestamp: new Date(TS).toISOString(), usage: { input: 3 }, tail: { usage: { input: 77 } } });
	const r = parseUsageText(line);
	assert.equal(r.records.length, 1);
	assert.equal(r.records[0].usage.input, 3);
});

test("pi-web:subagent custom 行 → hasSubagentMarker + profile/description", () => {
	const line = JSON.stringify({ type: "custom", customType: "pi-web:subagent", data: { profile: "worker-pro", description: "写代码" } });
	const r = parseUsageText(line);
	assert.equal(r.hasSubagentMarker, true);
	assert.equal(r.profile, "worker-pro");
	assert.equal(r.description, "写代码");
	assert.equal(r.records.length, 0);
});

test("普通 custom 行不算 subagent marker", () => {
	const line = JSON.stringify({ type: "custom", customType: "session-budget", data: { usd: 5 } });
	const r = parseUsageText(line);
	assert.equal(r.hasSubagentMarker, false);
	assert.equal(r.profile, undefined);
});

test("非 assistant 的 message 行不产生 record", () => {
	const line = JSON.stringify({ type: "message", id: "u1", message: { role: "user", usage: { input: 5 } } });
	assert.equal(parseUsageText(line).records.length, 0);
});

test("parseUsageLine 逐行累加与 parseUsageText 整段解析等价", () => {
	const text = [
		"",
		assistantLine(),
		"{\"type\":\"message\",",
		JSON.stringify({ type: "compaction", timestamp: new Date(TS).toISOString(), usage: { input: 7, output: 3 }, retainedTail: [{ usage: { input: 4242 } }] }),
		JSON.stringify({ type: "branch_summary", timestamp: new Date(TS + 1).toISOString(), usage: { input: 4 } }),
		JSON.stringify({ type: "custom", customType: "pi-web:subagent", data: { profile: "worker", description: "并行" } }),
		JSON.stringify({ type: "message", id: "u1", message: { role: "user", usage: { input: 5 } } }),
		"   ",
		"not json at all",
		JSON.stringify({ type: "message", id: "entry-3", message: { role: "assistant", provider: "p", model: "m", timestamp: TS + 2, usage: { input: 11, output: 2 } } }),
	].join("\n");

	const whole = parseUsageText(text);
	const state = { records: [] as any[], badLines: 0, hasSubagentMarker: false } as { records: any[]; badLines: number; hasSubagentMarker: boolean; profile?: string; description?: string };
	for (const line of text.split("\n")) parseUsageLine(line, state);

	assert.deepEqual(state.records, whole.records);
	assert.equal(state.badLines, whole.badLines);
	assert.equal(state.badLines, 2, "一行截断 + 一行非 JSON");
	assert.equal(state.records.length, 4);
	assert.equal(state.hasSubagentMarker, whole.hasSubagentMarker);
	assert.equal(state.profile, "worker");
	assert.equal(state.description, "并行");
});

test("parseUsageLine 单行超长 → badLines+1 且不追加 record", () => {
	const longLine = assistantLine({ padding: "a".repeat(200) });
	assert.ok(Buffer.byteLength(longLine, "utf8") > 100);
	const state = { records: [] as any[], badLines: 0, hasSubagentMarker: false };
	parseUsageLine(longLine, state, { maxLineBytes: 100 });
	assert.equal(state.badLines, 1);
	assert.equal(state.records.length, 0);
});
