# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`dsh-chat-imagine` — a single-file [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that adds chat-inline image generation: it probes available backends (local `mmx` CLI from MiniMax, plus OpenAI-compatible API providers configured in DSH Model settings), generates images, and serves them for inline markdown display in the chat.

## Repo layout

- `index.js` — the entire plugin (ESM, plain JavaScript, ~530 lines). No build step, no TypeScript, no bundler. Do not add any.
- `cordis.patch.yml` — bundle layer that registers the plugin into the harness composition when installed via `dsh plugin add`.
- `README.md` (中文) / `README.en.md` (English) — user docs; keep both in sync when behavior changes. They embed screenshots from `assets/`.
- `package.json` — `files` controls what npm publishes (`index.js`, patch yml, assets, both READMEs). Peer deps (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`) are provided by the DSH host at runtime; `node_modules` exists only for local editor/link support and is gitignored.

## Commands

There is no build/test/lint pipeline. To validate changes:

```sh
node --check index.js            # syntax check
dsh plugin --profile web add /abs/path/to/this/repo   # install locally into DSH for a real test
```

Real verification means installing the plugin and exercising the tools in a fresh DSH conversation (list backends → set default → generate). Publishing is `npm publish` from a clean checkout; bump `version` in `package.json` first. Commit style: conventional commits (`feat:`, `docs:`, …).

## Architecture (all in index.js)

Plugin shape: `export const name`, `export const inject = ['tools', 'webServer']` (hard deps), `export const Config` (schemastery), `export function apply(ctx, config)`.

Registers 4 tools via `ctx.tools.register(defineTool(...))`:

1. `list_image_backends` — probes all channels; render function is a pure `renderBackendReport()`.
2. `generate_image` — the core. **HARD GATE**: refuses to generate (returns a guidance report instead) until a default backend exists, even when `backend` is passed explicitly. Only exception flow: user names a channel → `set_image_default` persists it → retry. The agent must never pick a channel on the user's behalf; empty channel lists get the "how to configure" guidance instead of a dead-end question loop.
3. `show_image_file` — serves an on-disk image inline.
4. `set_image_default` — persists default backend/model.

Services: `tools`/`webServer` are injected; `shell`, `settings`, `credentials` are fetched lazily via `ctx.get(...)` at call time (they may not exist yet during `apply`) — keep that pattern.

Key mechanisms:

- **Default "ledger"**: settings-service namespace `dsh-chat-imagine` (`defaultBackend`/`defaultModel`), hot-reloadable and persistent. Priority: ledger > cordis.yml `Config` fields. The pinned default model only applies while the default backend is also used; an explicit `backend=` arg does not inherit the default model.
- **Image store**: in-memory `Map` with insertion-order eviction at 200 images / 128 MB total. Served by a `kind: 'prefix'` web route (default `/chat-imagine`), loopback-only (403 otherwise). Links die on restart by design — documented limitation, don't "fix" silently.
- **Output contract**: `generate_image`/`show_image_file` return a markdown image line plus a Chinese instruction telling the model to copy it verbatim into its reply. Preserve that contract.
- **mmx CLI path**: binary probed via shell (`config.mmxBin` + common install dirs, then `command -v`), result cached process-wide. Shell specs resolved with `policy: { mode: 'danger-full-access' }` first, plain resolve as fallback. Size mapping: `W:H` ratio → `--aspect-ratio`; pixel `WxH` → `--width/--height` only when 512–2048 and multiples of 8, else ignored. Output file picked from a temp dir by image extension.
- **API path**: providers read from settings namespace `llm-pi-ai` (`baseURL`, `apiKeyEnv` resolved through the credentials service). Models filtered by `IMAGE_MODEL_RE = /image|imagen/i` — list broadly, gateways vary. POST `${baseURL}/images/generations`; response handled as `b64_json` or downloaded `url`. Probes time out fast (≤10s); generation uses `config.timeoutMs`. Optional fallback gateway comes from `Config.gateway`/`apiKey` and is off by default.

## Conventions

- Plain JS ESM only; comments in the file are Chinese — keep new ones consistent.
- User-facing tool guidance text (tool descriptions, gate reports, success messages) is intentionally directive about agent behavior; edit with care, it steers the model.
- Don't introduce a lockfile, TS config, or packaging tooling; the single-file shape is deliberate.
