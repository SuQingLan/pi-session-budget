# pi-session-budget

> Real-time cost, token and cache-hit widget for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — including **subagent** usage.

在 pi / pi-web 输入框上方常驻一行状态，实时显示当前会话花了多少钱、用了多少 token、缓存命中率、上下文占了多少，并把**子代理（subagent）的用量一并计入**。

```
💰 ¥297.72 + $0.0114 (主 ¥74.49 + 子 ¥223.24 + $0.0114)   📦 上下文 168.7k / 压缩阈值 983.6k (17%)
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
  "includeSubagents": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultUsd` | 无 | 所有会话的默认预算（`0` = 不设） |
| `budgetCurrency` | `"¥"` | `defaultUsd` 的币种 |
| `warnAt` | `0.8` | 达到预算的该比例时弹提醒 |
| `currency` | `"auto"` | `auto` 按实际计价来源；`"¥"` / `"$"` 强制单一符号 |
| `includeSubagents` | `true` | 是否把子代理费用计入总额与预算 |

## 计价口径

每次调用按以下优先级估价：

1. **`<agentDir>/cheapmodel-pricing.json`**（可选）→ 人民币，显示 `¥`
   支持按时段（高峰/空闲）+ 上下文阶梯（整次请求按总输入落档）计价。
   该文件由 `scripts/cheapmodel-pricing-refresh.py` 从你的中转站价目生成，**站点与账号是你自己的，不要照抄别人的表**。
2. **`models.json`** 里该模型的单价 → 美元，显示 `$`
3. 消息里记录的原费用 → 美元

没有价格表也能用：全部走第 2 步，费用按美元估算。

> 费用是估算值，最终以服务商账单为准。

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

## 离线调试

不启动 pi 也能验证计算：

```bash
bun run test/render-demo.ts <session.jsonl> [agentDir]
```

把某个会话文件当作输入，打印渲染结果与 20 次渲染耗时。

## License

[MIT](LICENSE)
