# pi-session-budget

> Real-time cost, token and cache-hit widget for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — including **subagent** usage.

在 pi / pi-web 输入框上方常驻一行状态，实时显示当前会话花了多少钱、用了多少 token、缓存命中率、上下文占了多少，并把**子代理（subagent）的用量一并计入**。

```
💰 ≈¥297.72 + $0.0114 (主 ¥74.49 + 子 ¥223.24 + $0.0114)   📦 上下文 168.7k / 压缩阈值 983.6k (17%)
🔢 入 5.77M · 出 263.5k · 缓存读 23.95M · 缓存写 0 · 198 次调用 · 💾 缓存命中 80.6%
🤖 子代理 21 个 · ¥223.24 + $0.0114 · 850 次调用 · 入 12.21M · 出 916.4k · 缓存读 124.79M · 💾 命中 91.1%   ↳ worker-pro ¥147.92 (496) · reviewer ¥7.49 (75)
```

---

## 功能

| 功能 | 说明 |
|---|---|
| **费用累计** | 按每次调用的 usage 计价并累加，支持预算与超预算告警 |
| **缓存命中率** | `缓存读 / (输入 + 缓存读 + 缓存写)`，主会话与子代理分别统计 |
| **子代理费用** | 递归统计所有后代会话（多层嵌套也支持），按各自模型分别计价 |
| **上下文占用** | 当前上下文 / 压缩阈值（读取 `settings.json` 的 `reserveTokens`，与 pi 的实际压缩时机一致） |
| **按 profile 拆分** | 子代理行末尾按 profile（worker / reviewer / scout …）给出小计与调用次数 |
| **多币种** | 价格表命中显示 `¥`，`models.json` 单价显示 `$`，混用时并列显示，绝不把美元标成人民币 |
| **跨会话去重** | 按 entry 指纹（id + 时间 + 模型 + 四项 token）去重，fork / clone 副本只计一次 |
| **真实 / 估算分列** | 价格表与 `models.json` 算出的算估算，`usage.cost.total` 算真实；widget 全估算时加 `≈`，`/budget` 给出构成 |
| **历史重算** | 每次渲染都按**当前**价格表重算全部历史调用，换价后旧会话数字同步更新 |
| **费用回写** | 新回复结束时把算好的费用写回消息，pi-web 自带的费用显示随之准确 |

## 安装

```bash
git clone https://github.com/SuQingLan/pi-session-budget.git
cd pi-session-budget
bash install.sh
```

或手动复制：

```
extensions/session-budget.ts  →  <pi agent 目录>/extensions/session-budget.ts
session-budget.example.json   →  <pi agent 目录>/session-budget.json
```

`<pi agent 目录>` 为环境变量 `PI_CODING_AGENT_DIR`，未设置时是 `~/.pi/agent`（Windows：`%USERPROFILE%\.pi\agent`）。

安装后**重启 pi / pi-web** 生效。

指定目录安装：

```bash
bash install.sh --agent-dir /path/to/agent
```

## 使用

| 命令 | 作用 |
|---|---|
| `/budget` | 查看当前预算（含子代理小计） |
| `/budget 5` | 本会话预算设为 ¥5 |
| `/budget $5` | 本会话预算设为 $5 |
| `/budget off` | 取消本会话预算 |

预算存在会话文件里（跟随会话走），不是全局设置。

## 配置 `<agentDir>/session-budget.json`

```json
{
  "defaultUsd": 0,
  "budgetCurrency": "¥",
  "warnAt": 0.8,
  "currency": "auto",
  "includeSubagents": true,
  "refreshMs": 2000
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultUsd` | 无 | 所有会话的默认预算（`0` = 不设） |
| `budgetCurrency` | `"¥"` | `defaultUsd` 的币种 |
| `warnAt` | `0.8` | 达到预算的该比例时弹提醒 |
| `currency` | `"auto"` | `auto` 按实际计价来源；`"¥"` / `"$"` 强制单一符号 |
| `includeSubagents` | `true` | 是否把子代理费用计入总额与预算 |
| `refreshMs` | `2000` | 周期重绘间隔（毫秒），`0` = 关闭（环境变量 `SESSION_BUDGET_REFRESH_MS` 优先） |

## 刷新机制

