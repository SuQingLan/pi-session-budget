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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(process.env.USERPROFILE || process.env.HOME || ".", ".pi", "agent");
const KEY = "session-budget";

/**
 * 本扩展用到的宿主 API 清单（上游变更时这里需要同步；契约测试据此校验 mock 覆盖）。
 * 路径写法：pi.* / ctx.ui.* / ctx.sessionManager.* / ctx.modelRegistry.* / ctx.model.* / ctx.getContextUsage。
 */
export const HOST_API_USAGE = [
	"pi.on",
	"pi.registerCommand",
	"pi.appendEntry",
	"ctx.ui.setWidget",
	"ctx.ui.notify",
	"ctx.sessionManager.getEntries",
	"ctx.sessionManager.getSessionFile",
	"ctx.modelRegistry.find",
	"ctx.getContextUsage",
	"ctx.model.provider",
	"ctx.model.id",
	"ctx.hasUI",
] as const;

/* ---------------- 周期性重绘（re-paint） ---------------- */

export interface Repainter { stop(): void }

/** 周期重绘的默认间隔（毫秒）；配置 refreshMs 可改，0 = 关闭 */
export const DEFAULT_REFRESH_MS = 2000;

/**
 * 周期性重绘：`ctx.ui.setWidget` 是 fire-and-forget 推送，前端重挂载 / SSE 重连 / 丢包后
 * 不会回填旧 widget，只能靠下一次推送恢复 —— 所以定时无条件重推一次。
 * `intervalMs <= 0` 表示不启用（返回 undefined）。定时器带 `unref()`（不阻止 pi 进程退出）。
 */
export function startRepainter(opts: {
	render: () => void;
	intervalMs: number;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
}): Repainter | undefined {
	if (!(opts.intervalMs > 0)) return undefined; // 0 / 负数 / NaN → 关闭
	const setIv = opts.setInterval ?? setInterval;
	const clearIv = opts.clearInterval ?? clearInterval;
	const timer: any = setIv(() => {
		try {
			opts.render();
		} catch {
			// 周期渲染异常必须吞掉：不能让定时器抛错影响会话
		}
	}, opts.intervalMs);
	// 不阻止 pi 进程退出
	try {
		if (typeof timer?.unref === "function") timer.unref();
	} catch {
		/* 某些定时器实现没有 unref，忽略 */
	}
	let stopped = false;
	return {
		stop() {
			if (stopped) return; // 幂等
			stopped = true;
			try {
				clearIv(timer);
			} catch {
				/* 已清理过，忽略 */
			}
		},
	};
}

/**
 * 周期重绘间隔：环境变量 `SESSION_BUDGET_REFRESH_MS` 优先于配置文件 `refreshMs`，
 * 缺省 2000；非法值（负数 / 非数字）按默认处理，不抛错。0 = 关闭。
 */
export function refreshIntervalMs(cfg?: any, env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.SESSION_BUDGET_REFRESH_MS ?? cfg?.refreshMs;
	if (raw === undefined || raw === null) return DEFAULT_REFRESH_MS;
	const n = typeof raw === "string" ? (raw.trim() === "" ? Number.NaN : Number(raw)) : Number(raw);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_REFRESH_MS;
	return n;
}

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

export type Cur = "¥" | "$";
export interface Money { cny: number; usd: number }

/** 币种强制：auto = 按实际计价来源（价格表=¥，models.json=$） */
let CURRENCY: Cur | "auto" = "auto";

