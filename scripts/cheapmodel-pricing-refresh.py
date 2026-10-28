"""Refresh cheapmodel pricing for pi's session-budget extension (and optionally magpie).

Usage (credentials only via env vars, never stored):
    CM_USER=... CM_PASS=... python cheapmodel-pricing-refresh.py [--magpie] [--dry-run] [--no-merge]

Environment:
    CM_USER, CM_PASS      site login (required)
    CM_BASE               site base url (default https://api.cheapmodel.net)
    PI_CODING_AGENT_DIR   pi agent dir (default ~/.pi/agent)
    MAGPIE_PROVIDERS      magpie providers.json (default ~/.config/magpie/providers.json)
    MAGPIE_CLI            magpie cli path (default: magpie-cli / magpie on PATH)

Writes <agentDir>/cheapmodel-pricing.json:
  - token groups: site tier prices x group rate, as numbers in the site's balance unit (CNY) per 1M tokens
  - DeepSeek peak/offpeak, GPT >272k tiers, peak schedule (Beijing time) from the site
  - Kiro credit group: per-model linear fit of real billed cost (cost_micro) from /api/v1/me/requests
Maps every pi model (models.json) and magpie provider to a route group by matching API key prefixes.
--magpie also runs `magpie model price` for the magpie-served models (numbers entered as "USD").
"""
import http.cookiejar, json, os, re, shutil, subprocess, sys, time, urllib.error, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

BASE = os.environ.get("CM_BASE", "https://api.cheapmodel.net")
AGENT_DIR = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(os.path.expanduser("~"), ".pi", "agent")
OUT = os.path.join(AGENT_DIR, "cheapmodel-pricing.json")
MAGPIE_PROVIDERS = os.environ.get("MAGPIE_PROVIDERS") or os.path.join(os.path.expanduser("~"), ".config", "magpie", "providers.json")
MAGPIE_CLI = os.environ.get("MAGPIE_CLI") or shutil.which("magpie-cli") or shutil.which("magpie") or "magpie-cli"
TIER_SPLIT = 272000

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def api(path, body=None):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
        csrf = next((c.value for c in jar if c.name == "rh_csrf"), None)
        if csrf:
            headers["X-CSRF-Token"] = csrf
    for attempt in range(4):
        req = urllib.request.Request(BASE + path, data=data, headers=headers)
        try:
            with opener.open(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504) and attempt < 3:
                time.sleep(10 * (attempt + 1))
                continue
            raise