状态行是**推送式**的：扩展调 `ctx.ui.setWidget` 只是往会话推一次消息，宿主并不回传确认，前端也不保留
可重放的副本。而 pi-web 切回某个会话时会**重挂载聊天视图**，只在挂载那一刻拉一次快照回填 widget；
SSE 重连和会话复用都不会重新触发 `session_start`。于是只要那一次推送被错过（推送发生在挂载之前、
连接断开过、宿主清空过扩展 UI），状态行就会一直空着，直到下次偶然的事件才恢复。

修法只能落在扩展侧：**周期性无条件重推**（`refreshMs`，默认 2000 ms）。内容与上次相同也照推 ——
内容相同不代表前端已经收到了。所以周期重绘只是**幂等的自我修复**，不会改变任何数字口径。

- 调小（如 `500`）：切回窗口后更快恢复，代价是渲染更频繁（每次渲染要扫一次子会话，实测约 16 ms）。
- 调大（如 `10000`）：更省 CPU，但掉线的状态行可能空上十秒。
- 设为 `0`：完全关闭。概率上仍然能用（事件触发时照常渲染），但**错过一次推送就会一直空着**，
  直到下一次 `session_start` / `message_end` / `turn_end` / `agent_end` / `session_compact` /
  `model_select` / `session_info_changed` / `input`。
- 事件触发里包含 **`input`**（用户开始打字）：切回窗口后一敲字，状态行**立即**回来，不用等周期重绘的间隔。
  `input` 频率高（每次按键），因此单独做了 400 ms 节流；其余事件保持立即渲染。
- 临时关闭或临时改间隔用环境变量 `SESSION_BUDGET_REFRESH_MS`（优先于配置文件），非法值按默认 2000 处理。
- 无 UI 的环境（`ctx.hasUI === false` 或没有 `ui.setWidget`）不启动定时器；定时器带 `unref()`，
  不会阻止 pi 进程退出；会话结束（`session_shutdown`）时停表。

## 计价口径

每次调用按以下优先级估价：

1. **`<agentDir>/cheapmodel-pricing.json`**（可选）→ 人民币，显示 `¥`
   支持按时段（高峰/空闲）+ 上下文阶梯（整次请求按总输入落档）计价。
   该文件由 `scripts/cheapmodel-pricing-refresh.py` 从你的中转站价目生成，**站点与账号是你自己的，不要照抄别人的表**。
2. **`models.json`** 里该模型的单价 → 美元，显示 `$`
3. 消息里记录的原费用 → 美元

没有价格表也能用：全部走第 2 步，费用按美元估算。

> 费用是估算值，最终以服务商账单为准。

## 统计口径

**去重**：每条 entry 有一个去重指纹 —— `sha1(id|时间|provider|model|input|output|cacheRead|cacheWrite)` 的前 16 位，**刻意不含文件路径**。
渲染时先统计主会话并把指纹记下，再统计子代理；子代理里指纹已出现过的记录直接跳过（首见者胜）。
因此 fork / clone 出来的会话副本（内容相同、文件不同）不会被重复计费。

压缩 / 分支总结（compaction / branch_summary）这类摘要记录在指纹里统一用**空 provider / 空 model**，并携带 entry 的 `id`：同一条摘要的主会话记录与 fork 副本因此指纹一致（按 `id` 去重），而不同会话里碰巧同毫秒同 usage 的摘要也不会被误合并。摘要的**计价**仍按当前模型——指纹材料与计价口径分离。

**真实 vs 估算**：两种情况分开统计，不混为一谈。

| 来源 | 性质 |
|---|---|
| `cheapmodel-pricing.json` 价格表 | 估算（`¥`） |
| `models.json` 单价 | 估算（`$`） |
| 消息里的 `usage.cost.total` | pi 记录的**真实成本**（`$`） |

widget 的总额在**全部来自估算**时加 `≈` 前缀（如 `💰 ≈¥297.72`）；只要有一条真实成本记录就不加。
`/budget` 输出末尾固定给出一行构成：`成本构成：真实 $12.34 · 估算 ¥45.67`（没有真实成本时显示 `真实成本未记录`）。
预算比较（百分比、超支、告警）仍按总额算。

**同一份聚合**：主会话 + 子代理只聚合一次（`aggregateUsage`，先计主会话指纹、再按同一集合去重子代理），
widget 与 `/budget` 都取这次聚合结果 —— 所以通知里的「子代理 N 个 / 金额」与 widget 的子代理行、构成行永远同口径。

