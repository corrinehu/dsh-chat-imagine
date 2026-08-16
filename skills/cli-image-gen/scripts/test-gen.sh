#!/usr/bin/env bash
# 桩测试：不花真实额度，验证 gen.sh 的参数守卫、路径解析、位图校验、agy flag 语法。
set -euo pipefail
cd "$(dirname "$0")/.."
SKILL_DIR="$(pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

# 造一个真 PNG（1x1 像素）和一个假 PNG（实为 SVG 文本）
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$TMP/real.png"
echo '<svg xmlns="http://www.w3.org/2000/svg"></svg>' > "$TMP/fake.png"

# ── 1) 参数守卫 ────────────────────────────────
out="$(bash "$SKILL_DIR/scripts/gen.sh" 2>&1)" && bad "空参数应退出非零" || ok "空参数拒绝: $out"
out="$(bash "$SKILL_DIR/scripts/gen.sh" twitter "x" 2>&1)" && bad "非法渠道应退出非零" || ok "非法渠道拒绝"
out="$(bash "$SKILL_DIR/scripts/gen.sh" codex "" 2>&1)" && bad "空 prompt 应退出非零" || ok "空 prompt 拒绝"

# ── 2) codex 桩：正常输出带路径 ─────────────────
mkdir -p "$TMP/stub-bin" "$TMP/.codex/generated_images/sess"
cp "$TMP/real.png" "$TMP/.codex/generated_images/sess/exec-1.png"
cat > "$TMP/stub-bin/codex" <<EOF
#!/usr/bin/env bash
# 记录收到的参数后模拟 codex 输出
printf '%s\n' "\$*" > "$TMP/codex-args.txt"
echo "已生成。完整保存路径："
echo "\`$TMP/.codex/generated_images/sess/exec-1.png\`"
EOF
chmod +x "$TMP/stub-bin/codex"
out="$(PATH="$TMP/stub-bin:$PATH" HOME="$TMP" bash "$SKILL_DIR/scripts/gen.sh" codex "test whale" 16:9)"
[ -f "$out" ] && file -b "$out" | grep -q PNG && ok "codex 渠道解析出真 PNG: $out" || bad "codex 渠道失败: $out"
grep -q "image_gen" "$TMP/codex-args.txt" && ok "codex 指令含 image_gen 点名" || bad "codex 指令未点名工具"
grep -q "16:9" "$TMP/codex-args.txt" && ok "尺寸提示拼进了 codex prompt" || bad "尺寸没传进 codex prompt"
grep -q 'model_reasoning_effort' "$TMP/codex-args.txt" && ok "codex low 推理 flag 在" || bad "codex 缺 low 推理 flag"

# ── 3) SVG 交差必须被拒 ────────────────────────
cat > "$TMP/stub-bin/codex" <<EOF
#!/usr/bin/env bash
echo "\`$TMP/fake.png\`"
EOF
chmod +x "$TMP/stub-bin/codex"
out="$(PATH="$TMP/stub-bin:$PATH" HOME="$TMP" bash "$SKILL_DIR/scripts/gen.sh" codex "x" 2>&1)" && bad "SVG 假 PNG 应被拒" || ok "SVG 交差被 file 校验拦截"

# ── 4) agy 桩：验证 = 语法与路径解析 ───────────
mkdir -p "$TMP/.gemini/antigravity-cli/brain/uuid1"
cp "$TMP/real.png" "$TMP/.gemini/antigravity-cli/brain/uuid1/img.png"
cat > "$TMP/stub-bin/agy" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$TMP/agy-args.txt"
echo "[img.png](file://$TMP/.gemini/antigravity-cli/brain/uuid1/img.png)"
EOF
chmod +x "$TMP/stub-bin/agy"
out="$(PATH="$TMP/stub-bin:$PATH" HOME="$TMP" bash "$SKILL_DIR/scripts/gen.sh" agy "test whale")"
[ -f "$out" ] && ok "agy 渠道解析出路径: $out" || bad "agy 渠道失败: $out"
grep -q -- "--prompt=" "$TMP/agy-args.txt" && ok "agy 使用 --prompt= 等号语法" || bad "agy 没用 = 语法"
grep -q -- "--output-format=stream-json" "$TMP/agy-args.txt" && ok "agy stream-json 在" || bad "agy 缺 stream-json"
grep -q "NOT hand-written SVG" "$TMP/agy-args.txt" && ok "agy 指令含 SVG 禁止语" || bad "agy 缺 SVG 禁止语"

# ── 5) 输出无路径时 -newer 兜底扫描 ────────────
# 桩在「执行期间」落盘（模拟真实 CLI 行为），且不打印任何路径
mkdir -p "$TMP/.gemini/antigravity-cli/brain/uuid2"
cat > "$TMP/stub-bin/agy" <<EOF
#!/usr/bin/env bash
cp "$TMP/real.png" "$TMP/.gemini/antigravity-cli/brain/uuid2/during-run.png"
echo "generation done, but I forgot the path"
EOF
chmod +x "$TMP/stub-bin/agy"
out="$(PATH="$TMP/stub-bin:$PATH" HOME="$TMP" bash "$SKILL_DIR/scripts/gen.sh" agy "x")"
[ -f "$out" ] && ok "-newer 兜底扫描生效: $out" || bad "兜底扫描失败"

echo
echo "结果: $PASS 通过, $FAIL 失败"
exit "$FAIL"
