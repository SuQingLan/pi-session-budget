#!/usr/bin/env bash
# session-budget 扩展安装脚本（Git Bash / Linux / macOS 通用）
#
#   bash install.sh                 # 自动探测 agent 目录
#   bash install.sh --agent-dir D:/x # 指定 agent 目录
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

if [ -z "${AGENT_DIR}" ]; then
  BASE="${HOME:-${USERPROFILE:-}}"
  if [ -z "${BASE}" ]; then echo "找不到 HOME/USERPROFILE，请用 --agent-dir 指定"; exit 1; fi
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) AGENT_DIR="$(cygpath -w "${BASE}")/.pi/agent" ;;
    *) AGENT_DIR="${BASE}/.pi/agent" ;;
  esac
fi

echo "agent 目录: ${AGENT_DIR}"
mkdir -p "${AGENT_DIR}/extensions"
cp "${SRC_DIR}/extensions/session-budget.ts" "${AGENT_DIR}/extensions/session-budget.ts"
echo "✔ 已安装扩展: ${AGENT_DIR}/extensions/session-budget.ts"

if [ ! -f "${AGENT_DIR}/session-budget.json" ]; then
  cp "${SRC_DIR}/session-budget.example.json" "${AGENT_DIR}/session-budget.json"
  echo "✔ 已生成配置: ${AGENT_DIR}/session-budget.json"
else
  echo "· 配置已存在，未覆盖: ${AGENT_DIR}/session-budget.json"
fi

if [ -f "${AGENT_DIR}/cheapmodel-pricing.json" ]; then
  echo "✔ 检测到价格表（人民币口径，费用显示 ¥）"
else
  echo "! 未检测到 cheapmodel-pricing.json → 费用按 models.json 单价估算，显示 \$（美元）"
  echo "  如需人民币口径，请用 cheapmodel-pricing-refresh.py（需你自己的站点账号）生成后放入该路径"
fi

echo
echo "完成。重启 pi / pi-web 后生效。"
echo "用法：/budget 查看预算 · /budget 5 设 ¥5 预算 · /budget \$5 设 \$5 预算 · /budget off 取消"