「没有成本记录」与「明确记录为 0」是两回事：`usage` 里**没有 `cost` 字段**（或不是有限数）时，该条调用不计入金额、也不标为真实成本，构成里显示 `真实成本未记录`；只有 `usage.cost.total` 是有限数（含显式 `0`）才算真实成本（如 `真实 $0.0000`）。

**解析容错**：子会话 jsonl 按 64 KB 分块流式读取；
单行超过 4 MiB 直接跳过（不会把整行读进内存），坏 JSON 行跳过并计数；
compaction / branch_summary 只计顶层 `usage`，**不读 `retainedTail`**（里面是历史消息副本，读它会重复计数）。
坏行数在子代理统计结果里汇总，设 `SESSION_BUDGET_DEBUG=1` 可看到去重跳过数与坏行数。

## 子代理是怎么算进来的

pi-web 的子代理（`pi-web:subagent`）运行在**独立的 session 文件**里：

```
sessions/<cwd-slug>/2026-10-28T14-20-39-680Z_<id>.jsonl   ← 子代理会话
```

其 header 带 `parentSession` 指向父会话，主会话的 `getEntries()` 里看不到这些记录，所以只统计主会话的扩展必然漏算。

本扩展的做法：

1. 扫描 sessions 根目录下所有 `*.jsonl`，只读每个文件的**头部 16 KB** 判断 `parentSession`；
2. 以当前会话为根，沿 `parentSession` 做 BFS，找出所有后代（支持子代理再派子代理）；
3. 对后代会话全文解析 assistant 的 `usage`，按各自 `provider/model` 与调用时间戳计价；
4. 按 `mtime + size` 缓存解析结果，整体 1 秒节流 —— 实测每次渲染约 16 ms。

## 生成价格表（可选）

```bash
CM_USER=你的账号 CM_PASS=你的密码 python scripts/cheapmodel-pricing-refresh.py --magpie
```

> 口令写在命令行会进 shell history，推荐交互式读入：
>
> ```bash
> read -rs -p "站点口令: " CM_PASS; echo
> export CM_USER=<你的账号> CM_PASS
> python scripts/cheapmodel-pricing-refresh.py --magpie
> unset CM_PASS
> ```

| 环境变量 | 说明 |
|---|---|
| `CM_USER` / `CM_PASS` | 站点登录（必需，只在进程内使用，不落盘） |
| `CM_BASE` | 站点地址（可选：不设则沿用已有价格表里的站点地址；两者都无则报错） |
| `PI_CODING_AGENT_DIR` | pi agent 目录 |
| `MAGPIE_CLI` | magpie CLI 路径（默认在 PATH 里找 `magpie-cli` / `magpie`） |

参数：

- `--magpie`：把算出的价格同步写回 magpie 的模型价格
- `--dry-run`：只打印，不写文件
- `--no-merge`：默认会**保留**本次没抓到价的旧规则（站点分组改名/删除时不至于丢掉旧价目），该参数关闭此行为

> 抓价脚本是给"用中转站 + 需要人民币精确口径"的场景准备的；纯官方价场景不需要它。

## 隐私与脱敏

| 项 | 处理方式 |
|---|---|
| 站点账号口令 | 只从环境变量读，**只在进程内使用**，不写盘、不进日志 |
| 站点 API Key | 仅用前缀做分组匹配，**不会写进生成的价格表** |
| 扩展本体 | **零网络请求**，只读本地 `sessions/*.jsonl` 与 `settings.json` / `models.json` |
| 会话内容 | 只统计 token 与费用，**不读取、不外传 prompt 正文** |
| 私有价格表 | `cheapmodel-pricing.json` 已进 `.gitignore`，属站点专属数据 |
| 本地配置 / 会话文件 | `session-budget.json`、`*.jsonl` 已进 `.gitignore` |
| 站点地址 | 用 `CM_BASE` 指定；本文档不写死具体站点域名 |

> 本仓库只收录扩展源码与示例配置。任何带账号、密钥、价格表、会话记录的内容都请留在本地。

## 兼容性

- 需要支持 `ui.setWidget` / `registerCommand` / `sessionManager.getSessionFile` 的 `@earendil-works/pi-coding-agent`。
- 扩展本体**零第三方依赖**，只用 Node 内置模块。
- Windows / macOS / Linux 均可（`install.sh` 支持 Git Bash）。
- 子代理行依赖 pi-web 的 subagent 机制；纯 CLI 且没有子代理时该行不显示，其余功能正常。

### 宿主 API 依赖清单

