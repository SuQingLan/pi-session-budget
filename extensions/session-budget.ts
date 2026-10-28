/**
 * session-budget — 在 pi-web / TUI 输入框上方实时显示当前会话的消耗：
 *   费用（累计 / 预算）、token（输入·输出·缓存读·缓存写）、缓存命中率、当前上下文 / 压缩阈值
 *   子代理（pi-web:subagent）派生会话的用量与费用也计入（可在 session-budget.json 里关闭）
 *
 * 命令：
 *   /budget            查看当前预算
 *   /budget 5          本会话预算设为 ¥5（存在会话文件里；$5 表示美元）
 *   /budget off        取消本会话预算
 * 全局默认预算：<agentDir>/session-budget.json  例如 {"defaultUsd": 10, "warnAt": 0.8}
 *   可选："includeSubagents": false 不把子代理费用算进预算与总额；
 *         "currency": "auto"（默认）|"¥"|"$" 强制显示符号
 * 缓存命中率 = 缓存读 / (输入 + 缓存读 + 缓存写)，主会话与子代理分别显示
 *
 * 计价优先级：
 *   1. <agentDir>/cheapmodel-pricing.json（scripts/cheapmodel-pricing-refresh.py 生成）：
 *      按时段（北京时间高峰/空闲）+ 上下文阶梯（整次请求按总输入落档）+ 按次费用；
 *      新回复结束时还会把算出的费用写回消息（pi-web 自带费用显示随之准确）。
 *      该表是人民币数值 → 计为 ¥
 *   2. models.json 里该模型的当前单价（USD）→ 计为 $
 *   3. 消息里记录的原费用（pi 按 models.json 算，USD）
 * 没有价格表时（别人的机器）自动退化为美元口径，不会误标成 ¥。
 * 历史调用每次都按当前价格表重算。仍是估算，以中转站日志为准。
 */