function newMoney(): Money {
	return { cny: 0, usd: 0 };
}
export function addMoney(m: Money, v: number, cur: Cur): void {
	if (cur === "¥") m.cny += v;
	else m.usd += v;
}
export function moneyTotal(m: Money): number {
	return m.cny + m.usd;
}
/** 主导币种：优先 ¥（价格表口径），否则 $ */
export function dominantCur(m: Money): Cur {
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

/* ---------------- 成本构成：真实成本 vs 估算成本 ---------------- */

/**
 * 成本构成：
 *   realUsd  = pi 记录在消息里的 usage.cost.total（真实成本，美元）
 *   est      = 价格表 / models.json 单价算出的估算成本（按币种分列）
 * 两者分开统计，widget 总额全为估算时加 ≈ 前缀，/budget 输出给出构成。
 */
export interface CostSplit { realUsd: number; realKnown: boolean; est: Money }

export function emptyCostSplit(): CostSplit {
	return { realUsd: 0, realKnown: false, est: newMoney() };
}

export function addToSplit(s: CostSplit, v: number, cur: Cur, kind: "real" | "est" | "unknown"): void {
	if (kind === "real") {
		s.realUsd += v;
		s.realKnown = true;
		return;
	}
	if (kind === "unknown") return;
	addMoney(s.est, v, cur);
}

/** 合并两份成本构成（主会话 + 子代理） */
function mergeSplit(into: CostSplit, from: CostSplit): void {
	if (from.realKnown) {
		into.realUsd += from.realUsd;
		into.realKnown = true;
	}
	into.est.cny += from.est.cny;
	into.est.usd += from.est.usd;
}

/** 总额全部来自估算时，金额前加 ≈ */
function estOnly(s: CostSplit): boolean {
	return !s.realKnown;
}

/** /budget 输出末尾的成本构成行（格式固定） */
function costBreakdownText(s: CostSplit): string {
	const real = s.realKnown ? `真实 ${fmtNum("$", s.realUsd)}` : "真实成本未记录";
	const est = moneyTotal(s.est) > 0 ? fmtMoney(s.est) : "¥0.00";
	return `成本构成：${real} · 估算 ${est}`;
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

/**
 * 返回费用、币种与来源：价格表 = ¥/估算，models.json 单价 = $/估算，
 * 消息自带 usage.cost.total = $/真实。cost 缺失 / 非有限数 = unknown（不计量）。
 */
function callCost(ctx: any, provider: string | undefined, model: string | undefined, u: any, ts: number | undefined): { v: number; cur: Cur; kind: "real" | "est" | "unknown" } {
	const t = priceByTable(provider, model, u, ts);
	if (t) return { v: t.total, cur: "¥", kind: "est" };
	const price = provider && model ? ctx.modelRegistry?.find?.(provider, model)?.cost : undefined;
	if (price && (price.input || price.output)) {
		return {
			v: ((u.input ?? 0) * (price.input ?? 0) + (u.output ?? 0) * (price.output ?? 0) + (u.cacheRead ?? 0) * (price.cacheRead ?? 0) + (u.cacheWrite ?? 0) * (price.cacheWrite ?? 0)) / 1_000_000,
			cur: "$",
			kind: "est",
		};
	}
	if (typeof u.cost?.total === "number" && Number.isFinite(u.cost.total)) {
		return { v: u.cost.total, cur: "$", kind: "real" };
	}
	return { v: 0, cur: "$", kind: "unknown" };
}

/* ---------------- 子代理（派生会话）用量统计 ---------------- */

/** 一条 assistant 调用的原始用量记录（缓存用，计价时再乘价格） */
export interface CallRecord { id?: string; provider?: string; model?: string; ts?: number; usage: any; summary?: boolean }
export interface ChildStats { records: CallRecord[]; profile?: string; description?: string; badLines: number }

/* ---------------- 去重指纹 ---------------- */

export interface FpInput { id?: string; ts?: number; provider?: string; model?: string; usage?: any }

/** 指纹 = sha1(id|ts|provider|model|input|output|cacheRead|cacheWrite) 前 16 位；刻意不含文件路径 */
export function usageFingerprint(p: FpInput): string {
	const u = p.usage ?? {};
	const material = [p.id ?? "", p.ts ?? "", p.provider ?? "", p.model ?? "", u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0].join("|");
	return createHash("sha1").update(material).digest("hex").slice(0, 16);
}

/** 本次渲染去重指纹集合的签名（用于子代理统计缓存 key） */
function fpSignature(seen: Set<string>): string {
	if (!seen.size) return "0";
	return createHash("sha1").update(Array.from(seen).sort().join(",")).digest("hex").slice(0, 16);
}

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

/** 解析结果：用量记录 + 坏行计数 + 子代理档案信息 */
export interface ParsedUsage {
	records: CallRecord[];
	badLines: number;
	hasSubagentMarker: boolean;
	profile?: string;
	description?: string;
}

/** 增量解析状态：逐行累加，不保留原文（流式读取与整段解析共用） */
export interface UsageParseState {
	records: CallRecord[];
	badLines: number;
	hasSubagentMarker: boolean;
	profile?: string;
	description?: string;
}

/**
 * 解析一行 jsonl 文本并累加到 state：
 *   单行 UTF-8 字节超 maxLineBytes → 计 badLines，跳过（默认 4 MiB）
 *   坏 JSON 行 → 计 badLines，跳过
 *   compaction / branch_summary 只取顶层 usage，不读 retainedTail（否则重复计数）
 * 空行忽略。纯函数（只改 state），便于逐行流式调用与测试。
 */
export function parseUsageLine(line: string, state: UsageParseState, opts?: { maxLineBytes?: number }): void {
	const maxLineBytes = opts?.maxLineBytes ?? 4 * 1024 * 1024;
	if (!line.trim()) return;
	if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
		state.badLines++;
		return;
	}
	let d: any;
	try {
		d = JSON.parse(line);
	} catch {
		state.badLines++;
		return;
	}
	if (d?.type === "custom" && d?.customType === "pi-web:subagent") {
		state.hasSubagentMarker = true;
		state.profile = d.data?.profile;
		state.description = d.data?.description;
		return;
	}
	if (d?.type === "message" && d.message?.role === "assistant" && d.message?.usage) {
		const m = d.message;
		state.records.push({
			id: d.id,
			provider: m.provider,
			model: m.model,
			ts: typeof m.timestamp === "number" ? m.timestamp : Date.parse(m.timestamp),
			usage: m.usage,
		});
	} else if ((d?.type === "compaction" || d?.type === "branch_summary") && d.usage) {
		// 只计顶层 usage，retainedTail 里是历史消息的副本，读它会重复计数
		// summary 记录带 id 并打 summary 标记：指纹时用空 provider/model，计价仍按现有口径
		state.records.push({ id: d.id, ts: Date.parse(d.timestamp), usage: d.usage, summary: true });
	}
}

/** 解析整段 jsonl 文本（便利包装）：按 "\n" 拆行后逐行交给 parseUsageLine */
export function parseUsageText(text: string, opts?: { maxLineBytes?: number }): ParsedUsage {
	const state: UsageParseState = { records: [], badLines: 0, hasSubagentMarker: false };
	for (const line of text.split("\n")) parseUsageLine(line, state, opts);
	return state;
}

/**
 * 解析子会话文件（流式）：64 KB 分块读，按 "\n" 切行，每凑齐一行就立即交给
 * parseUsageLine 累加——不累积行数组、不拼接全文，内存上限约为单行长度。
 * 某行超过 maxLineBytes 时丢弃该行剩余部分直到下一个 "\n"（不无限累积）。
 * 总坏行数 = 流式丢弃的超长行 + 解析失败行。
 */
export function parseChildFile(file: string, opts?: { maxLineBytes?: number }): ChildStats | undefined {
	const maxLineBytes = opts?.maxLineBytes ?? 4 * 1024 * 1024;
	const CHUNK = 64 * 1024;
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
	} catch {
		return undefined;
	}
	const state: UsageParseState = { records: [], badLines: 0, hasSubagentMarker: false };
	const emit = (parts: Buffer[]) => parseUsageLine(Buffer.concat(parts).toString("utf8"), state, opts);
	let streamBad = 0;
	try {
		const buf = Buffer.alloc(CHUNK);
		let parts: Buffer[] = [];
		let lineBytes = 0;
		let skipLine = false;
		for (;;) {
			let n = 0;
			try {
				n = readSync(fd, buf, 0, CHUNK, null);
			} catch {
				break;
			}
			if (!n) break;
			let start = 0;
			while (start < n) {
				const idx = buf.subarray(start, n).indexOf(10); // 只在本块已读范围内找换行
				const end = idx >= 0 ? start + idx : n;
				if (end > start && !skipLine) {
					lineBytes += end - start;
					if (lineBytes > maxLineBytes) {
						skipLine = true; // 超长行：丢弃已收集部分，后续字节直接丢
						parts = [];
					} else {
						parts.push(Buffer.from(buf.subarray(start, end)));
					}
				}
				if (idx >= 0) {
					if (skipLine) {
						streamBad++;
						skipLine = false;
					} else if (parts.length) {
						emit(parts); // 逐行增量解析，立即释放该行缓冲
					}
					parts = [];
					lineBytes = 0;
					start = end + 1;
				} else {
					start = n;
				}
			}
		}
		// 文件末尾没有换行的残留行
		if (skipLine) streamBad++;
		else if (parts.length) emit(parts);
	} finally {
		if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
	}
	return {
		records: state.records,
		profile: state.profile,
		description: state.description,
		badLines: streamBad + state.badLines,
	};
}

