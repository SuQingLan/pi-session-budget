// 流式解析边界：直接走 parseChildFile 的真实文件入口（64 KB 分块、超长行丢弃到下一个 \n）。
// 与 usage.test.ts 的字符串级用例互补：这里用真实临时文件验证按字节切分的行为。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChildFile } from "../../extensions/session-budget.ts";

const TS = 1767225600000; // 2026-01-01T00:00:00.000Z
const CHUNK = 64 * 1024; // 与 parseChildFile 的分块大小一致

/** 写一个临时 jsonl 文件并交给 fn，结束后递归删除临时目录 */
function withTempFile(content: string | Buffer, fn: (file: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "sb-stream-"));
	try {
		const file = join(dir, "child.jsonl");
		writeFileSync(file, content);
		fn(file);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** 一条 assistant 行（padding 放在最前，便于把后面的字段精确推到分块边界上） */
function assistantLine(opts: { id: string; input?: number; output?: number; padding?: string; ts?: number }): string {
	const { id, input = 100, output = 20, padding = "", ts = TS } = opts;
	return JSON.stringify({
		type: "message",
		padding,
		id,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			provider: "magpie",
			model: "deeps",
			timestamp: ts,
			usage: { input, output, cacheRead: 5, cacheWrite: 1 },
		},
	});
}

/** 某段文本从行首算起的字节偏移 */
function byteOffsetOf(line: string, needle: string): number {
	const at = line.indexOf(needle);
	assert.ok(at >= 0, `行内应能找到 ${needle}`);
	return Buffer.byteLength(line.slice(0, at), "utf8");
}

test("跨块行：单行 > 64 KB 的合法 JSON 被完整解析（badLines 0）", () => {
	const line = assistantLine({ id: "big", input: 1234, padding: "a".repeat(100_000) });
	assert.ok(Buffer.byteLength(line, "utf8") > CHUNK, "构造的行应跨多个 64 KB 块");
	withTempFile(line + "\n", (file) => {
		const st = parseChildFile(file);
		assert.ok(st, "文件存在时应返回统计结果");
		assert.equal(st.badLines, 0);
		assert.equal(st.records.length, 1);
		assert.equal(st.records[0].id, "big");
		assert.equal(st.records[0].usage.input, 1234);
		assert.equal(st.records[0].usage.output, 20);
	});
});

test("超长末行（无换行）→ 计入 badLines 且不产生 record", () => {
	const head = assistantLine({ id: "ok" });
	const tail = assistantLine({ id: "tail-too-long", padding: "b".repeat(5000) });
	assert.ok(Buffer.byteLength(tail, "utf8") > 1000);
	withTempFile(head + "\n" + tail, (file) => {
		const st = parseChildFile(file, { maxLineBytes: 1000 });
		assert.ok(st);
		assert.equal(st.badLines, 1, "没有换行收尾的超长行也要计 1 个坏行");
		assert.equal(st.records.length, 1);
		assert.equal(st.records[0].id, "ok");
	});
});

test("超长行后跟正常行：丢弃只到下一个换行为止，后续行仍被解析", () => {
	const longLine = assistantLine({ id: "too-long", padding: "c".repeat(4000) });
	const after = assistantLine({ id: "after", input: 7 });
	const last = assistantLine({ id: "last", input: 8 });
	assert.ok(Buffer.byteLength(longLine, "utf8") > 1000);
	withTempFile([longLine, after, last].join("\n") + "\n", (file) => {
		const st = parseChildFile(file, { maxLineBytes: 1000 });
		assert.ok(st);
		assert.equal(st.badLines, 1, "只有那一行超长");
		assert.deepEqual(
			st.records.map((r) => r.id),
			["after", "last"],
			"超长行之后的正常行不能被连带丢弃",
		);
		assert.equal(st.records[0].usage.input, 7);
		assert.equal(st.records[1].usage.input, 8);
	});
});

test("UTF-8 多字节跨块边界：按字节切分不截断中文字符", () => {
	const marker = "中文边界测试"; // 6 个汉字 = 18 字节
	// id 放在 padding 之后：把 id 的取值精确推到第 CHUNK-1 个字节上，使其跨块
	const probe = assistantLine({ id: "__MARK__", padding: "" });
	const insertAt = byteOffsetOf(probe, "__MARK__");
	const padLen = CHUNK - 1 - insertAt;
	assert.ok(padLen > 0, `padding 长度应为正：${padLen}`);
	const line = assistantLine({ id: marker, input: 42, padding: "a".repeat(padLen) });
	assert.ok(Buffer.byteLength(line, "utf8") > CHUNK, "整行应跨块");
	assert.equal(byteOffsetOf(line, marker), CHUNK - 1, "中文字符的首字节应落在块边界前一个字节");
	withTempFile(line + "\n", (file) => {
		const st = parseChildFile(file);
		assert.ok(st);
		assert.equal(st.badLines, 0);
		assert.equal(st.records.length, 1);
		// 若按块切分时截断多字节字符，这里会是替换字符而非原文
		assert.equal(st.records[0].id, marker);
		assert.equal(st.records[0].usage.input, 42);
	});
});

test("坏 JSON 行 → badLines 计 1，其余行不受影响", () => {
	const bad = '{"type":"message","padding":"' + "x".repeat(20); // 截断的 JSON
	const a = assistantLine({ id: "a", input: 11 });
	const b = assistantLine({ id: "b", input: 9 });
	withTempFile([a, bad, b].join("\n") + "\n", (file) => {
		const st = parseChildFile(file);
		assert.ok(st);
		assert.equal(st.badLines, 1);
		assert.deepEqual(
			st.records.map((r) => r.id),
			["a", "b"],
		);
		assert.equal(st.records[0].usage.input, 11);
		assert.equal(st.records[1].usage.input, 9);
	});
});