import { existsSync, readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(process.env.USERPROFILE || process.env.HOME || ".", ".pi", "agent");
const KEY = "session-budget";

function readJson(file: string): any {
	try {
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
	} catch {
		return undefined;
	}
}

function fmtTok(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

type Cur = "¥" | "$";
interface Money { cny: number; usd: number }

/** 币种强制：auto = 按实际计价来源（价格表=¥，models.json=$） */
let CURRENCY: Cur | "auto" = "auto";

function newMoney(): Money {
	return { cny: 0, usd: 0 };
}
function addMoney(m: Money, v: number, cur: Cur): void {
	if (cur === "¥") m.cny += v;
	else m.usd += v;
}
function moneyTotal(m: Money): number {
	return m.cny + m.usd;
}
/** 主导币种：优先 ¥（价格表口径），否则 $ */
function dominantCur(m: Money): Cur {
	return m.cny > 0 ? "¥" : "$";
}
function fmtNum(cur: Cur, n: number): string {
	return n >= 1 ? `${cur}${n.toFixed(2)}` : `${cur}${n.toFixed(4)}`;
}
function fmtMoney(m: Money): string {
	const parts: string[] = [];
	if (m.cny > 0) parts.push(fmtNum("¥", m.cny));
	if (m.usd > 0) parts.push(fmtNum("$", m.usd));
	return parts.join(" + ") || "¥0";
}
/** 配置里强制币种时，两种币种数值合并后按该符号显示 */
function displayMoney(m: Money): string {
	if (CURRENCY === "auto") return fmtMoney(m);
	return fmtNum(CURRENCY, m.cny + m.usd);
}

/** 缓存命中率：缓存读 / 总输入（输入 + 缓存读 + 缓存写） */
function hitRate(input: number, cacheRead: number, cacheWrite: number): string {
	const denom = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
	return denom > 0 ? `${(((cacheRead ?? 0) / denom) * 100).toFixed(1)}%` : "-";
}

interface Tier { period: "all" | "peak" | "offpeak"; minInput: number; maxInput: number | null; input: number; output: number; cacheRead: number; cacheWrite: number }
interface Rule { group: string; tiers: Tier[]; perRequest?: number }
interface Pricing { peakSchedule: { utcOffsetMinutes: number; weekdays: number[]; windows: { start: number; end: number }[]; holidays: string[]; makeupWorkdays: string[] }; rules: Record<string, Rule> }

const PRICING_FILE = join(AGENT_DIR, "cheapmodel-pricing.json");
let pricingCache: { mtime: number; data?: Pricing } = { mtime: -1 };

/** cheapmodel 价格表（scripts/cheapmodel-pricing-refresh.py 生成），按文件修改时间缓存 */
function loadPricing(): Pricing | undefined {
	try {
		const m = statSync(PRICING_FILE).mtimeMs;
		if (m !== pricingCache.mtime) pricingCache = { mtime: m, data: JSON.parse(readFileSync(PRICING_FILE, "utf8")) };
	} catch {
		pricingCache = { mtime: -1 };
	}
	return pricingCache.data;
}

/** 北京时间（按价格表的 utcOffset）是否处于高峰：工作日 + 时间窗口，节假日除外，调休补班日算工作日 */
function isPeak(ts: number, ps: Pricing["peakSchedule"]): boolean {
	const d = new Date(ts + (ps.utcOffsetMinutes ?? 480) * 60_000);
	const day = d.toISOString().slice(0, 10);
	const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
	const workday = (ps.makeupWorkdays ?? []).includes(day) || ((ps.weekdays ?? []).includes(wd) && !(ps.holidays ?? []).includes(day));
	if (!workday) return false;
	const mm = d.getUTCHours() * 60 + d.getUTCMinutes();
	return (ps.windows ?? []).some((w) => mm >= w.start && mm < w.end);
}

/** 按价格表计价：时段 + 上下文阶梯（整次请求按总输入落档）+ 按次费用。无规则时返回 undefined */
function priceByTable(provider: string | undefined, model: string | undefined, u: any, ts: number | undefined) {
	const pr = loadPricing();
	const rule = pr?.rules?.[`${provider}/${model}`];
	if (!rule) return undefined;
	const totalIn = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
	const period = ts && pr!.peakSchedule ? (isPeak(ts, pr!.peakSchedule) ? "peak" : "offpeak") : "peak";
	const fits = (t: Tier) => totalIn >= (t.minInput ?? 0) && (t.maxInput == null || totalIn <= t.maxInput);
	const t =
		rule.tiers.find((t) => t.period === period && fits(t)) ??
		rule.tiers.find((t) => t.period === "all" && fits(t)) ??
		rule.tiers.find((t) => t.period === period || t.period === "all") ??
		rule.tiers[0];
	if (!t) return undefined;
	const c = {
		input: ((u.input ?? 0) * t.input) / 1e6,
		output: ((u.output ?? 0) * t.output) / 1e6,
		cacheRead: ((u.cacheRead ?? 0) * t.cacheRead) / 1e6,
		cacheWrite: ((u.cacheWrite ?? 0) * t.cacheWrite) / 1e6 + (rule.perRequest ?? 0),
		total: 0,
	};
	c.total = c.input + c.output + c.cacheRead + c.cacheWrite;
	return c;
}

/** 返回费用及其币种：价格表 = ¥，models.json / 消息自带 = $ */
function callCost(ctx: any, provider: string | undefined, model: string | undefined, u: any, ts: number | undefined): { v: number; cur: Cur } {
	const t = priceByTable(provider, model, u, ts);
	if (t) return { v: t.total, cur: "¥" };
	const price = provider && model ? ctx.modelRegistry?.find?.(provider, model)?.cost : undefined;
	if (price && (price.input || price.output)) {
		return {
			v: ((u.input ?? 0) * (price.input ?? 0) + (u.output ?? 0) * (price.output ?? 0) + (u.cacheRead ?? 0) * (price.cacheRead ?? 0) + (u.cacheWrite ?? 0) * (price.cacheWrite ?? 0)) / 1_000_000,
			cur: "$",
		};
	}
	return { v: u.cost?.total ?? 0, cur: "$" };
}

/* ---------------- 子代理（派生会话）用量统计 ---------------- */

/** 一条 assistant 调用的原始用量记录（缓存用，计价时再乘价格） */
interface CallRecord { provider?: string; model?: string; ts?: number; usage: any }
interface ChildStats { records: CallRecord[]; profile?: string; description?: string }

const headerCache = new Map<string, { mtimeMs: number; size: number; parent?: string }>();
const childCache = new Map<string, { mtimeMs: number; size: number; stats?: ChildStats }>();

/** 路径归一化（Windows 不区分大小写，统一斜杠） */
function normPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\//g, "/").toLowerCase();
}

/** 读 jsonl 第一行（session 头），避免全文读取 */
function readSessionHeader(file: string): any | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(16384);
		const n = readSync(fd, buf, 0, buf.length, 0);
		const text = buf.toString("utf8", 0, n);
		const nl = text.indexOf("\n");
		return JSON.parse(nl >= 0 ? text.slice(0, nl) : text);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
	}
}