def solve(A, b):
    n = len(b)
    M = [A[i][:] + [b[i]] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-9:
            return None
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


def lstsq(X, y):
    k = len(X[0])
    A = [[sum(r[i] * r[j] for r in X) for j in range(k)] for i in range(k)]
    b = [sum(r[i] * t for r, t in zip(X, y)) for i in range(k)]
    return solve(A, b)


def r6(x):
    return round(x, 6)


def main():
    magpie = "--magpie" in sys.argv
    dry = "--dry-run" in sys.argv
    merge = "--no-merge" not in sys.argv  # 默认合并：站内分组改名/删除时不要丢旧价目
    user, pw = os.environ.get("CM_USER"), os.environ.get("CM_PASS")
    if not user or not pw:
        sys.exit("set CM_USER and CM_PASS")
    api("/api/v1/auth/config?locale=zh")
    api("/api/v1/auth/login", {"username": user, "password": pw})
    site = api("/api/v1/models")
    keys = api("/api/v1/keys")
    keys = keys.get("data", keys) if isinstance(keys, dict) else keys
    groups = {g["id"]: g for g in site["groups"]}
    models = {m["id"]: m for m in site["data"]}

    # ---- request logs (for Kiro credit fit)
    logs = []
    off = 0
    while off < 5000:
        page = api(f"/api/v1/me/requests?limit=200&offset={off}")["data"]
        logs += page
        if len(page) < 200:
            break
        off += 200
    for r in logs:
        for k in ("tokens_in", "tokens_out", "cache_read", "cache_write"):
            r[k] = r.get(k) or 0

    # ---- token-group rules
    def token_rule(model_id, group_id):
        m, g = models.get(model_id), groups.get(group_id)
        if not m or not g:
            return None
        rate = g["rate_multiplier"]
        tiers = []
        for t in m["tiers"]:
            if t.get("mode") != "standard":
                continue
            tiers.append({
                "period": {"all": "all", "peak": "peak", "offpeak": "offpeak"}.get(t.get("period"), "all"),
                "minInput": t.get("tier_min") or 0,
                "maxInput": t.get("tier_max"),
                "input": r6(t["price_in"] * rate), "output": r6(t["price_out"] * rate),
                "cacheRead": r6(t.get("cache_read", 0) * rate), "cacheWrite": r6((t.get("cache_write") or 0) * rate),
            })
        return {"group": group_id, "tiers": tiers} if tiers else None

    # ---- Kiro credit fit: cost = a*tokens_in + b*out + c (all input kinds charged alike)
    kiro_fit = {}
    for gid, g in groups.items():
        if g.get("pricing_mode") != "credit":
            continue
        by = defaultdict(list)
        for r in logs:
            if r.get("route_group_name") == g["name"] and r.get("status") == "success" and r.get("cost_micro"):
                by[r["model"]].append(r)
        for mid, rows in by.items():
            X = [[r["tokens_in"], r["tokens_out"], 1] for r in rows]
            y = [r["cost_micro"] for r in rows]
            c = lstsq(X, y) if len(rows) >= 3 else None
            if c and c[0] >= 0 and c[1] > 0:
                err = max(abs(sum(a * b for a, b in zip(c, x)) - t) / t for x, t in zip(X, y))
                if err < 0.02:
                    kiro_fit[(gid, mid)] = {"input": c[0], "output": c[1], "perRequest": c[2] / 1e6, "n": len(rows), "fit": "exact"}
                    continue
            by[mid] = rows  # keep for the ratio fallback below
        # Too few distinct inputs to separate input from output: assume the group's input/output price ratio
        ratios = [v["input"] / v["output"] for (g2, _), v in kiro_fit.items() if g2 == gid]
        if ratios:
            ratio = sorted(ratios)[len(ratios) // 2]
            for mid, rows in by.items():
                if (gid, mid) in kiro_fit or len(rows) < 2:
                    continue
                X = [[r["tokens_out"] + ratio * r["tokens_in"], 1] for r in rows]
                y = [r["cost_micro"] for r in rows]
                c = lstsq(X, y)
                if c and c[0] > 0:
                    err = max(abs(c[0] * x[0] + c[1] - t) / t for x, t in zip(X, y))
                    if err < 0.05:
                        kiro_fit[(gid, mid)] = {"input": c[0] * ratio, "output": c[0], "perRequest": max(c[1], 0) / 1e6, "n": len(rows), "fit": "ratio"}

    def family(mid):
        return next((f for f in ("opus", "sonnet", "haiku") if f in mid), None)

    def credit_rule(model_id, group_id):
        f = kiro_fit.get((group_id, model_id))
        if not f:  # borrow from a fitted model of the same family
            fam = family(model_id)
            cand = [v for (g, m), v in kiro_fit.items() if g == group_id and family(m) == fam]
            if not cand:
                return None
            f = dict(max(cand, key=lambda v: v["n"]), fit="family", n=0)
        a = r6(f["input"])
        return {"group": group_id, "fit": f["fit"], "samples": f["n"], "perRequest": r6(f["perRequest"]),
                "tiers": [{"period": "all", "minInput": 0, "maxInput": None, "input": a, "output": r6(f["output"]), "cacheRead": a, "cacheWrite": a}]}

    def rule_for(model_id, group_id):
        g = groups.get(group_id)
        if not g:
            return None
        return credit_rule(model_id, group_id) if g.get("pricing_mode") == "credit" else token_rule(model_id, group_id)

    # ---- key prefix -> group
    prefix_group = {k["prefix"]: k["route_group_id"] for k in keys if k.get("prefix")}

    def group_of_key(key):
        return next((g for p, g in prefix_group.items() if key and key.startswith(p)), None)

    pi_models = json.load(open(os.path.join(AGENT_DIR, "models.json"), encoding="utf-8"))["providers"]
    mp = json.load(open(MAGPIE_PROVIDERS, encoding="utf-8"))["providers"] if os.path.exists(MAGPIE_PROVIDERS) else []
    magpie_group = {p["id"]: group_of_key(p.get("key") or "") for p in mp}
    magpie_group = {k: v for k, v in magpie_group.items() if v}

    rules, report = {}, []
    for prov, v in pi_models.items():
        for m in v.get("models", []):
            mid = m["id"]
            if prov == "magpie":
                pre, _, base = mid.partition("/")
                g = magpie_group.get(pre)
                if pre == "auto":  # routing group: price by its primary provider
                    g = magpie_group.get("cc-cheapmodel" if base.startswith("claude") else "codex-cheapmodel")
            else:
                base, g = mid, group_of_key(v.get("apiKey") or "")
            if not g:
                continue
            rule = rule_for(base, g)
            if rule:
                rules[f"{prov}/{mid}"] = rule
                report.append(f"{prov}/{mid} -> {g}")
            else:
                report.append(f"SKIP {prov}/{mid} ({g}: no price)")

    ps = site.get("peak_schedule") or {}
    out = {
        "source": BASE + "/api/v1/models + /api/v1/me/requests",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "unit": "site balance unit (CNY) per 1M tokens; perRequest per call",
        "tierBy": "input + cacheRead + cacheWrite of one request; the whole request takes that tier",
        "peakSchedule": {"utcOffsetMinutes": 480, "weekdays": ps.get("weekdays", [1, 2, 3, 4, 5]),
                         "windows": ps.get("windows", []), "holidays": ps.get("holidays", []), "makeupWorkdays": []},
        "rules": rules,
    }
    print("\n".join(report))
    # --merge：保留旧表里本次没抓到的规则（站内分组改名/删除时，旧价目仍比退回 models.json 准）
    if merge and os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
            kept = 0
            for k, v in (old.get("rules") or {}).items():
                if k not in rules:
                    rules[k] = v
                    kept += 1
            if kept:
                out["mergedFrom"] = old.get("updatedAt")
                print(f"merge: kept {kept} rules from previous table")
        except Exception as e:
            print("merge failed:", e)
    if not dry:
        # keep manually added makeup workdays
        if os.path.exists(OUT):
            try:
                out["peakSchedule"]["makeupWorkdays"] = json.load(open(OUT, encoding="utf-8"))["peakSchedule"].get("makeupWorkdays", [])
            except Exception:
                pass
        json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("wrote", OUT, len(rules), "rules")

    if magpie:
        done = set()
        for key, rule in rules.items():
            if not key.startswith("magpie/"):
                continue
            mid = key[len("magpie/"):]
            if mid.startswith("auto/") or mid in done:
                continue
            done.add(mid)
            ts = rule["tiers"]
            base = next((t for t in ts if t["minInput"] == 0 and t["period"] in ("all", "peak")), ts[0])
            fmt = lambda t: ",".join(str(t[k]) for k in ("input", "output", "cacheRead", "cacheWrite")) + f",{t['cacheWrite']}"
            cmd = [MAGPIE_CLI, "model", "price", mid, fmt(base)]
            for t in ts:
                if t["minInput"] and t["period"] in ("all", "peak"):
                    cmd += ["--tier", f"{(t['minInput'] - 1) // 1000}k", fmt(t)]
            print("magpie:", " ".join(cmd[2:]))
            if not dry:
                r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
                if r.returncode != 0:
                    print("   FAILED:", (r.stderr or r.stdout).strip()[:300])


if __name__ == "__main__":
    main()
