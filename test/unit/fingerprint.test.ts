// 去重指纹：同一条 entry（id + 时间 + provider + model + 四项 token）→ 同一指纹；
// 刻意不含文件路径，所以 fork / clone 出来的副本文件里同一条记录指纹相同。
import test from "node:test";
import assert from "node:assert/strict";
import { usageFingerprint, parseUsageText } from "../../extensions/session-budget.ts";

const base = {
	id: "entry-1",
	ts: 1767225600000,
	provider: "magpie",
	model: "deeps",
	usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 },
};

test("同 id + 同 usage → 同指纹", () => {
	assert.equal(usageFingerprint(base), usageFingerprint({ ...base, usage: { ...base.usage } }));
});

test("id 不同 → 指纹不同", () => {
	assert.notEqual(usageFingerprint(base), usageFingerprint({ ...base, id: "entry-2" }));
});

test("usage 不同 → 指纹不同", () => {
	assert.notEqual(usageFingerprint(base), usageFingerprint({ ...base, usage: { ...base.usage, output: 21 } }));
	assert.notEqual(usageFingerprint(base), usageFingerprint({ ...base, usage: { ...base.usage, cacheRead: 6 } }));
});

test("缺字段不抛异常，且与空输入等价", () => {
	assert.doesNotThrow(() => usageFingerprint({}));
	assert.equal(usageFingerprint({}), usageFingerprint({ id: undefined, usage: undefined }));
	assert.equal(usageFingerprint({}).length, 16);
});

test("指纹长度 16 位十六进制", () => {
	assert.match(usageFingerprint(base), /^[0-9a-f]{16}$/);
});

test("不含路径：文件名不同但内容相同 → 同指纹", () => {
	const line = JSON.stringify({
		type: "message",
		id: "entry-1",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "assistant", provider: "magpie", model: "deeps", timestamp: base.ts, usage: base.usage },
	});
	const a = parseUsageText(line + "\n");
	const b = parseUsageText(line + "\n");
	assert.equal(a.records.length, 1);
	assert.equal(usageFingerprint(a.records[0]), usageFingerprint(b.records[0]));
	// 传进来的对象里带路径字段也不影响指纹
	const withPath = { ...a.records[0], file: "/sessions/a.jsonl", path: "b.jsonl" } as any;
	assert.equal(usageFingerprint(withPath), usageFingerprint(a.records[0]));
});