/** 解析子会话文件：assistant 调用的 usage + 子代理档案信息 */
function parseChildFile(file: string): ChildStats | undefined {
	const out: ChildStats = { records: [] };
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let d: any;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		if (d?.type === "custom" && d?.customType === "pi-web:subagent") {
			out.profile = d.data?.profile;
			out.description = d.data?.description;
			continue;
		}
		if (d?.type === "message" && d.message?.role === "assistant" && d.message?.usage) {
			const m = d.message;
			out.records.push({ provider: m.provider, model: m.model, ts: typeof m.timestamp === "number" ? m.timestamp : Date.parse(m.timestamp), usage: m.usage });
		} else if ((d?.type === "compaction" || d?.type === "branch_summary") && d.usage) {
			out.records.push({ ts: Date.parse(d.timestamp), usage: d.usage });
		}
	}
	return out;
}

interface SubUsage {
	cost: Money; input: number; output: number; cacheRead: number; cacheWrite: number;
	calls: number; agents: number; profiles: Record<string, { cost: Money; calls: number }>;
}
function emptySub(): SubUsage {
	return { cost: newMoney(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, agents: 0, profiles: {} };
}

/** 子代理统计的整体缓存（1 秒节流，避免高频事件重复扫盘） */
let subScanCache: { at: number; key: string; value: SubUsage } | undefined;

/**
 * 统计当前会话的所有后代会话（子代理）用量与费用。
 * sessions/<cwd-slug>/<file>.jsonl 的 header 里带 parentSession，指向父会话路径。
 */
function collectSubagentUsage(ctx: any, sessionFile: string | undefined): SubUsage {
	const out = emptySub();
	if (!sessionFile) return out;
	let pricingKey = "";
	try {
		pricingKey = String(statSync(PRICING_FILE).mtimeMs);
	} catch {
		pricingKey = "-";
	}
	const key = `${sessionFile}|${pricingKey}`;
	if (subScanCache && subScanCache.key === key && Date.now() - subScanCache.at < 1000) return subScanCache.value;
	let root: string;
	try {
		root = dirname(dirname(sessionFile)); // sessions/
	} catch {
		return out;
	}
	let dirs: string[] = [];
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((d: any) => d.isDirectory())
			.map((d: any) => join(root, d.name));
	} catch {
		return out;
	}

	// 1) 建父子关系
	const parents = new Map<string, string>(); // 子文件路径 -> 父文件路径
	const files: string[] = [];
	for (const dir of dirs) {
		let names: string[] = [];
		try {
			names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const n of names) {
			const f = join(dir, n);
			files.push(f);
			let st: { mtimeMs: number; size: number };
			try {
				st = statSync(f);
			} catch {
				continue;
			}
			const cached = headerCache.get(f);
			let parent: string | undefined;
			if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
				parent = cached.parent;
			} else {
				const h = readSessionHeader(f);
				parent = h?.parentSession;
				headerCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, parent });
			}
			if (parent) parents.set(normPath(f), normPath(parent));
		}
	}

	// 2) 从当前会话往下找所有后代（支持多层嵌套）
	const self = normPath(sessionFile);
	const descendants = new Set<string>();
	const queue = [self];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const [child, parent] of parents) {
			if (parent === cur && !descendants.has(child)) {
				descendants.add(child);
				queue.push(child);
			}
		}
	}
	if (!descendants.size) return out;

	// 3) 解析后代会话的用量（按 mtime/size 缓存），并直接计价
	out.agents = descendants.size;
	for (const f of files) {
		if (!descendants.has(normPath(f))) continue;
		let st: { mtimeMs: number; size: number };
		try {
			st = statSync(f);
		} catch {
			continue;
		}
		const cached = childCache.get(f);
		let stats: ChildStats | undefined;
		if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
			stats = cached.stats;
		} else {
			stats = parseChildFile(f);
			childCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, stats });
		}
		if (!stats) continue;
		const profile = stats.profile || "subagent";
		const bucket = (out.profiles[profile] ??= { cost: newMoney(), calls: 0 });
		for (const r of stats.records) {
			const u = r.usage ?? {};
			const prov = r.provider ?? ctx.model?.provider;
			const mod = r.model ?? ctx.model?.id;
			const c = callCost(ctx, prov, mod, u, r.ts);
			addMoney(out.cost, c.v, c.cur);
			out.input += u.input ?? 0;
			out.output += u.output ?? 0;
			out.cacheRead += u.cacheRead ?? 0;
			out.cacheWrite += u.cacheWrite ?? 0;
			out.calls++;
			addMoney(bucket.cost, c.v, c.cur);
			bucket.calls++;
		}
	}
	subScanCache = { at: Date.now(), key, value: out };
	return out;
}