扩展实际用到的宿主 API 列在源码导出的 `HOST_API_USAGE` 里（契约测试按这份清单逐项校验 mock 宿主覆盖）：

| 路径 | 用途 |
|---|---|
| `pi.on` | 订阅 `session_start` / `message_end` / `turn_end` / `agent_end` / `session_compact` / `model_select` / `session_info_changed` / `input`（立即重绘）与 `session_shutdown`（停表） |
| `pi.registerCommand` | 注册 `/budget` |
| `pi.appendEntry` | 把预算写进会话（`/budget 5`、`/budget off`） |
| `ctx.ui.setWidget` | 渲染状态行 |
| `ctx.ui.notify` | 预算告警与 `/budget` 输出 |
| `ctx.sessionManager.getEntries` | 读主会话用量记录（含 compaction / branch_summary） |
| `ctx.sessionManager.getSessionFile` | 定位当前会话文件，据此找子代理会话 |
| `ctx.modelRegistry.find` | 读 `models.json` 单价 |
| `ctx.getContextUsage` | 当前上下文占用 |
| `ctx.model.provider` / `ctx.model.id` | 摘要记录等无模型字段时按当前模型计价 |
| `ctx.hasUI` | 判断当前环境有没有 UI：`false` 时不启动周期重绘定时器 |

> **上游 pi 改宿主 API 时，此清单与契约测试需要同步更新**：源码里增删 `pi.*` / `ctx.*` 调用后，
> 改 `HOST_API_USAGE`；mock 宿主（`test/contract/extension.test.ts` 的 `makeHost` / `makeCtx`）也要补上，
> 否则「宿主 API 清单」用例会逐项报缺。

#### 符号存在性检查（挡上游改名）

mock 宿主是**手写测试替身**，不会随上游 pi 变更 —— 上游把 `setWidget` 改名后，所有 mock 测试照样全绿，
扩展在真实 pi 里却静默失效（状态行整行不显示）。为此本仓库会直接读**真实宿主包**的类型声明，
逐个核对上表里的符号是否**仍然存在**：

```bash
npm run check:host        # = node scripts/host-api-check.mjs
```

它会定位 `@earendil-works/pi-coding-agent`（依次尝试 `PI_HOST_PACKAGE_DIR` 环境变量 → 本仓库向上解析
node_modules → `PATH` 上的 `pi` 可执行文件旁 → `~/.pi/agent/npm/node_modules` → `$PI_CODING_AGENT_DIR/npm/node_modules`），
沿类型声明的 re-export 链找到符号，**缺一个就退出码 1**。该检查同时作为契约测试
（`test/contract/host-api.test.ts`）运行；**找不到宿主包时跳过而非失败**，保证没装 pi 的环境也能跑。

> 局限：只核对**名字**在不在，不校验签名与类型 —— 那是完整类型检查（`tsc` + devDependencies）的活，
> 本仓库坚持「运行时零依赖、clone 即可跑」，暂不引入。

## 离线调试

不启动 pi 也能验证计算：

```bash
bun run scripts/render-demo.ts <session.jsonl> [agentDir]
```

把某个会话文件当作输入，打印渲染结果与 20 次渲染耗时。

## 开发

```bash
npm test          # = node --test（Node 递归发现 test/ 下的 *.test.ts）
npm run check:host   # 核对宿主 API 符号在真实 pi 类型声明里仍存在
```

需要 Node >= 22.6（原生执行 `.ts`；实测 Node 24）。测试零第三方依赖，只用 `node:test` + `node:assert/strict`：

| 目录 | 内容 |
|---|---|
| `test/unit/` | 去重指纹、金额与「真实/估算」分列、`parseUsageText` 解析容错、`parseChildFile` 流式边界（跨块行 / 超长行 / UTF-8 多字节 / 坏行）、周期重绘器（间隔语义 / `unref` / 幂等 `stop`） |
| `test/contract/` | 扩展对外契约：注册的命令、渲染产物、`/budget` 写入与去重口径、`ui` 缺失不崩、周期重绘真的在跑 / 关闭后不跑、宿主 API 清单覆盖 |

> `node --test <目录>` 在 Node 24 会把目录当模块入口（报 `Cannot find module`），所以这里用不带参数的 `node --test`，由 Node 自己递归发现；演示脚本放在 `scripts/render-demo.ts` 而非 `test/`，避免被当成测试文件。

## License

[MIT](LICENSE)
