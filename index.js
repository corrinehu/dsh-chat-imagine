import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
// 图片模型过滤：名称含 image/imagen 的模型都列出（不预判网关是否支持——
// 不同网关对 gemini 等模型的支持不同，由用户设置默认或测试验证）。
const IMAGE_MODEL_RE = /image|imagen/i

/** 把渠道探测结果渲染成给用户看的中文报告（render 纯函数）。 */
function renderBackendReport(value) {
  const channels = Array.isArray(value?.channels) ? value.channels : []
  const defaultBackend = value?.defaultBackend || ''
  const defaultModel = value?.defaultModel || ''
  const lines = []
  if (channels.length === 0) {
    lines.push('✅ 生图渠道探测完成：本机暂未发现可用的生图渠道。')
    lines.push('提示：可安装 mmx CLI（MiniMax），或在「设置→模型」里配置一个 OpenAI 兼容渠道并包含生图模型（如 openrouter）后再试。')
  } else {
    lines.push('✅ 生图渠道探测完成，以下渠道可用：')
    for (const ch of channels) {
      const models = (ch.models ?? []).map((m) => m.id).join(' / ')
      lines.push(`- ${ch.id}（${ch.kind === 'cli' ? '本机 CLI' : 'API 网关'}）：${models}`)
    }
    lines.push('')
    lines.push(`当前默认：渠道 ${defaultBackend || '未设置'}，模型 ${defaultModel || '未设置'}`)
    lines.push('你可以：① 告诉我用哪个渠道/模型作为默认；② 先测试某个渠道或模型是否可用（个别模型可能不被网关支持），确认后再设默认。')
  }
  lines.push('')
  lines.push('结构化结果（供精确调用）：')
  lines.push(JSON.stringify({ channels, defaultBackend, defaultModel }, null, 2))
  return lines.join('\n')
}

export const name = 'dsh-chat-imagine'
export const inject = ['tools', 'webServer']

export const Config = Schema.object({
  // 回退 API 网关（可选）：仅当渠道信息在模型设置里查不到时使用；留空（默认）禁用。
  gateway: Schema.string().default(''),
  apiKey: Schema.string().default(''),
  // 默认渠道/模型：留空则每次由 agent 询问用户
  defaultBackend: Schema.string().default(''),
  defaultModel: Schema.string().default(''),
  mmxBin: Schema.string().default('mmx'),
  displayHost: Schema.string().default(''),
  routePath: Schema.string().default('/chat-imagine'),
  timeoutMs: Schema.number().default(120000),
})

