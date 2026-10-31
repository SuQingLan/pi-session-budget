// 周期重绘器：宿主 setWidget 是 fire-and-forget 推送，前端重挂载 / 丢包后不会回填，
// 只能靠下一次推送恢复。这里用假定时器验证起停与间隔语义，不依赖真实时钟。
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REFRESH_MS, refreshIntervalMs, startRepainter } from "../../extensions/session-budget.ts";

/** 假定时器：记录 setInterval / clearInterval 的调用，可手动触发回调 */
function fakeTimers(opts: { unref?: boolean } = {}) {
	const calls: { fn: () => void; ms: number }[] = [];
	const cleared: any[] = [];
	let unrefCount = 0;
	const timer: any = { id: "t1" };
	if (opts.unref !== false) timer.unref = () => void unrefCount++;
	const setIntervalFake = ((fn: () => void, ms: number) => {
		calls.push({ fn, ms });
		return timer;
	}) as unknown as typeof setInterval;
	const clearIntervalFake = ((t: any) => void cleared.push(t)) as unknown as typeof clearInterval;
	return {
		timer,
		calls,
		cleared,
		unrefCount: () => unrefCount,
		setInterval: setIntervalFake,
		clearInterval: clearIntervalFake,
		/** 手动触发第 i 次注册的回调 */
		fire: (i = 0) => calls[i].fn(),
	};
}

test("intervalMs <= 0 → 返回 undefined 且不创建定时器", () => {
	for (const ms of [0, -1, -2000, Number.NaN]) {
		const t = fakeTimers();
		let rendered = 0;
		const r = startRepainter({ render: () => void rendered++, intervalMs: ms, setInterval: t.setInterval, clearInterval: t.clearInterval });
		assert.equal(r, undefined, `intervalMs=${ms} 应不启用重绘`);
		assert.equal(t.calls.length, 0, `intervalMs=${ms} 不应调用 setInterval`);
		assert.equal(rendered, 0);
	}
});

test("intervalMs > 0 → 创建定时器且间隔值正确", () => {
	const t = fakeTimers();
	const r = startRepainter({ render: () => {}, intervalMs: 2000, setInterval: t.setInterval, clearInterval: t.clearInterval });
	assert.ok(r, "应返回 repainter");
	assert.equal(t.calls.length, 1, "应恰好创建 1 个定时器");
	assert.equal(t.calls[0].ms, 2000, "间隔应为传入的 intervalMs");
});

test("定时器回调触发 render", () => {
	const t = fakeTimers();
	let rendered = 0;
	startRepainter({ render: () => void rendered++, intervalMs: 50, setInterval: t.setInterval, clearInterval: t.clearInterval });
	t.fire();
	assert.equal(rendered, 1, "回调应调用一次 render");
	t.fire();
	assert.equal(rendered, 2, "每次触发都应重新渲染（内容相同也不跳过）");
});

test("stop() 调用 clearInterval，且重复 stop 不报错、只清一次", () => {
	const t = fakeTimers();
	const r = startRepainter({ render: () => {}, intervalMs: 50, setInterval: t.setInterval, clearInterval: t.clearInterval })!;
	r.stop();
	assert.equal(t.cleared.length, 1, "应调用一次 clearInterval");
	assert.equal(t.cleared[0], t.timer, "应清掉自己创建的定时器");
	assert.doesNotThrow(() => r.stop());
	assert.doesNotThrow(() => r.stop());
	assert.equal(t.cleared.length, 1, "重复 stop 不应重复清理");
});

test("定时器对象带 unref 时被调用（不阻止进程退出）", () => {
	const t = fakeTimers();
	startRepainter({ render: () => {}, intervalMs: 50, setInterval: t.setInterval, clearInterval: t.clearInterval });
	assert.equal(t.unrefCount(), 1, "应调用 unref 一次");
	// 定时器没有 unref 时也不能抛错
	const bare = fakeTimers({ unref: false });
	assert.doesNotThrow(() => startRepainter({ render: () => {}, intervalMs: 50, setInterval: bare.setInterval, clearInterval: bare.clearInterval }));
});

test("render 抛异常被吞掉，不影响定时器", () => {
	const t = fakeTimers();
	startRepainter({
		render: () => {
			throw new Error("boom");
		},
		intervalMs: 50,
		setInterval: t.setInterval,
		clearInterval: t.clearInterval,
	});
	assert.doesNotThrow(() => t.fire(), "周期渲染异常必须被吞掉");
});

test("refreshIntervalMs：默认 2000，0 = 关闭，环境变量优先，非法值回落默认", () => {
	assert.equal(DEFAULT_REFRESH_MS, 2000);
	assert.equal(refreshIntervalMs({}, {}), 2000, "无配置时用默认值");
	assert.equal(refreshIntervalMs({ refreshMs: 0 }, {}), 0, "配置 0 = 关闭");
	assert.equal(refreshIntervalMs({ refreshMs: 500 }, {}), 500, "配置生效");
	assert.equal(refreshIntervalMs({ refreshMs: 500 }, { SESSION_BUDGET_REFRESH_MS: "50" }), 50, "环境变量优先于配置文件");
	assert.equal(refreshIntervalMs({ refreshMs: 500 }, { SESSION_BUDGET_REFRESH_MS: "0" }), 0, "环境变量 0 = 关闭");
	for (const bad of ["abc", "", "-100", "-1"]) {
		assert.equal(refreshIntervalMs({ refreshMs: bad }, {}), 2000, `非法值 ${JSON.stringify(bad)} 应回落默认`);
	}
	assert.equal(refreshIntervalMs({ refreshMs: -5 }, {}), 2000, "负数按默认处理");
	assert.equal(refreshIntervalMs({ refreshMs: null }, {}), 2000, "null 按默认处理");
});
