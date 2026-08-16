---
name: cli-image-gen
description: "Generate real AI bitmap images (PNG/JPG) through locally installed, already-logged-in coding CLIs instead of API keys: codex exec (OpenAI Codex, spends ChatGPT Plus/Pro quota, built-in image_gen tool) or agy --print (Google Antigravity, spends Google account quota, built-in Gemini image tool). Use when the user asks to generate/draw/create an image (生成图片 / 画图 / 出图 / 生成一张图), when API image channels are out of quota, or when the user names codex or agy as the image source. Knows the two hard-won pitfalls: agy requires --key=value flag syntax, and both CLIs must be told to use their built-in image tool and forbidden from hand-writing SVG code."
---

# CLI Image Gen

Generate images by driving locally installed coding CLIs in headless mode. No API keys involved — each CLI spends its own account quota through its built-in image-generation tool.

| Channel | Command | Image tool | Spends | Output dir |
|---|---|---|---|---|
| codex | `codex exec` | built-in `image_gen` (hosted) | ChatGPT Plus/Pro quota | `~/.codex/generated_images/<session>/` |
| agy | `agy --print` | built-in Gemini image tool (the "Gemini Flash Image 🍌" from the Antigravity app) | Google account quota | `~/.gemini/antigravity-cli/brain/<uuid>/` |

The two channels back each other up: when one account is out of quota (or region-blocked), switch to the other.

## Quick path (recommended)

`scripts/gen.sh` wraps command construction, quoting, path extraction, time-based fallback scan, and bitmap verification:

```bash
bash <skill-dir>/scripts/gen.sh codex "a flat illustration of a blue whale mascot, sticker style"
bash <skill-dir>/scripts/gen.sh agy   "a flat illustration of a blue whale mascot, sticker style" [16:9]
```

- On success: prints the image's **absolute path** on stdout (already verified with `file` to be PNG/JPG/WebP). Show or reference that path directly.
- On failure: non-zero exit, diagnostics on stderr (login / quota / region).
- Optional third argument: size hint, folded into the prompt (`16:9` or `1024x1024`).
- Env knobs: `GEN_MODEL` (agy model, default `gemini-3.7-flash-low`), `GEN_TIMEOUT` (seconds, default 300).

## Manual path — the rules that matter

If you must build the command yourself, follow these exactly. Both were verified by hand on this machine.

### codex channel

```bash
codex exec --skip-git-repo-check -c 'model_reasoning_effort="low"' "<instruction>"
```

Instruction template (Chinese or English both work; the two non-negotiables are **naming the image tool** and **asking for the saved path**):

> 请用内置的图片生成工具（image generation / image_gen）生成一张图片：<scene description>。生成完成后，在回复里给出图片的完整绝对保存路径（~/.codex/generated_images/ 下的文件）。除此之外不要做任何其他事情。

- Size/ratio goes into the prompt text only (codex's image_gen takes no size flags), e.g. 「画面比例 16:9」.
- Find the result: parse `generated_images/…\.(png|jpe?g|webp)` from the output; if absent, `find ~/.codex/generated_images -name "*.png" -newer <marker>` where marker is a file you `touch`ed right before the call.
- Cost expectation: one run ≈ 1.5–5 minutes and ~25k tokens (agent-loop overhead included). That is normal, not a failure.

### agy channel

```bash
agy --print --output-format=stream-json --model=gemini-3.7-flash-low --dangerously-skip-permissions --prompt="<instruction>"
```

- ⚠️ **Flags must use `--key=value` syntax** (`--prompt="..."`, `--model=...`). Space-separated `--prompt "..."` gets mis-parsed: the model receives only a fragment and replies "your message got cut off" / "please provide more context".
- ⚠️ **`--dangerously-skip-permissions` is required in headless mode**: agy's inner agent cannot prompt for tool permission, so command tools get auto-denied ("a tool required the command permission that headless mode cannot prompt for") and it produces nothing. Image generation has nothing to confirm — auto-approve is safe here.
- Instruction template (English is more reliable; you must **explicitly forbid hand-written SVG or drawing code**, otherwise the agent happily codes an SVG file and calls it a day — that is not AI image generation):

> Use your built-in image generation tool (the Gemini image generation capability, NOT hand-written SVG or drawing code) to generate a PNG image: <description>. Then reply with the absolute file path of the saved PNG.

- Find the result: paths come back as markdown links `[x.png](file:///Users/.../brain/<uuid>/x.png)` — take the part after `file://`; fallback `find ~/.gemini/antigravity-cli/brain \( -name "*.png" -o -name "*.jpg" \) -newer <marker>`.
- Model names from `agy models` with `-low/-medium/-high` suffixes are reasoning tiers of one model; `-low` is enough for image generation.

## Verify before declaring success

1. `file <path>` must say `PNG image data` or `JPEG image data`. An `SVG` text file means the agent wrote drawing code instead of generating — strengthen the prohibition in the instruction and retry.
2. `Error: Agent execution terminated due to error.` from agy (and plain-text prompts fail too) → check the newest log under `~/.gemini/antigravity-cli/log/`:
   - `FAILED_PRECONDITION (400): User location is not supported` = egress region rejected by Google. Fix the proxy (switch node / enable global TUN). Note: agy is a Go binary — it honors the `HTTPS_PROXY` env var, not the macOS system proxy.
3. codex quota/login errors → confirm with `codex login status`. Plus image quota is limited; check this first when failures cluster.
4. Both channels failing with account-level errors → that is exactly the moment to switch channels (ChatGPT and Google quota pools back each other up).

## In DSH (DeepSeek Harness)

When this skill runs inside a DSH session that has the dsh-chat-imagine plugin installed:

- **Single image → prefer the `generate_image` tool first** (backend `codex` or `agy`): it wraps the same CLIs in one call. This manual path is for recovery when the tool errors (quota / region / parsing), for **batch generation** (the tool is one-image-per-call), or when the user explicitly asks to drive the CLI.
- **Finish by displaying the result in chat**: call the `show_image_file` tool with the image's absolute path, then copy the returned markdown image line `![...](...)` verbatim into the reply so it renders inline.

## Boundaries

- Bitmaps only. For vector logo/icon sources, use another path; never deliver an SVG from these CLIs as the artifact.
- One image per call. Batching = looping (each call is an independent session; watch quota and wall time).