export interface SubUsage {
	cost: Money; split: CostSplit; input: number; output: number; cacheRead: number; cacheWrite: number;
	calls: number; agents: number; dupSkipped: number; badLines: number;
	profiles: Record<string, { cost: Money; calls: number }>;
}
function emptySub(): SubUsage {
	return {
		cost: newMoney(), split: emptyCostSplit(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		calls: 0, agents: 0, dupSkipped: 0, badLines: 0, profiles: {},
	};
}

/** 子代理统计的整体缓存（1 秒节流，避免高频事件重复扫盘） */
let subScanCache: { at: number; key: string; value: SubUsage } | undefined;

/**
 * 统计当前会话的所有后代会话（子代理）用量与费用。
 * sessions/<cwd-slug>/<file>.jsonl 的 header 里带 parentSession，指向父会话路径。
 */
function collectSubagentUsage(ctx: any, sessionFile: string | undefined, seen?: Set<string>): SubUsage {
	const out = emptySub();
	const seenFingerprints = seen ?? new Set<string>();
	if (!sessionFile) return out;
	let pricingKey = "";
	try {
		pricingKey = String(statSync(PRICING_FILE).mtimeMs);
	} catch {
		pricingKey = "-";
	}
	// 去重指纹集合也进 cache key：缓存结果已按本次渲染的主会话去重过
	const key = `${sessionFile}|${pricingKey}|${fpSignature(seenFingerprints)}`;
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
		out.badLines += stats.badLines ?? 0;
		const profile = stats.profile || "subagent";
		for (const r of stats.records) {
			// 主会话已计过的同一条 entry（fork/clone 副本）跳过；summary 记录统一用空 provider/model
			const fp = usageFingerprint(r.summary ? { id: r.id, ts: r.ts, provider: "", model: "", usage: r.usage } : r);
			if (seenFingerprints.has(fp)) {
				out.dupSkipped++;
				continue;
			}
			seenFingerprints.add(fp);
			// 首次真正计入一条记录时才建 profile 桶：全部被去重跳过的 profile 不产生空桶
			const bucket = (out.profiles[profile] ??= { cost: newMoney(), calls: 0 });
			const u = r.usage ?? {};
			const prov = r.provider ?? ctx.model?.provider;
			const mod = r.model ?? ctx.model?.id;
			const c = callCost(ctx, prov, mod, u, r.ts);
			addMoney(out.cost, c.v, c.cur);
			addToSplit(out.split, c.v, c.cur, c.kind);
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

export interface MainUsage {
	cost: Money; split: CostSplit;
	input: number; output: number; cacheRead: number; cacheWrite: number; calls: number;
}
function emptyMain(): MainUsage {
	return { cost: newMoney(), split: emptyCostSplit(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
}

/**
 * 主会话用量统计：先于子代理执行，并把指纹写进 seen（首见者胜）——
 * 这样 fork/clone 出来的子会话副本不会重复计费。
 */
function collectMainUsage(ctx: any, entries: any[], seen: Set<string>): MainUsage {
	const out = emptyMain();
	for (const e of entries) {
		const isMsg = e.type === "message" && e.message?.role === "assistant";
		const u = isMsg ? e.message.usage : e.type === "compaction" || e.type === "branch_summary" ? e.usage : undefined;
		if (!u) continue;
		// 压缩/分支总结的调用不记录模型，按当前模型估价
		const prov = isMsg ? e.message.provider : ctx.model?.provider;
		const mod = isMsg ? e.message.model : ctx.model?.id;
		// 统一归一到毫秒时间戳：与 parseUsageText 解析子会话时的口径一致，指纹才能对上
		const rawTs = isMsg ? e.message.timestamp : e.timestamp;
		const ts = typeof rawTs === "number" ? rawTs : Date.parse(rawTs);
		// 摘要（compaction/branch_summary）指纹统一用空 provider/model，与子会话侧一致；
		// 计价仍用 prov/mod（当前模型），指纹材料与计价口径分离。
		seen.add(usageFingerprint(isMsg
			? { id: e.id, ts, provider: prov, model: mod, usage: u }
			: { id: e.id, ts, provider: "", model: "", usage: u }));
		out.calls++;
		out.input += u.input ?? 0;
		out.output += u.output ?? 0;
		out.cacheRead += u.cacheRead ?? 0;
		out.cacheWrite += u.cacheWrite ?? 0;
		const c = callCost(ctx, prov, mod, u, ts);
		addMoney(out.cost, c.v, c.cur);
		addToSplit(out.split, c.v, c.cur, c.kind);
	}
	return out;
}

/** 一次聚合的结果：主会话 + 子代理（带去重），渲染与 /budget 命令共用同一份 */
export interface UsageAgg { main: MainUsage; sub: SubUsage; total: Money; split: CostSplit }

/** 配置里是否把子代理计入总额（唯一读取点，渲染与命令都走这里） */
function includeSubagents(cfg: any): boolean {
	return cfg?.includeSubagents !== false;
}

/**
 * 一次聚合：主会话 + 子代理（带去重），供渲染与 /budget 命令共用。
 * 主会话先计入 seen，子代理里已出现过的 entry 跳过——命令与 widget 因此口径一致。
 * cfg 可传入（渲染处已经读过配置，避免同一次渲染重复读配置文件）。
 */
export function aggregateUsage(ctx: any, entries: any[], cfg?: any): UsageAgg {
	const seen = new Set<string>();
	const main = collectMainUsage(ctx, entries, seen);
	const conf = cfg ?? readJson(join(AGENT_DIR, "session-budget.json")) ?? {};
	const sub = includeSubagents(conf) ? collectSubagentUsage(ctx, ctx.sessionManager.getSessionFile?.(), seen) : emptySub();
	const total = newMoney();
	addMoney(total, main.cost.cny, "¥");
	addMoney(total, main.cost.usd, "$");
	addMoney(total, sub.cost.cny, "¥");
	addMoney(total, sub.cost.usd, "$");
	const split = emptyCostSplit();
	mergeSplit(split, main.split);
	mergeSplit(split, sub.split);
	return { main, sub, total, split };
}

/** 聚合失败时退化为空聚合（不影响命令与渲染） */
function safeAggregateUsage(ctx: any, entries: any[]): UsageAgg {
	try {
		return aggregateUsage(ctx, entries);
	} catch {
		return { main: emptyMain(), sub: emptySub(), total: newMoney(), split: emptyCostSplit() };
	}
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

	// ---- 周期重绘：setWidget 是推送式的，前端重挂载 / 丢包后不会回填，只能靠下一次推送修复 ----
	/** 最近一次成功渲染用的 ctx（周期重绘需要） */
	let lastCtx: any;
	let repainter: Repainter | undefined;
	let repainterStarted = false;

	/** 只在真有 UI 时才值得重绘：无 UI（ctx.hasUI === false）或没有 setWidget 都不启动 */
	function uiAvailable(ctx: any): boolean {
		return ctx?.hasUI !== false && typeof ctx?.ui?.setWidget === "function";
	}

	function stopRepainter(): void {
		try {
			repainter?.stop();
		} catch {
			/* 停止失败不影响会话 */
		}
		repainter = undefined;
		repainterStarted = false;
		lastCtx = undefined;
	}

	/** 第一次成功渲染之后启动；内容相同也照推，所以无条件下发 */
	function ensureRepainter(ctx: any): void {
		if (repainter || repainterStarted) return;
		// 先判断有没有 UI，再置位：否则一次无 UI 的渲染会把开关永久关掉
		if (!uiAvailable(ctx)) return;
		repainterStarted = true;
		repainter = startRepainter({ render: () => render(lastCtx), intervalMs: refreshIntervalMs(readJson(join(AGENT_DIR, "session-budget.json")) ?? {}) });
	}

	function render(ctx: any) {
		try {
			const entries: any[] = ctx.sessionManager.getEntries();
			const cfg = readJson(join(AGENT_DIR, "session-budget.json")) ?? {};
			CURRENCY = cfg.currency === "¥" || cfg.currency === "$" ? cfg.currency : "auto";
			// 与 /budget 命令共用同一个聚合函数（includeSubagents 在 aggregateUsage 内统一判定）
			const agg = aggregateUsage(ctx, entries, cfg);
			const { main, sub } = agg;
			const mainCost = main.cost;
			const { input, output, cacheRead, cacheWrite, calls } = main;

			if (process.env.SESSION_BUDGET_DEBUG) {
				console.error(`session-budget: 子代理 ${sub.agents} 个 · dupSkipped ${sub.dupSkipped} · 坏行 ${sub.badLines}`);
			}
			const totalSplit = agg.split;
			const totalCost = agg.total;

			const budget = sessionBudget(entries);
			const warnAt = cfg.warnAt ?? 0.8;
			// 总额全为估算时前缀 ≈
			let costPart = `💰 ${estOnly(totalSplit) ? "≈" : ""}${displayMoney(totalCost)}`;
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
					`🤖 子代理 ${sub.agents} 个 · ${estOnly(sub.split) ? "≈" : ""}${displayMoney(sub.cost)} · ${sub.calls} 次调用` +
						` · 入 ${fmtTok(sub.input)} · 出 ${fmtTok(sub.output)} · 缓存读 ${fmtTok(sub.cacheRead)} · 缓存写 ${fmtTok(sub.cacheWrite)}` +
						` · 💾 命中 ${hitRate(sub.input, sub.cacheRead, sub.cacheWrite)}` +
						(detail ? `   ↳ ${detail}` : ""),
				);
			}

			ctx.ui.setWidget(KEY, lines);
			// 渲染成功且拿得到可用 ctx 之后才启动周期重绘（内容相同也照推）
			lastCtx = ctx;
			ensureRepainter(ctx);
		} catch (err) {
			if (process.env.SESSION_BUDGET_DEBUG) console.error("session-budget render failed", err);
			// 显示失败不影响会话
		}
	}

	// 把按价格表算出的费用写回消息，pi-web 自带的费用显示也随之准确
	pi.on("message_end", async (event: any) => {
		const m = event?.message;
		if (!m || m.role !== "assistant" || !m.usage) return;
		const rawTs = m.timestamp ?? Date.now();
		const ts = typeof rawTs === "number" ? rawTs : Date.parse(rawTs);
		const c = priceByTable(m.provider, m.model, m.usage, ts);
		if (!c) return;
		return { message: { ...m, usage: { ...m.usage, cost: c } } };
	});

	// session_info_changed：切会话时可能触发，立即重绘一次
	/**
	 * 事件驱动重绘：input（用户开始打字）也能触发，这样切回窗口后一敲字状态行就立刻回来，
	 * 不用等周期重绘的间隔。input 频率高（每次按键），单独节流；其他事件保持立即渲染。
	 */
	let lastInputRenderAt = 0;
	function renderOnEvent(ctx: any, throttled = false): void {
		if (throttled) {
			const now = Date.now();
			if (now - lastInputRenderAt < 400) return;
			lastInputRenderAt = now;
		}
		render(ctx);
	}

	for (const ev of ["session_start", "message_end", "turn_end", "agent_end", "session_compact", "model_select", "session_info_changed", "input"] as const) {
		try {
			pi.on(ev as any, async (_e: any, ctx: any) => renderOnEvent(ctx, ev === "input"));
		} catch {
			// 某些事件名在旧版本不存在时忽略
		}
	}

	// 会话结束：停掉定时器，避免继续往已失效的会话推 widget
	try {
		pi.on("session_shutdown" as any, async () => stopRepainter());
	} catch {
		// 旧版本没有 session_shutdown 时忽略
	}

	pi.registerCommand("budget", {
		description: "设置/查看本会话费用预算：/budget 5 | /budget $5 | /budget off",
		handler: async (args, ctx) => {
			const a = args.trim();
			const low = a.toLowerCase();
			// 命令与 widget 共用同一份聚合结果：子代理数与金额、成本构成都取自它（口径一致）
			const agg = safeAggregateUsage(ctx, ctx.sessionManager.getEntries() as any[]);
			// /budget 输出末尾固定追加成本构成行
			const breakdown = costBreakdownText(agg.split);
			if (!a) {
				const b = sessionBudget(ctx.sessionManager.getEntries() as any[]);
				const sub = agg.sub;
				const extra = sub.agents ? `，子代理 ${sub.agents} 个 / ${displayMoney(sub.cost)}` : "";
				ctx.ui.notify((b ? `本会话预算：${fmtNum(b.cur, b.amount)}${extra}` : `本会话未设预算（/budget 5 设为 ¥5，/budget $5 设为 $5）${extra}`) + `\n${breakdown}`, "info");
			} else if (low === "off" || low === "0") {
				pi.appendEntry(KEY, { usd: null });
				ctx.ui.notify(`已取消本会话预算\n${breakdown}`, "info");
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
				ctx.ui.notify(`本会话预算已设为 ${fmtNum(cur, n)}\n${breakdown}`, "info");
			}
			render(ctx);
		},
	});
}
