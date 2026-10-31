// 宿主 API 符号存在性检查（方案 B：轻量核对）
//
// 契约测试里的宿主是**手写 mock**——它是测试替身，不会随上游 pi 宿主 API 变更而变化，
// 于是「上游把 setWidget 改名」这类破坏能骗过所有 mock 测试，扩展在真实 pi 里静默失效。
//
// 本测试直接读真实宿主包 @earendil-works/pi-coding-agent 的类型声明，
// 核对扩展实际用到的每个宿主 API 名字**仍然存在**。
// 找不到宿主包时跳过（没装 pi 的环境也能跑），不误伤。
import test from "node:test";
import assert from "node:assert/strict";
import { HOST_API_USAGE } from "../../extensions/session-budget.ts";
import { checkHostApi, locateHostPackage } from "../../scripts/host-api-check.mjs";

test("HOST_API_USAGE 清单非空且无重复", () => {
	assert.ok(Array.isArray(HOST_API_USAGE) && HOST_API_USAGE.length > 0, "清单不能为空");
	const dup = HOST_API_USAGE.filter((a, i) => HOST_API_USAGE.indexOf(a) !== i);
	assert.deepEqual(dup, [], `清单里有重复项：${dup.join(", ")}`);
	// 每项都应是 "宿主.路径" 形式，便于取末段做符号名
	for (const api of HOST_API_USAGE) {
		assert.match(api, /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/, `清单项格式不对：${api}`);
	}
});

test("宿主包里的每个 API 符号都仍然存在（上游改名/删除会被这里挡住）", (t) => {
	const pkgDir = locateHostPackage();
	if (!pkgDir) {
		t.skip("未找到 @earendil-works/pi-coding-agent；可用 PI_HOST_PACKAGE_DIR 指定宿主包目录");
		return;
	}
	const { version, results, missing } = checkHostApi(HOST_API_USAGE);
	const report = results.map((r) => `${r.ok ? "✔" : "✘"} ${r.api}`).join("\n");
	assert.deepEqual(
		missing,
		[],
		`宿主包 ${pkgDir} (v${version ?? "?"}) 里找不到这些 API 符号：\n${report}\n` +
			`上游可能改名或删除了它们 —— 请同步更新扩展实现与 HOST_API_USAGE 清单。`,
	);
	assert.equal(results.length, HOST_API_USAGE.length, "应逐项核对清单里的每一项");
});