/** 与 pi 的计算方式一致：contextWindow - reserveTokens，按模型覆盖 → 普通设置 → 默认值 */
function compactionThreshold(provider?: string, modelId?: string, contextWindow?: number): number | undefined {
	if (!contextWindow) return undefined;
	const s = readJson(join(AGENT_DIR, "settings.json"))?.compaction ?? {};
	if (s.enabled === false) return undefined;
	const ov = provider && modelId ? s.modelOverrides?.[`${provider}/${modelId}`] : undefined;
	const reserve = ov?.reserveTokens ?? s.reserveTokens ?? 16384;
	return contextWindow - reserve;
}

export default function (pi: ExtensionAPI) {
	let warned = false;

	function sessionBudget(entries: any[]): { amount: number; cur: Cur } | undefined {
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom" && e.customType === KEY) {
				const amt = e.data?.usd;
				if (typeof amt === "number" && amt > 0) return { amount: amt, cur: e.data?.cur === "$" ? "$" : "¥" };
				return undefined;
			}
		}
		const cfg = readJson(join(AGENT_DIR, "session-budget.json")) ?? {};
		const d = cfg.defaultUsd;
		if (typeof d === "number" && d > 0) return { amount: d, cur: cfg.budgetCurrency === "$" ? "$" : "¥" };
		return undefined;
	}

	function render(ctx: any) {
		try {
			const entries: any[] = ctx.sessionManager.getEntries();
			const cfg = readJson(join(AGENT_DIR, "session-budget.json")) ?? {};
			CURRENCY = cfg.currency === "¥" || cfg.currency === "$" ? cfg.currency : "auto";
			let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, calls = 0;
			const mainCost = newMoney();
			for (const e of entries) {
				const isMsg = e.type === "message" && e.message?.role === "assistant";
				const u = isMsg ? e.message.usage : e.type === "compaction" || e.type === "branch_summary" ? e.usage : undefined;
				if (!u) continue;
				// 压缩/分支总结的调用不记录模型，按当前模型估价
				const prov = isMsg ? e.message.provider : ctx.model?.provider;
				const mod = isMsg ? e.message.model : ctx.model?.id;
				const ts = isMsg ? e.message.timestamp : Date.parse(e.timestamp);
				calls++;
				input += u.input ?? 0;
				output += u.output ?? 0;
				cacheRead += u.cacheRead ?? 0;
				cacheWrite += u.cacheWrite ?? 0;
				const c = callCost(ctx, prov, mod, u, ts);
				addMoney(mainCost, c.v, c.cur);
			}

			const includeSub = cfg.includeSubagents !== false;
			const sub = includeSub ? collectSubagentUsage(ctx, ctx.sessionManager.getSessionFile?.()) : emptySub();
			const totalCost = newMoney();
			addMoney(totalCost, mainCost.cny, "¥");
			addMoney(totalCost, mainCost.usd, "$");
			addMoney(totalCost, sub.cost.cny, "¥");
			addMoney(totalCost, sub.cost.usd, "$");

			const budget = sessionBudget(entries);
			const warnAt = cfg.warnAt ?? 0.8;
			let costPart = `💰 ${displayMoney(totalCost)}`;
			if (sub.agents) costPart += ` (主 ${displayMoney(mainCost)} + 子 ${displayMoney(sub.cost)})`;
			if (budget) {
				const spent = budget.cur === "¥" ? totalCost.cny : totalCost.usd;
				const pct = spent / budget.amount;
				const sameCur = budget.cur === "¥" ? totalCost.cny > 0 : totalCost.usd > 0;
				costPart += ` / ${fmtNum(budget.cur, budget.amount)}`;
				costPart += sameCur
					? ` (${(pct * 100).toFixed(0)}%)${pct >= 1 ? " ⛔ 超出预算" : pct >= warnAt ? " ⚠️" : ""}`
					: " (币种不同，不比较)";
				if (sameCur && pct >= warnAt && !warned) {
					warned = true;
					ctx.ui.notify(`本会话费用已达预算的 ${(pct * 100).toFixed(0)}%（${fmtNum(budget.cur, spent)} / ${fmtNum(budget.cur, budget.amount)}）`, "warning");
				}
				if (!sameCur || pct < warnAt) warned = false;
			}

			const tokPart =
				`🔢 入 ${fmtTok(input)} · 出 ${fmtTok(output)} · 缓存读 ${fmtTok(cacheRead)} · 缓存写 ${fmtTok(cacheWrite)}` +
				` · ${calls} 次调用 · 💾 缓存命中 ${hitRate(input, cacheRead, cacheWrite)}`;

			let ctxPart = "";
			const cu = ctx.getContextUsage?.();
			if (cu) {
				const th = compactionThreshold(ctx.model?.provider, ctx.model?.id, cu.contextWindow);
				const cur = cu.tokens == null ? "?" : fmtTok(cu.tokens);
				ctxPart = th
					? `📦 上下文 ${cur} / 压缩阈值 ${fmtTok(th)}${cu.tokens != null ? ` (${((cu.tokens / th) * 100).toFixed(0)}%)` : ""}`
					: `📦 上下文 ${cur} / ${fmtTok(cu.contextWindow)}`;
			}

			const lines: string[] = [[costPart, ctxPart].filter(Boolean).join("   "), tokPart];
			if (sub.agents) {
				const detail = Object.entries(sub.profiles)
					.sort((a, b) => moneyTotal(b[1].cost) - moneyTotal(a[1].cost))
					.map(([name, v]) => `${name} ${displayMoney(v.cost)} (${v.calls})`)
					.join(" · ");
				lines.push(
					`🤖 子代理 ${sub.agents} 个 · ${displayMoney(sub.cost)} · ${sub.calls} 次调用` +
						` · 入 ${fmtTok(sub.input)} · 出 ${fmtTok(sub.output)} · 缓存读 ${fmtTok(sub.cacheRead)} · 缓存写 ${fmtTok(sub.cacheWrite)}` +
						` · 💾 命中 ${hitRate(sub.input, sub.cacheRead, sub.cacheWrite)}` +
						(detail ? `   ↳ ${detail}` : ""),
				);
			}

			ctx.ui.setWidget(KEY, lines);
		} catch (err) {
			if (process.env.SESSION_BUDGET_DEBUG) console.error("session-budget render failed", err);
			// 显示失败不影响会话
		}
	}

	// 把按价格表算出的费用写回消息，pi-web 自带的费用显示也随之准确
	pi.on("message_end", async (event: any) => {
		const m = event?.message;
		if (!m || m.role !== "assistant" || !m.usage) return;
		const c = priceByTable(m.provider, m.model, m.usage, m.timestamp ?? Date.now());
		if (!c) return;
		return { message: { ...m, usage: { ...m.usage, cost: c } } };
	});

	for (const ev of ["session_start", "message_end", "turn_end", "agent_end", "session_compact", "model_select"] as const) {
		try {
			pi.on(ev as any, async (_e: any, ctx: any) => render(ctx));
		} catch {
			// 某些事件名在旧版本不存在时忽略
		}
	}

	pi.registerCommand("budget", {
		description: "设置/查看本会话费用预算：/budget 5 | /budget $5 | /budget off",
		handler: async (args, ctx) => {
			const a = args.trim();
			const low = a.toLowerCase();
			if (!a) {
				const b = sessionBudget(ctx.sessionManager.getEntries() as any[]);
				const sub = collectSubagentUsage(ctx, ctx.sessionManager.getSessionFile?.());
				const extra = sub.agents ? `，子代理 ${sub.agents} 个 / ${fmtMoney(sub.cost)}` : "";
				ctx.ui.notify(b ? `本会话预算：${fmtNum(b.cur, b.amount)}${extra}` : `本会话未设预算（/budget 5 设为 ¥5，/budget $5 设为 $5）${extra}`, "info");
			} else if (low === "off" || low === "0") {
				pi.appendEntry(KEY, { usd: null });
				ctx.ui.notify("已取消本会话预算", "info");
			} else {
				const usd = a.startsWith("$");
				const cur: Cur = usd ? "$" : "¥";
				const n = Number(a.replace(/^\$/, ""));
				if (!Number.isFinite(n) || n <= 0) {
					ctx.ui.notify("用法：/budget 5 或 /budget $5 或 /budget off", "warning");
					return;
				}
				pi.appendEntry(KEY, { usd: n, cur });
				warned = false;
				ctx.ui.notify(`本会话预算已设为 ${fmtNum(cur, n)}`, "info");
			}
			render(ctx);
		},
	});
}
