#!/usr/bin/env node
// 宿主 API 符号存在性检查（零依赖）
//
// 背景：本扩展用 mock 宿主做契约测试，而 mock 是手写的「测试替身」，
// 不会随上游 pi 宿主 API 变更而变化（测试环境漂移）。
// 本脚本直接读真实宿主包 @earendil-works/pi-coding-agent 的类型声明，
// 核对扩展实际用到的每一个宿主 API 名字**仍然存在**——
// 挡掉「上游改名 / 删除」这类会让扩展静默失效的破坏。
//
// 用法：
//   node scripts/host-api-check.mjs            # 打印逐项结果；缺失时退出码 1
//   PI_HOST_PACKAGE_DIR=/path/to/pkg node scripts/host-api-check.mjs
//
// 找不到宿主包时不算失败（跳过并提示），保证在没装 pi 的环境也能跑。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const PKG_NAME = "@earendil-works/pi-coding-agent";

/** 候选宿主包目录（按优先级） */
function candidatePackageDirs() {
	const out = [];
	const push = (p) => {
		if (p && !out.includes(p)) out.push(p);
	};
	// 1) 显式指定
	push(process.env.PI_HOST_PACKAGE_DIR);
	// 2) 从本脚本位置向上解析 node_modules
	try {
		const require = createRequire(import.meta.url);
		push(dirname(require.resolve(`${PKG_NAME}/package.json`)));
	} catch {
		/* 没装就跳过 */
	}
	// 3) PATH 上的 pi 可执行文件旁边（pi 自带 node_modules）
	for (const dir of (process.env.PATH || "").split(delimiter)) {
		if (!dir) continue;
		for (const exe of ["pi", "pi.cmd", "pi.exe"]) {
			if (existsSync(join(dir, exe))) {
				push(join(dir, "node_modules", ...PKG_NAME.split("/")));
			}
		}
	}
	// 4) 常见安装位置
	push(join(homedir(), ".pi", "agent", "npm", "node_modules", ...PKG_NAME.split("/")));
	if (process.env.PI_CODING_AGENT_DIR) {
		push(join(process.env.PI_CODING_AGENT_DIR, "npm", "node_modules", ...PKG_NAME.split("/")));
	}
	return out;
}

/** 定位宿主包目录；找不到返回 null */
export function locateHostPackage() {
	for (const dir of candidatePackageDirs()) {
		if (dir && existsSync(join(dir, "package.json"))) return dir;
	}
	return null;
}

/** 从 package.json 找类型声明入口 */
function typesEntry(pkgDir, pkg) {
	const t = pkg.types || pkg.typings;
	if (typeof t === "string") return resolve(pkgDir, t);
	const exp = pkg.exports && pkg.exports["."];
	if (exp && typeof exp === "object" && typeof exp.types === "string") return resolve(pkgDir, exp.types);
	return resolve(pkgDir, "dist", "index.d.ts");
}

/** 把 re-export 的相对路径解析成实际的 .d.ts 文件 */
function resolveDeclPath(fromDir, spec) {
	const base = resolve(fromDir, spec);
	const cands = [base.replace(/\.ts$/, ".d.ts"), base.replace(/\.tsx?$/, ".d.ts"), base, join(base, "index.d.ts")];
	for (const c of cands) {
		if (c.endsWith(".d.ts") && existsSync(c)) return c;
	}
	return null;
}

/**
 * 收集类型声明文本：从入口 .d.ts 出发，沿 re-export 链 BFS。
 * 找到全部目标符号后提前停止（避免读完 3000+ 个声明文件）。
 */
export function collectTypeDeclarations(pkgDir, wanted) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	} catch {
		return "";
	}
	const seen = new Set();
	const queue = [typesEntry(pkgDir, pkg)];
	const chunks = [];
	const missing = () => wanted.filter((name) => !new RegExp(`\\b${name}\\s*[(:?]`).test(chunks.join("\n")));
	while (queue.length) {
		const file = queue.shift();
		if (!file || seen.has(file)) continue;
		seen.add(file);
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		chunks.push(text);
		if (wanted.length && missing().length === 0) break; // 全部命中就停
		for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
			const next = resolveDeclPath(dirname(file), m[1]);
			if (next) queue.push(next);
		}
	}
	return chunks.join("\n");
}

/** 符号是否在声明文本里出现（宽松：只查名字，不校验签名） */
export function hasSymbol(declarations, name) {
	return new RegExp(`\\b${name}\\s*[(:?]`).test(declarations);
}

/**
 * 核对扩展声明的宿主 API 清单。
 * @param {readonly string[]} apiUsage 形如 "ctx.ui.setWidget"
 * @returns {{pkgDir:string|null, version:string|null, results:{api:string,name:string,ok:boolean}[], missing:string[]}}
 */
export function checkHostApi(apiUsage) {
	const pkgDir = locateHostPackage();
	const results = [];
	if (!pkgDir) {
		for (const api of apiUsage) results.push({ api, name: api.split(".").pop(), ok: false });
		return { pkgDir: null, version: null, results, missing: [] };
	}
	let version = null;
	try {
		version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? null;
	} catch {
		/* 忽略 */
	}
	const names = [...new Set(apiUsage.map((a) => a.split(".").pop()))];
	const declarations = collectTypeDeclarations(pkgDir, names);
	for (const api of apiUsage) {
		const name = api.split(".").pop();
		results.push({ api, name, ok: hasSymbol(declarations, name) });
	}
	const missing = results.filter((r) => !r.ok).map((r) => r.api);
	return { pkgDir, version, results, missing };
}

/** 从扩展里取 HOST_API_USAGE 清单 */
async function loadApiUsage() {
	const mod = await import("../extensions/session-budget.ts");
	return mod.HOST_API_USAGE ?? [];
}

// CLI：直接运行时打印逐项结果
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("host-api-check.mjs")) {
	const apiUsage = await loadApiUsage();
	const { pkgDir, version, results, missing } = checkHostApi(apiUsage);
	if (!pkgDir) {
		console.log("⚠ 未找到宿主包", PKG_NAME, "——跳过检查（可用 PI_HOST_PACKAGE_DIR 指定）");
		console.log("  候选位置:");
		for (const c of candidatePackageDirs()) console.log("   -", c);
		process.exit(0);
	}
	console.log(`宿主包: ${pkgDir}${version ? ` (v${version})` : ""}`);
	for (const r of results) console.log(`  ${r.ok ? "✔" : "✘"} ${r.api}`);
	if (missing.length) {
		console.log(`\n✘ ${missing.length} 个宿主 API 在类型声明里找不到：${missing.join(", ")}`);
		console.log("  上游可能改名或删除了这些 API —— 请同步更新扩展与 HOST_API_USAGE 清单。");
		process.exit(1);
	}
	console.log(`\n✔ ${results.length} 个宿主 API 全部存在`);
	process.exit(0);
}
