#!/usr/bin/env bash
# cli-image-gen 生图封装：codex / agy 无头调用 → 解析产物路径 → 验证位图。
# 用法: gen.sh <codex|agy> "<prompt>" [size]
# 成功: stdout 打印图片绝对路径; 失败: 非零退出, stderr 给诊断。
set -uo pipefail

channel="${1:-}"
prompt="${2:-}"
size="${3:-}"
model="${GEN_MODEL:-gemini-3.7-flash-low}"
timeout_s="${GEN_TIMEOUT:-300}"

die() { echo "gen.sh: $*" >&2; exit 1; }

[ "$channel" = "codex" ] || [ "$channel" = "agy" ] || die "first arg must be 'codex' or 'agy'"
[ -n "$prompt" ] || die "prompt is required"

command -v "$channel" >/dev/null 2>&1 || die "$channel CLI not found on PATH"

# 尺寸提示：拼进提示词（两个 CLI 的生图工具都不吃尺寸参数）
size_hint=""
if [[ "$size" =~ ^[0-9]+:[0-9]+$ ]]; then
  size_hint=", aspect ratio $size"
elif [[ "$size" =~ ^[0-9]+x[0-9]+$ ]]; then
  size_hint=", roughly $size pixels"
fi

# GNU timeout 不一定有（macOS）；有就用，没有就裸跑
runner() { # runner <seconds> <cmd...>
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    "$@"
  fi
}

# 时间锚点：调用前 touch，兜底扫描用 -newer
marker="$(mktemp)"
out=""
case "$channel" in
  codex)
    instr="请用内置的图片生成工具（image generation / image_gen）生成一张图片：${prompt}${size_hint}。生成完成后，在回复里给出图片的完整绝对保存路径（~/.codex/generated_images/ 下的文件）。除此之外不要做任何其他事情。"
    out="$(runner "$timeout_s" codex exec --skip-git-repo-check -c 'model_reasoning_effort="low"' "$instr" 2>&1)" || true
    root="$HOME/.codex/generated_images"
    path_re='([^ "'"'"'`（）()]*generated_images/[^ "'"'"'`（）()]*\.(png|jpe?g|webp))'
    ;;
  agy)
    instr="Use your built-in image generation tool (the Gemini image generation capability, NOT hand-written SVG or drawing code) to generate a PNG image: ${prompt}${size_hint}. Then reply with the absolute file path of the saved PNG."
    # ⚠️ agy 必须 --key=value 传参（空格分隔会被错误解析导致提示词碎片化）
    # --dangerously-skip-permissions：headless 模式无法弹权限询问，命令类工具
    # 会被自动拒绝；生图场景无需人工确认，直接放行
    out="$(runner "$timeout_s" agy --print --output-format=stream-json --model="$model" --dangerously-skip-permissions --prompt="$instr" 2>&1)" || true
    root="$HOME/.gemini/antigravity-cli/brain"
    path_re='file://([^ "'"'"'`（）()]*antigravity-cli/brain/[^ "'"'"'`（）()]*\.(png|jpe?g|webp))'
    ;;
esac

# 1) 优先从输出解析路径
img=""
while IFS= read -r line; do
  if [[ "$line" =~ $path_re ]]; then
    p="${BASH_REMATCH[1]}"
    [ -f "$p" ] && img="$p" && break
  fi
done <<< "$out"

# 2) 兜底：按 -newer 锚点扫产物目录，取最新
if [ -z "$img" ]; then
  img="$(find "$root" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) -newer "$marker" 2>/dev/null | while read -r f; do
    stat -f '%m %N' "$f" 2>/dev/null
  done | sort -rn | head -1 | cut -d' ' -f2-)"
fi

rm -f "$marker"
[ -n "$img" ] && [ -f "$img" ] || {
  tail="$(printf '%s' "$out" | tail -c 600)"
  echo "gen.sh: no image produced. Output tail: $tail" >&2
  if printf '%s' "$out" | grep -q 'User location is not supported'; then
    echo "  → Google 区域限制：换代理节点/开全局 TUN 后重试（agy 只认 HTTPS_PROXY 环境变量）" >&2
  fi
  exit 1
}

# 3) 验证是真位图（防 agent 手写 SVG 交差）
kind="$(file -b "$img")"
case "$kind" in
  PNG*|JPEG*|WebP*) echo "$img" ;;
  *) die "produced file is not a bitmap (file says: $kind) — the CLI likely hand-wrote code instead of generating; retry with a stronger prohibition in the prompt" ;;
esac