export function apply(ctx, config) {
  // id -> { bytes, mime }, served by the inline-image route. In-memory only.
  const store = new Map()

  const webServer = ctx.webServer
  const displayHost = config.displayHost && config.displayHost.trim().length > 0
    ? config.displayHost.trim()
    : `http://127.0.0.1:${ctx.webServer.port}`
  const markdownFor = (id, alt) => `![${alt}](${displayHost}${config.routePath}/raw/${id})`
  // 内存上限：超出按插入序淘汰最旧的（历史消息里的旧引用会 404，属已知行为）
  const MAX_IMAGES = 200
  const MAX_TOTAL_BYTES = 128 * 1024 * 1024
  let totalBytes = 0
  const remember = (bytes, mime) => {
    const id = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    store.set(id, { bytes, mime })
    totalBytes += bytes.length
    while (store.size > MAX_IMAGES || totalBytes > MAX_TOTAL_BYTES) {
      const oldest = store.keys().next().value
      if (oldest === undefined) break
      const entry = store.get(oldest)
      store.delete(oldest)
      if (entry) totalBytes -= entry.bytes.length
    }
    return id
  }

  // ── 默认渠道/模型「账本」：settings 命名空间（热生效，跨会话持久）──
  // 优先级：settings 账本 > cordis.yml 配置（config.defaultBackend/defaultModel）
  const LEDGER_NS = 'dsh-chat-imagine'
  let ledgerRegistered = false
  function ensureLedger() {
    const settings = ctx.get('settings')
    if (!settings) return null
    if (!ledgerRegistered) {
      try {
        settings.register(LEDGER_NS, Schema.object({
          defaultBackend: Schema.string().default(''),
          defaultModel: Schema.string().default(''),
        }))
      } catch {
        // 已注册或不可用：忽略，仍尝试 get/update
      }
      ledgerRegistered = true
    }
    return settings
  }
  function currentLedger() {
    const settings = ensureLedger()
    if (!settings) return { defaultBackend: '', defaultModel: '' }
    try {
      const v = settings.get(LEDGER_NS)
      return {
        defaultBackend: typeof v?.defaultBackend === 'string' ? v.defaultBackend : '',
        defaultModel: typeof v?.defaultModel === 'string' ? v.defaultModel : '',
      }
    } catch {
      return { defaultBackend: '', defaultModel: '' }
    }
  }
  async function writeLedger(patch) {
    const settings = ensureLedger()
    if (!settings) return false
    try {
      await settings.update(LEDGER_NS, patch)
      return true
    } catch {
      return false
    }
  }
  function effectiveDefaults() {
    const ledger = currentLedger()
    return {
      defaultBackend: ledger.defaultBackend || config.defaultBackend,
      defaultModel: ledger.defaultModel || config.defaultModel,
    }
  }

  webServer.register({
    kind: 'prefix',
    path: config.routePath,
    handler: async (req, res) => {
      try {
        const addr = req.socket?.remoteAddress
        if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
          res.writeHead(403, { 'content-type': 'text/plain' })
          res.end('loopback only')
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
        const entry = store.get(id)
        if (!entry) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found')
          return
        }
        res.writeHead(200, {
          'content-type': entry.mime,
          'content-length': entry.bytes.length,
          'cache-control': 'no-cache',
        })
        res.end(entry.bytes)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error))
      }
    },
  })

  // 服务在调用时惰性获取（apply 阶段 tools/webServer 先就绪，
  // shell/settings/credentials 可能稍后才提供，不能一次性捕获）。
  async function probeMmx(debug) {
    const shell = ctx.get('shell')
    if (!shell) {
      if (debug) debug.shell = 'unavailable'
      return null
    }
    const runCmd = async (cmd) => {
      try {
        // 真实 shell 服务要求先 resolve 成完整 spec（含沙箱策略），
        // 插件内部执行需要全权限（mmx 需要 exec + 网络 + 临时目录写）。
        let spec
        try {
          spec = shell.resolve({ command: cmd, policy: { mode: 'danger-full-access' } })
        } catch {
          spec = shell.resolve({ command: cmd })
        }
        const run = await shell.run(spec)
        return { code: run.exitCode, out: (run.stdout?.text ?? '').trim(), err: (run.stderr?.text ?? '').trim() }
      } catch (e) {
        return { code: -1, out: '', err: String(e) }
      }
    }
    // 候选：裸命令名 + 常见安装位置（shell 环境 PATH/HOME 可能不全，用 os.homedir()）
    const home = homedir()
    const candidates = [
      config.mmxBin,
      home ? `${home}/.local/bin/${config.mmxBin}` : '',
      `/opt/homebrew/bin/${config.mmxBin}`,
      `/usr/local/bin/${config.mmxBin}`,
    ].filter(Boolean)
    if (debug) debug.candidates = candidates
    for (const c of candidates) {
      const r = await runCmd(`test -x ${JSON.stringify(c)} && echo FOUND || echo NO`)
      if (r.code === 0 && r.out.includes('FOUND')) {
        if (debug) debug.found = c
        return {
          id: 'mmx',
          kind: 'cli',
          name: 'mmx CLI (MiniMax)',
          bin: c,
          models: [{ id: 'image-01', name: 'MiniMax image-01' }],
        }
      }
    }
    // 兜底：command -v
    const r = await runCmd(`command -v ${config.mmxBin}`)
    if (debug) debug.commandV = r
    if (r.code === 0 && r.out) {
      return {
        id: 'mmx',
        kind: 'cli',
        name: 'mmx CLI (MiniMax)',
        bin: r.out,
        models: [{ id: 'image-01', name: 'MiniMax image-01' }],
      }
    }
    return null
  }

  // 进程内缓存 mmx 探测结果：生成路径不必每次都找二进制
  let mmxCache
  async function mmxChannel() {
    if (mmxCache === undefined) mmxCache = await probeMmx(null)
    return mmxCache
  }

  async function probeApiChannels() {
    const settings = ctx.get('settings')
    const credentials = ctx.get('credentials')
    if (!settings || !credentials) return []
    let providers
    try {
      providers = settings.get('llm-pi-ai')?.providers
    } catch {
      return []
    }
    if (!providers || typeof providers !== 'object') return []
    const out = []
    for (const [id, p] of Object.entries(providers)) {
      if (!p || typeof p !== 'object') continue
      const baseURL = typeof p.baseURL === 'string' ? p.baseURL : ''
      if (!baseURL) continue
      const keyRef = typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : ''
      let key = ''
      if (keyRef) {
        const cred = await credentials.resolve(keyRef).catch(() => undefined)
        if (cred) key = cred.value
      }
      let models = []
      try {
        const resp = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          // 探测要快：单渠道最多等 10s，避免一个不可达渠道拖慢整个清单
          signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10000)),
        })
        if (resp.ok) {
          const data = await resp.json().catch(() => null)
          const list = data?.data ?? []
          models = list
            .filter((m) => typeof m?.id === 'string' && IMAGE_MODEL_RE.test(m.id))
            .map((m) => ({ id: m.id }))
        }
      } catch {
        // 探测失败视为该渠道不可达，跳过
      }
      if (models.length > 0) {
        out.push({ id, kind: 'api', name: id, baseURL, models })
      }
    }
    return out
  }

  async function listBackends() {
    const debug = {}
    const mmx = await probeMmx(debug)
    const apis = await probeApiChannels()
    return { channels: [mmx, ...apis].filter(Boolean), debug }
  }

  // ── 工具：列出可用生图渠道 ───────────────────────────────
  ctx.tools.register(defineTool({
    name: 'list_image_backends',
    description: 'Probe and list the image-generation channels available on this machine: local CLIs (e.g. mmx) and OpenAI-compatible API gateways configured under Model settings (e.g. openrouter). Call this before generating when the user asks which channels/models are available, or when generate_image needs an explicit backend. Relay the rendered report to the user and ask which channel/model to use or to test.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          channels: { type: 'array' },
          defaultBackend: { type: 'string' },
        },
      },
      render: (_a, value) => [{ type: 'text', text: renderBackendReport(value) }],
    },
    async execute() {
      const { channels, debug } = await listBackends()
      const def = effectiveDefaults()
      return { channels, defaultBackend: def.defaultBackend, defaultModel: def.defaultModel, debug }
    },
  }))

  // ── 工具：生图（支持显式 backend/model）──────────────────
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate an image through a chosen channel and return a markdown image reference for inline display in the chat. The returned value contains a markdown image reference ![alt](url) — you MUST include that markdown line VERBATIM in your reply text so the image renders inline; do not paste a bare link, do not call other tools to "display" it, and do not regenerate. Available channels come from list_image_backends (e.g. "mmx", "openrouter"). HARD GATE: if no default channel has been configured yet, this tool REFUSES to generate and returns a guidance report instead — even if you pass backend explicitly. In that case you MUST relay the channel list to the user and let THEM pick the default (never choose one yourself), persist their choice with set_image_default, then retry. The gate fires only until a default exists.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image description / prompt (English usually works best).' },
      backend: { type: 'string', description: 'Optional channel id, e.g. "mmx" or "openrouter". Pass it whenever the user names a specific channel — it overrides the configured default. Omit to use the default.' },
      model: { type: 'string', description: 'Optional model id for the backend, e.g. "image-01" (mmx) or "gpt-image-2" (openrouter). Omit to use the channel default. Note: the configured default model only applies to the configured default channel.' },
      size: { type: 'string', description: 'Optional image size, e.g. 1024x1024 (api) or 16:9 (mmx). Omit to use each backend\'s own default.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) throw new Error('generate_image: prompt is required')

      const def = effectiveDefaults()
      const backend = String(args.backend ?? '').trim() || def.defaultBackend
      // 默认模型只在「也用默认渠道」时套用：显式换渠道时不把默认渠道的模型名带过去
      const model = String(args.model ?? '').trim()
        || (backend === def.defaultBackend ? def.defaultModel : '')

      // 做法 A（强化版）：未设置默认渠道时一律拒绝生成——即使本次带了显式 backend。
      // 唯一放行方式：用户选择 → set_image_default 落账 → 重试。模型不得代用户挑渠道。
      if (!def.defaultBackend) {
        const { channels } = await listBackends()
        // 空清单是死胡同：没有可选的默认，引导话术必须换成「如何配置渠道」，
        // 否则模型会在「询问用户选默认 ↔ 无可选」之间空转。
        if (channels.length === 0) {
          return `（❌ 本机未探测到任何可用的生图渠道，本次未生成图片。\n请把下面两种解决方式告诉用户（二选一），等用户配置完成后再重新探测确认：\n① 安装 mmx CLI（MiniMax）——装好后本插件会自动发现它；\n② 在 DSH「设置→模型」里添加一个 OpenAI 兼容渠道，并确保其模型列表里有生图模型（模型名含 image/imagen，例如 openrouter 上的 gpt-image / gemini 系列）。\n注意：现在调用 set_image_default 一定会失败（没有可选渠道），也不要原地重试 generate_image；等用户说配置好了，先调 list_image_backends 确认非空，再走询问默认的流程。）`
        }
        const report = renderBackendReport({ channels, defaultBackend: '', defaultModel: '' })
        const explicit = String(args.backend ?? '').trim()
        const hint = explicit
          ? `本次调用指定了渠道 "${explicit}"：若这是用户在消息里明确点名的选择，请直接调用 set_image_default(backend: "${explicit}") 把它落为默认后重试；若是你自己挑的，必须先问用户，不得代选。`
          : '请把上面的渠道清单展示给用户，询问用哪个渠道/模型作为默认（或先测试某个渠道）。'
        return `${report}\n\n（❌ 尚未设置默认生图渠道，本次未生成图片——这是强制流程，不能跳过。\n${hint}\n步骤：① 向用户转述渠道清单并询问，或确认用户已点名的选择；② 调用 set_image_default 写入用户的选择；③ 重新调用 generate_image。不要自行挑选渠道，不要省略询问步骤直接生成。）`
      }

      // ── 渠道解析（不再全量探测）────────────────────────
      // API 渠道直接现读模型设置；mmx CLI 用进程内缓存的探测结果。
      const settings = ctx.get('settings')
      const credentials = ctx.get('credentials')
      let section = null
      try {
        const s = settings?.get('llm-pi-ai')?.providers?.[backend]
        if (s && typeof s === 'object') section = s
      } catch {
        // 渠道信息读取失败：走可选的回退网关
      }

      // ── CLI 渠道（mmx）──────────────────────────────────
      if (!section && backend === 'mmx') {
        const channel = await mmxChannel()
        if (!channel) {
          throw new Error('generate_image: mmx CLI not found on this machine. Run list_image_backends to see available channels.')
        }
        const shell = ctx.get('shell')
        if (!shell) throw new Error('generate_image: shell service unavailable for the CLI backend')
        const dir = join(tmpdir(), `dsh-chat-imagine-${Date.now()}`)
        await mkdir(dir, { recursive: true })
        const bin = channel.bin || config.mmxBin
        // size -> mmx flags：比例（16:9）走 --aspect-ratio；像素（1024x1024）走 --width/--height
        // （mmx 要求 512–2048 且为 8 的倍数，不满足则忽略，用 CLI 默认值）
        const sizeRaw = String(args.size ?? '').trim()
        let sizeFlags = ''
        if (/^\d+:\d+$/.test(sizeRaw)) {
          sizeFlags = ` --aspect-ratio ${JSON.stringify(sizeRaw)}`
        } else {
          const m = /^(\d+)x(\d+)$/.exec(sizeRaw)
          const w = m ? Number(m[1]) : 0
          const h = m ? Number(m[2]) : 0
          if (w >= 512 && w <= 2048 && h >= 512 && h <= 2048 && w % 8 === 0 && h % 8 === 0) {
            sizeFlags = ` --width ${w} --height ${h}`
          }
        }
        const cmd = `${bin} image generate --prompt ${JSON.stringify(prompt)}${sizeFlags} --out-dir ${JSON.stringify(dir)} --non-interactive --quiet`
        let spec
        try {
          spec = shell.resolve({ command: cmd, timeoutMs: config.timeoutMs, policy: { mode: 'danger-full-access' } })
        } catch {
          spec = shell.resolve({ command: cmd, timeoutMs: config.timeoutMs })
        }
        const run = await shell.run(spec)
        if (run.exitCode !== 0) {
          throw new Error(`generate_image: mmx failed (exit ${run.exitCode}): ${(run.stderr?.text ?? '').slice(-500) || (run.stdout?.text ?? '').slice(-500)}`)
        }
        const files = await readdir(dir)
        const file = files.find((f) => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
        if (!file) throw new Error(`generate_image: mmx produced no image file. Output: ${(run.stdout?.text ?? '').slice(-500)}`)
        const abs = join(dir, file)
        const dot = abs.lastIndexOf('.')
        const ext = (dot >= 0 ? abs.slice(dot) : '').toLowerCase()
        const bytes = await readFile(abs)
        const id = remember(bytes, MIME_BY_EXT[ext] ?? 'image/jpeg')
        return `${markdownFor(id, '生成的图片')}\n\n（渠道 ${backend}，模型 ${model || file}。⚠️ 展示方式：必须把上面这行 markdown 图片引用【原样复制进你的回复文本】（保持 ![...](...) 格式，不要改成纯链接、不要另调 show_image_file/read_image、不要重新生成），图片才会内联显示在聊天中。）`
      }

      // ── API 渠道 ────────────────────────────────────────
      let baseURL = ''
      let key = ''
      if (section) {
        if (typeof section.baseURL === 'string' && section.baseURL) baseURL = section.baseURL
        if (typeof section.apiKeyEnv === 'string' && section.apiKeyEnv) {
          const cred = await credentials?.resolve(section.apiKeyEnv).catch(() => undefined)
          if (cred) key = cred.value
        }
      }
      if (!baseURL && config.gateway) {
        baseURL = config.gateway
        if (!key) key = config.apiKey
      }
      if (!baseURL) {
        // 此时才全量探测一次，只为在报错里给出可用渠道列表帮用户纠错
        const { channels } = await listBackends().catch(() => ({ channels: [] }))
        throw new Error(`generate_image: backend "${backend}" not found in Model settings${config.gateway ? '' : ' and no fallback gateway is configured (see the optional gateway/apiKey config keys)'}. Available: ${channels.map((b) => b.id).join(', ') || 'none'}`)
      }
      let modelId = model
      if (!modelId) {
        // 未指定模型：单渠道拉一次模型列表，取第一个生图模型
        try {
          const resp = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10000)),
          })
          const data = resp.ok ? await resp.json().catch(() => null) : null
          modelId = (data?.data ?? []).find((m) => typeof m?.id === 'string' && IMAGE_MODEL_RE.test(m.id))?.id ?? ''
        } catch {
          // 模型列表拉不到：继续生成请求，让网关自己报模型错误（更具体）
        }
      }
      if (!modelId) throw new Error('generate_image: no model specified and no image model is known for this channel; pass model explicitly (see list_image_backends).')
      const endpoint = `${baseURL.replace(/\/+$/, '')}/images/generations`
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        // size 未指定时省略字段，让网关用自家默认（各家支持的尺寸集不同）
        body: JSON.stringify({ model: modelId, prompt, n: 1, ...(args.size ? { size: String(args.size) } : {}) }),
        signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.error) {
        throw new Error(`generate_image: gateway error ${response.status}: ${JSON.stringify(payload?.error ?? payload)}`)
      }
      const item = payload.data?.[0]
      let bytes = null
      let mime = 'image/png'
      if (typeof item?.b64_json === 'string' && item.b64_json) {
        bytes = Buffer.from(item.b64_json, 'base64')
      } else if (typeof item?.url === 'string' && item.url) {
        // 部分网关返回 URL 而非 base64：下载后再内联
        const img = await fetch(item.url, { signal: AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)]) })
        if (!img.ok) throw new Error(`generate_image: failed to download image from gateway url (${img.status})`)
        const ct = img.headers.get('content-type')?.split(';')[0] ?? ''
        if (/^image\//.test(ct)) mime = ct
        bytes = Buffer.from(await img.arrayBuffer())
      }
      if (!bytes) throw new Error('generate_image: gateway response has neither b64_json nor url')
      const id = remember(bytes, mime)
      return `${markdownFor(id, '生成的图片')}\n\n（渠道 ${backend}，模型 ${modelId}。⚠️ 展示方式：必须把上面这行 markdown 图片引用【原样复制进你的回复文本】（保持 ![...](...) 格式，不要改成纯链接、不要另调 show_image_file/read_image、不要重新生成），图片才会内联显示在聊天中。）`
    },
  }))

  // ── 工具：内联展示磁盘图片 ─────────────────────────────
  ctx.tools.register(defineTool({
    name: 'show_image_file',
    description: 'Read a local image file (.png/.jpg/.jpeg/.webp/.gif) and return a markdown image reference for inline display in the chat. The returned value contains a markdown image reference ![alt](url) — you MUST include that markdown line VERBATIM in your reply text so the image renders inline; do not paste a bare link. Use when the user asks to show/display/preview an image file that already exists on disk (for example an image generated by an external CLI such as mmx).',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to the image file on disk.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const path = String(args.path ?? '').trim()
      if (!path) throw new Error('show_image_file: path is required')
      const dot = path.lastIndexOf('.')
      const ext = (dot >= 0 ? path.slice(dot) : '').toLowerCase()
      const mime = MIME_BY_EXT[ext]
      if (!mime) throw new Error(`show_image_file: unsupported image type "${ext}"; supported: ${Object.keys(MIME_BY_EXT).join(', ')}`)
      const bytes = await readFile(path, { signal: exec.signal })
      const id = remember(bytes, mime)
      return `${markdownFor(id, '图片')}\n\n（⚠️ 展示方式：必须把上面这行 markdown 图片引用【原样复制进你的回复文本】（保持 ![...](...) 格式，不要改成纯链接），图片才会内联显示在聊天中。）`
    },
  }))

  // ── 工具：设置默认生图渠道/模型（写入 settings 账本，热生效）──
  ctx.tools.register(defineTool({
    name: 'set_image_default',
    description: 'Set the default image-generation channel and model. The choice is persisted (survives restarts) and used by generate_image whenever backend/model are omitted. REQUIRED before the first generate_image call: generate_image refuses to generate until a default exists. Always call it with the channel the USER picked (from list_image_backends or from their own words), never your own preference; also use it to change the default later.',
    parameters: {
      backend: { type: 'string', required: true, description: 'Channel id to use as default, e.g. "mmx" or "openrouter".' },
      model: { type: 'string', description: 'Optional model id to pin as default, e.g. "image-01" or "gpt-image-2". Omit to clear the pinned model (channel default applies).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const backend = String(args.backend ?? '').trim()
      if (!backend) throw new Error('set_image_default: backend is required')
      const model = String(args.model ?? '').trim()
      const { channels } = await listBackends()
      const channel = channels.find((b) => b.id === backend)
      if (!channel) {
        if (channels.length === 0) {
          throw new Error('set_image_default: no image channel exists on this machine yet — install the mmx CLI or configure an image model in Model settings first, then run list_image_backends to confirm.')
        }
        throw new Error(`set_image_default: backend "${backend}" is not available. Available: ${channels.map((b) => b.id).join(', ')}`)
      }
      const ok = await writeLedger({ defaultBackend: backend, defaultModel: model })
      if (!ok) {
        throw new Error('set_image_default: could not persist the default (settings service unavailable). Edit cordis.yml config defaultBackend/defaultModel instead.')
      }
      const def = effectiveDefaults()
      return `✅ 默认生图设置已保存：渠道 ${def.defaultBackend}${def.defaultModel ? `，模型 ${def.defaultModel}` : '（模型不固定，用渠道默认）'}。\n以后直接说"生成一张图"就会用这个默认设置；想修改随时再调用本工具。`
    },
  }))
}
