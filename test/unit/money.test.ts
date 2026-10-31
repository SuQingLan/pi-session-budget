// 金额工具与「真实 / 估算」分列：addMoney / moneyTotal / dominantCur / addToSplit
import test from "node:test";
import assert from "node:assert/strict";
import { addMoney, moneyTotal, dominantCur, addToSplit, emptyCostSplit } from "../../extensions/session-budget.ts";

const zero = () => ({ cny: 0, usd: 0 });

test("addMoney 按币种分列累加", () => {
	const m = zero();
	addMoney(m, 1.5, "¥");
	addMoney(m, 0.25, "$");
	addMoney(m, 2.5, "¥");
	assert.equal(m.cny, 4);
	assert.equal(m.usd, 0.25);
	assert.equal(moneyTotal(m), 4.25);
});

test("moneyTotal 为两币种之和；主导币种优先 ¥", () => {
	assert.equal(moneyTotal(zero()), 0);
	assert.equal(dominantCur(zero()), "$");
	assert.equal(dominantCur({ cny: 0, usd: 9 }), "$");
	assert.equal(dominantCur({ cny: 1, usd: 9 }), "¥");
	assert.equal(dominantCur({ cny: 0.001, usd: 0 }), "¥");
});

test("空构成：realKnown=false、est 为 0", () => {
	const s = emptyCostSplit();
	assert.equal(s.realUsd, 0);
	assert.equal(s.realKnown, false);
	assert.equal(s.est.cny, 0);
	assert.equal(s.est.usd, 0);
});

test("addToSplit：real 计入 realUsd 并置 realKnown，est 按币种进 est", () => {
	const s = emptyCostSplit();
	addToSplit(s, 0.0123, "$", "real");
	assert.equal(s.realKnown, true);
	assert.equal(s.realUsd, 0.0123);
	assert.equal(s.est.cny, 0);
	assert.equal(s.est.usd, 0);

	addToSplit(s, 12.5, "¥", "est");
	addToSplit(s, 0.5, "$", "est");
	assert.equal(s.est.cny, 12.5);
	assert.equal(s.est.usd, 0.5);
	// 估算不污染真实
	assert.equal(s.realUsd, 0.0123);
});

test("addToSplit：仅估算时 realKnown 保持 false", () => {
	const s = emptyCostSplit();
	addToSplit(s, 297.72, "¥", "est");
	assert.equal(s.realKnown, false);
	assert.equal(s.realUsd, 0);
	assert.equal(s.est.cny, 297.72);
});

test("est 为 0 时 est.cny / est.usd 均为 0", () => {
	const s = emptyCostSplit();
	addToSplit(s, 0, "¥", "est");
	addToSplit(s, 0, "$", "est");
	assert.equal(s.est.cny, 0);
	assert.equal(s.est.usd, 0);
});

test("addToSplit：unknown 不累加也不设 realKnown", () => {
	const s = emptyCostSplit();
	addToSplit(s, 5, "$", "unknown");
	assert.equal(s.realKnown, false);
	assert.equal(s.realUsd, 0);
	assert.equal(s.est.cny, 0);
	assert.equal(s.est.usd, 0);
});
