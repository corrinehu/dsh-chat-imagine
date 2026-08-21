import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  VISION_SCHEMA,
  VISION_EXT_OK,
  strictSchema,
  visionPrompt,
  VISION_JSON_TEMPLATE,
  assembleVisionResult,
  renderVisionEvidence,
  visionOutputSchema,
} from './vision.js'

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

// pi-ai 内置 provider catalog 的默认 baseURL（常用渠道静态兜底表）。
// DSH 模型设置里 provider 可以不填 baseURL：llm-pi-ai 适配器会回退到
// pi-ai 内置 catalog 的默认地址（spec.baseURL ?? catalog.baseUrl），
// 所以「没填 baseURL」的 provider 在 DSH 里照常能聊天。本插件必须对齐
// 这一行为，否则会整家跳过这类 provider，其生图模型永远发现不了。
const STATIC_CATALOG_BASE = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.ai/v1',
  moonshotai: 'https://api.moonshot.ai/v1',
  'moonshotai-cn': 'https://api.moonshot.cn/v1',
}
// 动态 import pi-ai（dsh-llm-pi-ai 的依赖，宿主一定装有）：拿全量 catalog，
// 失败（组合里没有 / 安装布局不同）则退回上面的静态表。结果进程内缓存。
let catalogBaseCache
async function catalogBaseUrls() {
  if (catalogBaseCache) return catalogBaseCache
  const map = { ...STATIC_CATALOG_BASE }
  try {
    const mod = await import('@earendil-works/pi-ai/providers/all')
    for (const p of mod.builtinProviders?.() ?? []) {
      if (p?.id && typeof p.baseUrl === 'string' && p.baseUrl) map[p.id] = p.baseUrl
    }
  } catch {
    // 不可解析：静态表兜底
  }
  catalogBaseCache = map
  return map
}

/** 把渠道探测结果渲染成给用户看的中文报告（render 纯函数）。 */
function renderBackendReport(value) {
  const channels = Array.isArray(value?.channels) ? value.channels : []
  const defaultBackend = value?.defaultBackend || ''
  const defaultModel = value?.defaultModel || ''
  const lines = []
  if (channels.length === 0) {
    lines.push('✅ 生图渠道探测完成：本机暂未发现可用的生图渠道。')
    lines.push('提示：可安装 mmx CLI（MiniMax）或 codex CLI（OpenAI Codex，需已登录 ChatGPT 账号），或在「设置→模型」里配置一个 OpenAI 兼容渠道并包含生图模型（如 openrouter）后再试。')
  } else {
    lines.push('✅ 生图渠道探测完成，以下渠道可用：')
    for (const ch of channels) {
      const models = (ch.models ?? []).map((m) => m.id).join(' / ')
      const label = ch.kind === 'cli' ? `本机 CLI${ch.note ? `·${ch.note}` : ''}` : 'API 网关'
      lines.push(`- ${ch.id}（${label}）：${models}`)
    }
    lines.push('')
    lines.push(`当前默认：渠道 ${defaultBackend || '未设置'}，模型 ${defaultModel || '未设置'}`)
    lines.push('你可以：① 告诉我用哪个渠道/模型作为默认；② 先测试某个渠道或模型是否可用（个别模型可能不被网关支持），确认后再设默认。')
    if (channels.some((ch) => ch.kind === 'cli' && ch.id !== 'mmx')) {
      lines.push('说明：codex / agy 是「CLI 套壳」渠道——把提示词交给本机已登录的 codex（ChatGPT 账号）或 agy（Google 账号）CLI，用其内置生图工具出图，消耗对应账号额度而非 API key。对调用方完全透明：prompt 照常写画面描述即可，不需要任何命令行知识，插件内部会负责调用与取回图片。API 渠道没额度时它们是现成的备用。')
    }
    lines.push('')
    const visionChannels = channels.filter((ch) => ch.kind === 'cli').map((ch) => ch.id)
    if (visionChannels.length > 0) {
      lines.push(`识图（analyze_image）：本机 CLI 渠道 ${visionChannels.join(' / ')} 均可读取图片并返回结构化 JSON 证据（OCR / 版面 / 语义），任何模型可直接调用，无需切换视觉模型。`)
    }
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
  codexBin: Schema.string().default('codex'),
  agyBin: Schema.string().default('agy'),
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
    // 单图上限：超过总预算就直接拒绝而非「存了又立刻被淘汰」（否则返回的
    // id 立即失效 → 静默 404）。调用方会看到明确的错误而不是死链接。
    if (bytes.length > MAX_TOTAL_BYTES) {
      throw new Error(`generate_image: image is ${bytes.length} bytes, exceeding the per-image cap of ${MAX_TOTAL_BYTES}`)
    }
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

  // 递归删除临时目录（try/finally 里清理 CLI 落盘产物，防 /tmp 无限增长）。
  // 幂等：目录不存在也静默成功。
  async function cleanupDir(dir) {
    if (!dir) return
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不阻断主流程（尽力而为）
    }
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
          // 识图默认渠道（可选）：留空则按探测顺序自动选（mmx 最快优先）
          visionBackend: Schema.string().default(''),
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
    if (!settings) return { defaultBackend: '', defaultModel: '', visionBackend: '' }
    try {
      const v = settings.get(LEDGER_NS)
      return {
        defaultBackend: typeof v?.defaultBackend === 'string' ? v.defaultBackend : '',
        defaultModel: typeof v?.defaultModel === 'string' ? v.defaultModel : '',
        visionBackend: typeof v?.visionBackend === 'string' ? v.visionBackend : '',
      }
    } catch {
      return { defaultBackend: '', defaultModel: '', visionBackend: '' }
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
  // 共享 shell 封装：resolve 成完整 spec（先试全权限，失败退回默认策略）后执行，
  // 返回 { code, out, err }；探测与 CLI 渠道生成共用。
  // ⚠️ 沙箱请求的 key 是 sandboxPolicy（不是 policy）：shell 服务的 resolve 只读
  // request.sandboxPolicy，传错 key 会被静默忽略并回退到部署级默认沙箱（受限
  // seatbelt）——codex/agy 的进程初始化（symlink/IPC socket）会因此 EPERM。
  async function shellOnce(shell, cmd, timeoutMs, signal) {
    try {
      let spec
      const base = { command: cmd, ...(timeoutMs ? { timeoutMs } : {}), ...(signal ? { signal } : {}) }
      try {
        spec = shell.resolve({ ...base, sandboxPolicy: { mode: 'danger-full-access' } })
      } catch {
        spec = shell.resolve(base)
      }
      const run = await shell.run(spec)
      return { code: run.exitCode, out: (run.stdout?.text ?? '').trim(), err: (run.stderr?.text ?? '').trim() }
    } catch (e) {
      return { code: -1, out: '', err: String(e) }
    }
  }

  // ── CLI 二进制探测（mmx/codex/agy 共用）────────────────────
  // DSH host 进程的 PATH 往往比用户交互终端精简（GUI/systemd/非登录 shell
  // 启动），Linux 上 npm -g 装到 nvm（~/.nvm/versions/node/*/bin）或用户
  // 自设 prefix（~/.npm-global）时，会出现「终端能跑但插件探测不到」。
  // 探测顺序：① 配置值与常见安装目录直查（不依赖 PATH）→ ② npm 全局
  // 前缀 → ③ 当前 PATH command -v → ④ 登录 shell 里 command -v（source
  // 用户 profile，PATH 与终端一致，覆盖 volta/asdf/pnpm 等自定义位置）。
  async function probeCliBinary(shell, binName, debug) {
    const home = homedir()
    const name = String(binName ?? '').trim() || String(binName ?? '')
    const candidates = [
      name,
      home ? `${home}/.local/bin/${name}` : '',
      home ? `${home}/.npm-global/bin/${name}` : '',
      home ? `${home}/.bun/bin/${name}` : '',
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ].filter(Boolean)
    if (debug) debug.candidates = candidates
    for (const c of candidates) {
      const r = await shellOnce(shell, `test -x ${JSON.stringify(c)} && echo FOUND || echo NO`)
      if (r.code === 0 && r.out.includes('FOUND')) {
        if (debug) debug.found = c
        return c
      }
    }
    // npm 全局前缀：npm -g 在 Linux 的落点这一步一并覆盖（nvm / 自设 prefix）
    try {
      const r = await shellOnce(shell, 'npm prefix -g 2>/dev/null')
      if (r.code === 0 && r.out) {
        const npmBin = join(r.out.trim(), 'bin', name)
        const c = await shellOnce(shell, `test -x ${JSON.stringify(npmBin)} && echo FOUND || echo NO`)
        if (c.code === 0 && c.out.includes('FOUND')) {
          if (debug) debug.found = npmBin
          return npmBin
        }
      }
    } catch {
      // npm 不可用：跳过
    }
    // 当前 PATH 的 command -v（原有兜底）
    const r = await shellOnce(shell, `command -v ${JSON.stringify(name)}`)
    if (debug) debug.commandV = r
    if (r.code === 0 && r.out) return r.out.split('\n')[0].trim()
    // 登录/交互 shell 兜底：-l 会 source profile 链（.bash_profile/.profile/
    // .zprofile），-i 会 source .bashrc/.zshrc——Linux 用户 PATH 常写在这两处。
    // 四种组合按顺序试，命中即返回。PATH 与用户终端一致，覆盖 nvm/volta/
    // asdf/pnpm 等任意自定义安装位置。各 15s 超时。
    for (const [sh, flag] of [['bash', '-lc'], ['bash', '-ic'], ['zsh', '-lc'], ['zsh', '-ic']]) {
      const lr = await shellOnce(
        shell,
        sh + ' ' + flag + ' ' + JSON.stringify('command -v ' + name) + ' 2>/dev/null',
        15000,
      )
      if (lr.code === 0 && lr.out) {
        const found = lr.out.split('\n')[0].trim()
        if (found) {
          if (debug) debug.loginShell = { shell: sh + ' ' + flag, found }
          return found
        }
      }
    }
    return null
  }

  async function probeMmx(debug) {
    const shell = ctx.get('shell')
    if (!shell) {
      if (debug) debug.shell = 'unavailable'
      return null
    }
    const bin = await probeCliBinary(shell, config.mmxBin, debug)
    if (!bin) return null
    return {
      id: 'mmx',
      kind: 'cli',
      name: 'mmx CLI (MiniMax)',
      bin,
      note: '走 MiniMax 账号',
      models: [{ id: 'image-01', name: 'MiniMax image-01' }],
    }
  }

  // 进程内缓存 mmx 探测结果：生成路径不必每次都找二进制
  let mmxCache
  async function mmxChannel() {
    if (mmxCache === undefined) mmxCache = await probeMmx(null)
    return mmxCache
  }

  // ── codex CLI 渠道（与 mmx 同类的本机 CLI 渠道）──────────
  // codex 内置的 image_gen 是 hosted 工具：跑在 codex 自己的 agent 循环里，
  // 消耗用户 ChatGPT 账号（Plus/Pro）的额度，而非 API key。探测只看二进制
  // 是否存在；登录态/额度是否可用在生成时才暴露（与 mmx 的行为一致）。
  async function probeCodex(debug) {
    const shell = ctx.get('shell')
    if (!shell) {
      if (debug) debug.shell = 'unavailable'
      return null
    }
    const bin = await probeCliBinary(shell, config.codexBin, debug)
    if (!bin) return null
    return {
      id: 'codex',
      kind: 'cli',
      name: 'codex CLI (ChatGPT)',
      bin,
      note: '走 ChatGPT 账号额度',
      models: [{ id: 'image-gen', name: 'codex 内置 image_gen' }],
    }
  }

  // 进程内缓存 codex 探测结果
  let codexCache
  async function codexChannel() {
    if (codexCache === undefined) codexCache = await probeCodex(null)
    return codexCache
  }

  // ── agy CLI 渠道（Google Antigravity，第三个本机 CLI 渠道）──────────
  // agy 的图像生成是其 agent 循环里的内置 Gemini 图像工具（App 里的
  // "Gemini 3.1 Flash Image"），消耗 Google 账号额度。探测只看二进制；
  // 登录态/额度在生成时才暴露（与 mmx/codex 的行为一致）。
  async function probeAgy(debug) {
    const shell = ctx.get('shell')
    if (!shell) {
      if (debug) debug.shell = 'unavailable'
      return null
    }
    const bin = await probeCliBinary(shell, config.agyBin, debug)
    if (!bin) return null
    return {
      id: 'agy',
      kind: 'cli',
      name: 'agy CLI (Google Antigravity)',
      bin,
      note: '走 Google 账号额度',
      models: [
        { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low) · 默认' },
        { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
        { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
      ],
    }
  }

  // 进程内缓存 agy 探测结果
  let agyCache
  async function agyChannel() {
    if (agyCache === undefined) agyCache = await probeAgy(null)
    return agyCache
  }

  // 递归扫描 root 下的位图文件（png/jpg/webp），收集 mtime 晚于 startMs 的，
  // 返回 [{ path, mtime }]（CLI 回复里解析不到路径时的兜底；对 SVG 不感兴趣——
  // CLI 的 agent 有时会手写 SVG 交差，那不是 AI 生图）。
  async function scanImagesSince(root, startMs) {
    const out = []
    const walk = async (dir) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)) {
          try {
            const st = await stat(p)
            // CLI 落盘与本地 stat 之间可能有时钟偏移：放宽 2 秒
            if (st.mtimeMs >= startMs - 2000) out.push({ path: p, mtime: st.mtimeMs })
          } catch {
            // 单个文件 stat 失败：跳过
          }
        }
      }
    }
    await walk(root)
    return out
  }

  // API 渠道探测缓存：probeApiChannels 会对每个 provider 顺序 fetch /models
  // （单个上限 10s），listBackends 在 set_image_default / generate_image 无默认
  // gate 路径高频触发。CLI 探测已有进程级缓存，这里给慢的 API 探测加短 TTL。
  const API_PROBE_TTL = 30_000
  let apiProbeCache = { at: 0, value: null }
  async function probeApiChannels() {
    const now = Date.now()
    if (apiProbeCache.value && now - apiProbeCache.at < API_PROBE_TTL) {
      return apiProbeCache.value
    }
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
    // catalog 回退要在读 settings 之后：openrouter 等内置 provider 常不填 baseURL
    const catalog = await catalogBaseUrls()
    const out = []
    for (const [id, p] of Object.entries(providers)) {
      if (!p || typeof p !== 'object') continue
      // 有效 baseURL：profile 显式值 > pi-ai 内置 catalog 默认值（对齐 llm-pi-ai 的解析）
      const baseURL = (typeof p.baseURL === 'string' ? p.baseURL.trim() : '') || catalog[id] || ''
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
    apiProbeCache = { at: Date.now(), value: out }
    return out
  }

  async function listBackends() {
    const debug = {}
    const mmx = await probeMmx(debug)
    const codex = await codexChannel()
    const agy = await agyChannel()
    const apis = await probeApiChannels()
    return { channels: [mmx, codex, agy, ...apis].filter(Boolean), debug }
  }

  // ── 随插件注册的技能：codex/agy 手动生图操作手册 ──────────
  // 本体是 skills/cli-image-gen/SKILL.md（与独立安装到 codex 等宿主的同一份）。
  // 与 modlens 的「拷贝安装 skill」不同，这里用 ctx.skills.register() 程序化
  // 注册：随插件分发、升级自动更新、停用自动摘除，不存在 stale copy。
  // 仅在探测到 codex 或 agy CLI 时注册（没装的机器上完全不出现）。
  // skills 服务是可选增强（工具路径不依赖它），拿不到就静默跳过。
  const SKILL_NAME = 'cli-image-gen'
  let skillRegistered = false
  async function registerCliSkill() {
    if (skillRegistered) return
    const [codex, agy] = await Promise.all([codexChannel(), agyChannel()])
    if (!codex && !agy) return
    const skills = ctx.get('skills')
    if (!skills || typeof skills.register !== 'function') return
    try {
      const skillDir = join(dirname(fileURLToPath(import.meta.url)), 'skills', 'cli-image-gen')
      const raw = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
      // 剥掉 YAML frontmatter 取正文；把 <skill-dir> 占位符重写为真实绝对路径，
      // 让正文里的 gen.sh 调用在本会话直接可执行
      const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s+/, '').replaceAll('<skill-dir>', skillDir)
      const dispose = skills.register({
        name: SKILL_NAME,
        // 程序化注册必须显式声明来源：加载路径（validateDefinition）强制要求
        // source 为字符串，缺失会抛 "source must be a string"；runtime 是专门
        // 给程序化注册的取值。
        source: 'runtime',
        description: 'Manually drive the locally installed codex (ChatGPT quota) or agy (Google quota) CLI to generate real AI bitmap images (PNG/JPG) headlessly, then display them in chat via show_image_file. Use when the generate_image tool fails on the codex/agy backend (quota exhausted, region blocked, output parsing failed) and manual recovery is needed, for batch image generation (the tool is one-image-per-call), when the user explicitly asks to drive the CLI directly, or when the user mentions codex/agy/antigravity as the image source (用 codex 画图 / 用 agy 生成 / 走谷歌额度 / 走 ChatGPT 额度). For a single image, prefer calling the generate_image tool directly first — it wraps the same CLIs in one call.',
        whenToUse: 'generate_image 工具在 codex/agy 渠道失败后的手动恢复路径；批量生图；用户点名 codex/agy/账号额度渠道',
        content: body,
      })
      skillRegistered = true
      // register() 内部经 layers.effect 绑定到本插件 ctx，停用/升级自动摘除；
      // 这里只持有 disposer 引用防止被提前回收，无需手动调用。
      void dispose
    } catch {
      // 技能文件缺失或注册失败：工具路径不受影响，静默降级
    }
  }
  registerCliSkill()

  // ── 工具：列出可用生图渠道 ───────────────────────────────
  ctx.tools.register(defineTool({
    name: 'list_image_backends',
    description: 'Probe and list the image-generation channels available on this machine: local CLIs (mmx = MiniMax account, codex = ChatGPT account, agy = Google account) and OpenAI-compatible API gateways configured under Model settings (e.g. openrouter). Call this before generating when the user asks which channels/models are available, or when generate_image needs an explicit backend. Relay the rendered report to the user and ask which channel/model to use or to test.',
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
    description: 'Generate an image through a chosen channel and return a markdown image reference for inline display in the chat. The returned value contains a markdown image reference ![alt](url) — you MUST include that markdown line VERBATIM in your reply text so the image renders inline; do not paste a bare link, do not call other tools to "display" it, and do not regenerate. Available channels come from list_image_backends (e.g. "mmx", "codex", "agy", "openrouter"). CLI channels (mmx/codex/agy) are transparent wrappers around locally installed CLIs — you still just pass prompt/backend/model exactly like an API channel; the plugin handles the CLI invocation and file retrieval internally, so NEVER run codex/agy/mmx commands yourself via bash. codex spends ChatGPT account quota, agy spends Google account quota, and both are natural fallbacks when API channels are out of quota. HARD GATE: if no default channel has been configured yet, this tool REFUSES to generate and returns a guidance report instead — even if you pass backend explicitly. In that case you MUST relay the channel list to the user and let THEM pick the default (never choose one yourself), persist their choice with set_image_default, then retry. The gate fires only until a default exists.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image description / prompt (English usually works best).' },
      backend: { type: 'string', description: 'Optional channel id, e.g. "mmx", "codex", "agy" or "openrouter". Pass it whenever the user names a specific channel — it overrides the configured default. Omit to use the default.' },
      model: { type: 'string', description: 'Optional model id for the backend, e.g. "image-01" (mmx), "image-gen" (codex), "gemini-3.7-flash-low" (agy) or "gpt-image-2" (openrouter). Omit to use the channel default. Note: the configured default model only applies to the configured default channel.' },
      size: { type: 'string', description: 'Optional image size, e.g. 1024x1024 (api) or 16:9 (mmx/codex/agy). Omit to use each backend\'s own default.' },
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
          return `（❌ 本机未探测到任何可用的生图渠道，本次未生成图片。\n请把下面几种解决方式告诉用户（任选其一），等用户配置完成后再重新探测确认：\n① 安装 mmx CLI（MiniMax）——装好后本插件会自动发现它；\n② 安装 codex CLI（OpenAI Codex）并确保已登录有生图额度的 ChatGPT 账号（codex login status 可查）——装好后同样自动发现；\n③ 安装 agy CLI（Google Antigravity）并确保已登录有额度的 Google 账号——装好后同样自动发现；\n④ 在 DSH「设置→模型」里添加一个 OpenAI 兼容渠道，并确保其模型列表里有生图模型（模型名含 image/imagen，例如 openrouter 上的 gpt-image / gemini 系列）。\n注意：现在调用 set_image_default 一定会失败（没有可选渠道），也不要原地重试 generate_image；等用户说配置好了，先调 list_image_backends 确认非空，再走询问默认的流程。）`
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
          throw new Error('generate_image: mmx CLI not found on this machine. Run list_image_backends to see available channels. If the CLI runs fine in your terminal but is not found here, the DSH host process PATH is narrower than your interactive shell (common on Linux with nvm/npm-global installs): set the plugin config key (mmxBin/codexBin/agyBin) to the absolute binary path (run `which <cli>` in your terminal to get it), then retry.')
        }
        const shell = ctx.get('shell')
        if (!shell) throw new Error('generate_image: shell service unavailable for the CLI backend')
        const dir = join(tmpdir(), `dsh-chat-imagine-${Date.now()}`)
        await mkdir(dir, { recursive: true })
        try {
          const bin = channel.bin || config.mmxBin
          // 单引号封装（与 codex/agy/vision 分支一致）：JSON.stringify 走双引号
          // 上下文，$()/反引号会被 shell 命令替换（命令注入）——必须用 shq。
          const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
          // size -> mmx flags：比例（16:9）走 --aspect-ratio；像素（1024x1024）走 --width/--height
          // （mmx 要求 512–2048 且为 8 的倍数，不满足则忽略，用 CLI 默认值）
          const sizeRaw = String(args.size ?? '').trim()
          let sizeFlags = ''
          if (/^\d+:\d+$/.test(sizeRaw)) {
            sizeFlags = ` --aspect-ratio ${shq(sizeRaw)}`
          } else {
            const m = /^(\d+)x(\d+)$/.exec(sizeRaw)
            const w = m ? Number(m[1]) : 0
            const h = m ? Number(m[2]) : 0
            if (w >= 512 && w <= 2048 && h >= 512 && h <= 2048 && w % 8 === 0 && h % 8 === 0) {
              sizeFlags = ` --width ${w} --height ${h}`
            }
          }
          const cmd = `${bin} image generate --prompt ${shq(prompt)}${sizeFlags} --out-dir ${shq(dir)} --non-interactive --quiet`
          let spec
          const req = { command: cmd, timeoutMs: config.timeoutMs, signal: exec.signal }
          try {
            spec = shell.resolve({ ...req, sandboxPolicy: { mode: 'danger-full-access' } })
          } catch {
            spec = shell.resolve(req)
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
        } finally {
          await cleanupDir(dir)
        }
      }

      // ── CLI 渠道（codex）─────────────────────────────────
      // 套壳 codex exec：让 codex 自己的 agent 循环调用内置 image_gen（hosted 工具，
      // 消耗 ChatGPT 账号额度），再从其输出中解析图片的落盘路径。
      if (!section && backend === 'codex') {
        const channel = await codexChannel()
        if (!channel) {
          throw new Error('generate_image: codex CLI not found on this machine. Run list_image_backends to see available channels. If the CLI runs fine in your terminal but is not found here, the DSH host process PATH is narrower than your interactive shell (common on Linux with nvm/npm-global installs): set the plugin config key (mmxBin/codexBin/agyBin) to the absolute binary path (run `which <cli>` in your terminal to get it), then retry.')
        }
        const shell = ctx.get('shell')
        if (!shell) throw new Error('generate_image: shell service unavailable for the CLI backend')
        const bin = channel.bin || config.codexBin
        // codex 的 image_gen 不吃尺寸参数：把比例/像素转成自然语言约束拼进提示词
        const sizeRaw = String(args.size ?? '').trim()
        let sizeHint = ''
        if (/^\d+:\d+$/.test(sizeRaw)) sizeHint = `，画面比例 ${sizeRaw}`
        else if (/^\d+x\d+$/.test(sizeRaw)) sizeHint = `，画面尺寸约 ${sizeRaw} 像素`
        const startMs = Date.now()
        const instr = `请用内置的图片生成工具（image generation / image_gen）生成一张图片：${prompt}${sizeHint}。生成完成后，在回复里给出图片的完整绝对保存路径（~/.codex/generated_images/ 下的 .png/.jpg/.webp 文件）。除此之外不要做任何其他事情。`
        // 单引号包裹（比双引号安全：$ 与反引号不会被 shell 展开）
        const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
        // 强制 low 推理：生图不需要长思维链，省时间也省账号额度
        const cmd = `${bin} exec --skip-git-repo-check -c 'model_reasoning_effort="low"' ${shq(instr)}`
        // codex 跑的是完整 agent 循环（读提示→调工具→落盘），比单次 API 请求慢：
        // 至少给 5 分钟
        const cliTimeout = Math.max(config.timeoutMs, 300000)
        const run = await shellOnce(shell, cmd, cliTimeout, exec.signal)
        const output = `${run.out}\n${run.err}`
        // 路径解析：优先解析 codex 回复里报告的绝对路径（可能被反引号/括号包裹）；
        // 解析不到再按 mtime 扫描 generated_images 兜底。
        const re = /([^\s'"`（）()]*generated_images\/[^\s'"`（）()]*\.(?:png|jpe?g|webp))/gi
        const candidates = []
        for (const m of output.matchAll(re)) {
          const p = m[1].replace(/^~/, homedir())
          try {
            const st = await stat(p)
            if (st.isFile()) candidates.push({ path: p, mtime: st.mtimeMs })
          } catch {
            // 输出里的路径不存在（如示例路径）：跳过
          }
        }
        if (candidates.length === 0) candidates.push(...await scanImagesSince(join(homedir(), '.codex', 'generated_images'), startMs))
        if (candidates.length === 0) {
          const tail = output.trim().slice(-600) || '(无输出)'
          const codeNote = run.code !== 0 ? ` (exit ${run.code})` : ''
          // 权限特征识别：codex 的 app-server/IPC 初始化在受限环境下常报
          // Operation not permitted (os error 1)——这不是登录/额度问题，而是
          // 沙箱/权限把 CLI 的进程初始化挡了，需提示用户换手动路径或放宽权限。
          const permHit = /operation not permitted|os error 1|\bEPERM\b|app-server|appserver|initialize.*failed/i.test(output)
          const cause = permHit
            ? '疑似权限限制：CLI 的进程初始化（app-server/IPC）被当前沙箱/权限模式拒绝（Operation not permitted），并非登录或额度问题'
            : '常见原因：未登录 ChatGPT 账号或生图额度用尽——可让用户运行 codex login status 检查'
          throw new Error(`generate_image: codex 未产出图片${codeNote}。${cause}。输出尾部：${tail}\n建议：① 让用户检查会话权限模式是否限制本机 CLI 执行；② 加载技能 ${SKILL_NAME}，按其中 codex 渠道指引直接驱动 CLI 并用 show_image_file 展示（模型手动的 bash 路径通常不受此限制）。`)
        }
        candidates.sort((a, b) => b.mtime - a.mtime)
        const abs = candidates[0].path
        const dot = abs.lastIndexOf('.')
        const ext = (dot >= 0 ? abs.slice(dot) : '').toLowerCase()
        const bytes = await readFile(abs)
        const id = remember(bytes, MIME_BY_EXT[ext] ?? 'image/png')
        return `${markdownFor(id, '生成的图片')}\n\n（渠道 ${backend}，模型 ${model || 'image-gen'}——codex 内置 image_gen，消耗 ChatGPT 账号额度。⚠️ 展示方式：必须把上面这行 markdown 图片引用【原样复制进你的回复文本】（保持 ![...](...) 格式，不要改成纯链接、不要另调 show_image_file/read_image、不要重新生成），图片才会内联显示在聊天中。）`
      }

      // ── CLI 渠道（agy）──────────────────────────────────
      // 套壳 agy --print：让 agy 的 agent 循环调用内置 Gemini 图像工具（消耗
      // Google 账号额度）。注意 agy 的 flag 必须用 --key=value 语法——空格分隔
      // 会被它错误解析导致提示词碎片化（实测行为）。
      if (!section && backend === 'agy') {
        const channel = await agyChannel()
        if (!channel) {
          throw new Error('generate_image: agy CLI not found on this machine. Run list_image_backends to see available channels. If the CLI runs fine in your terminal but is not found here, the DSH host process PATH is narrower than your interactive shell (common on Linux with nvm/npm-global installs): set the plugin config key (mmxBin/codexBin/agyBin) to the absolute binary path (run `which <cli>` in your terminal to get it), then retry.')
        }
        const shell = ctx.get('shell')
        if (!shell) throw new Error('generate_image: shell service unavailable for the CLI backend')
        // 在临时目录里跑，避免在用户工作区留下 agy 会话文件；目录由 JS 创建
        // 并在 finally 里清理（不再用 shell 的 mktemp -d，否则路径不可追踪）。
        const dir = join(tmpdir(), `dsh-chat-imagine-agy-${Date.now()}`)
        await mkdir(dir, { recursive: true })
        try {
          const bin = channel.bin || config.agyBin
          const sizeRaw = String(args.size ?? '').trim()
          let sizeHint = ''
          if (/^\d+:\d+$/.test(sizeRaw)) sizeHint = `, aspect ratio ${sizeRaw}`
          else if (/^\d+x\d+$/.test(sizeRaw)) sizeHint = `, roughly ${sizeRaw} pixels`
          const startMs = Date.now()
          const instr = `Use your built-in image generation tool (the Gemini image generation capability, NOT hand-written SVG or drawing code) to generate a PNG image: ${prompt}${sizeHint}. Then reply with the absolute file path of the saved PNG.`
          const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
          // 模型 id 白名单校验：它会直接拼进命令行（= 语法），只放行安全字符
          const modelId = String(model || 'gemini-3.7-flash-low')
          if (!/^[A-Za-z0-9._-]+$/.test(modelId)) {
            throw new Error(`generate_image: invalid agy model id "${modelId}"`)
          }
          // agy 跑的是完整 agent 循环，至少给 5 分钟。
          // --dangerously-skip-permissions：agy 的内部 agent（jetski）在 headless
          // 模式下无法弹权限询问，跑命令类工具会被自动拒绝（"a tool required the
          // command permission that headless mode cannot prompt for"）；生图场景
          // 没有需要人工确认的操作，直接放行。
          const cmd = `cd ${shq(dir)} && ${bin} --print --output-format=stream-json --model=${modelId} --dangerously-skip-permissions --prompt=${shq(instr)}`
          const cliTimeout = Math.max(config.timeoutMs, 300000)
          const run = await shellOnce(shell, cmd, cliTimeout)
          const output = `${run.out}\n${run.err}`
          // 路径解析：优先解析回复里的绝对路径（antigravity-cli/brain/<uuid>/xx.png）；
          // 解析不到再按 mtime 扫描 brain 目录兜底。
          const re = /([^\s'"`（）()]*antigravity-cli\/brain\/[^\s'"`（）()]*\.(?:png|jpe?g|webp))/gi
          const candidates = []
          for (const m of output.matchAll(re)) {
            try {
              const st = await stat(m[1])
              if (st.isFile()) candidates.push({ path: m[1], mtime: st.mtimeMs })
            } catch {
              // 输出里的路径不存在：跳过
            }
          }
          if (candidates.length === 0) candidates.push(...await scanImagesSince(join(homedir(), '.gemini', 'antigravity-cli', 'brain'), startMs))
          if (candidates.length === 0) {
            const tail = output.trim().slice(-600) || '(无输出)'
            const codeNote = run.code !== 0 ? ` (exit ${run.code})` : ''
            throw new Error(`generate_image: agy 未产出图片${codeNote}。常见原因：未登录 Google 账号、额度用尽或出口区域被拒（User location is not supported，需换代理节点）——可让用户在 Antigravity App 里确认登录状态。输出尾部：${tail}\n手动恢复：加载技能 ${SKILL_NAME}，按其中 agy 渠道指引直接驱动 CLI 并用 show_image_file 展示。`)
          }
          candidates.sort((a, b) => b.mtime - a.mtime)
          const abs = candidates[0].path
          const dot = abs.lastIndexOf('.')
          const ext = (dot >= 0 ? abs.slice(dot) : '').toLowerCase()
          const bytes = await readFile(abs)
          const id = remember(bytes, MIME_BY_EXT[ext] ?? 'image/png')
          return `${markdownFor(id, '生成的图片')}\n\n（渠道 ${backend}，模型 ${modelId}——agy 内置 Gemini 图像工具，消耗 Google 账号额度。⚠️ 展示方式：必须把上面这行 markdown 图片引用【原样复制进你的回复文本】（保持 ![...](...) 格式，不要改成纯链接、不要另调 show_image_file/read_image、不要重新生成），图片才会内联显示在聊天中。）`
        } finally {
          await cleanupDir(dir)
        }
      }

      // ── API 渠道 ────────────────────────────────────────
      let baseURL = ''
      let key = ''
      if (section) {
        if (typeof section.baseURL === 'string' && section.baseURL.trim()) baseURL = section.baseURL.trim()
        if (typeof section.apiKeyEnv === 'string' && section.apiKeyEnv) {
          const cred = await credentials?.resolve(section.apiKeyEnv).catch(() => undefined)
          if (cred) key = cred.value
        }
        // profile 没填 baseURL：回退 pi-ai 内置 catalog（与 llm-pi-ai 适配器一致，
        // openrouter 等 DSH 内置 provider 不填地址也能正常工作）
        if (!baseURL) baseURL = (await catalogBaseUrls())[backend] || ''
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
        // 只放行栅格图 MIME：image/svg+xml 可内嵌 <script>，直接透传给浏览器
        // 会造成 XSS 面（web 路由按此 MIME 返回）。非白名单一律退回 image/png。
        if (/^image\/(png|jpe?g|webp|gif)$/.test(ct)) mime = ct
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

  // ── 工具：识图（结构化 JSON 证据，契约借鉴 modlens）──────────
  // 与生图共用 mmx/codex/agy 三个本机 CLI 渠道，但走各自的视觉能力：
  //   mmx  — vision describe 直连 MiniMax VLM（最快，3-5s），无 schema 强制，
  //          用 JSON 填空模板 + 宽松解析 + 结构校验兜底
  //   codex — exec -i 附图 + --output-schema（OpenAI strict 模式），
  //          schema 服务端强制，输出可靠；low 推理档省时间省额度
  //   agy  — --print + --json-schema（envelope.structured_output），
  //          flag 必须空格分隔（=value 语法解析有 bug，实测）
  // 三个渠道返回同一份 VISION_SCHEMA 证据。选路：显式 backend > settings
  // 账本的 visionBackend > 探测顺序 mmx → codex → agy（速度序）。
  // 与 modlens 的区别：modlens 是独立引擎（要配置、接管模型路由、要求选
  // visor 模型），本工具是插件内工具——任何模型直接调用，不切模型不改路由。
  ctx.tools.register(defineTool({
    name: 'analyze_image',
    description:
      'Read an image (local file path or http(s) URL) and return structured evidence: full transcription (ocr.full_text), reading-order layout regions, semantics (scene/entities/relations), visual notes, and an uncertainty list — the same evidence contract as modlens, running on the mmx/codex/agy CLI channels this plugin already probes. Works on ANY model: no vision model, no route switching. PREREQUISITE: at least ONE of the mmx / codex / agy CLIs installed on this machine (any one suffices — the tool auto-picks the first available; if none is found the call returns an explanatory error — do not retry, just tell the user no CLI was found so image reading is unavailable). Use whenever the current model cannot see an image the user pasted or referenced (screenshot, photo, chart, diagram, document scan) — quote the evidence instead of guessing. Also for precise extraction: OCR, table/form reading, UI element inventory.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute local file path or http(s) URL of the image.' },
      prompt: { type: 'string', description: 'Optional extra focus for the reading, e.g. "focus on the axis labels".' },
      backend: { type: 'string', description: 'Optional channel id: "mmx" (fastest, MiniMax VLM), "codex" (ChatGPT account, server-enforced JSON schema), "agy" (Google account, Gemini). Omit to use the configured vision default, else auto-pick the first available channel.' },
    },
    output: {
      // VISION_SCHEMA 是标准 JSON Schema（喂给 codex/agy 的 --output-schema），
      // dsh-tools 的 output.schema 是另一套 DSL，用派生的兼容形状。
      schema: visionOutputSchema(),
      render: (_a, value) => [{ type: 'text', text: renderVisionEvidence(value) }],
    },
    async execute(args, exec) {
      const path = String(args.path ?? '').trim()
      if (!path) throw new Error('analyze_image: path is required')
      const isUrl = /^https?:\/\//i.test(path)
      if (!isUrl && !VISION_EXT_OK.test(path)) {
        throw new Error(
          'analyze_image: unsupported image type. Supported extensions: .png .jpg .jpeg .webp .gif .heic .heif (or an http(s) URL).',
        )
      }
      if (!isUrl) {
        const st = await stat(path).catch(() => null)
        if (!st || !st.isFile()) throw new Error('analyze_image: file not found: ' + path)
      }

      // 渠道选择：显式 > 账本默认（visionBackend）> 探测序（mmx 最快）
      const explicit = String(args.backend ?? '').trim()
      let backend = explicit
      let fromLedger = false
      if (!backend) {
        try {
          const v = ctx.get('settings')?.get('dsh-chat-imagine')
          backend = typeof v?.visionBackend === 'string' ? v.visionBackend : ''
          fromLedger = backend !== ''
        } catch {}
      }
      if (fromLedger) {
        // 账本渠道未必仍安装（CLI 被卸载 / 换机器）：校验探测结果，不可用就
        // 回退到探测序自动选，而不是硬报「CLI not found」。显式渠道不在此列
        // （模型点名它，出错就该报错让调用方知道）。
        const ledgerChannel = await (backend === 'mmx' ? mmxChannel() : backend === 'codex' ? codexChannel() : backend === 'agy' ? agyChannel() : null)
        if (!ledgerChannel) backend = ''
      }
      if (!backend) {
        const [mmx, codex, agy] = await Promise.all([mmxChannel(), codexChannel(), agyChannel()])
        backend = mmx ? 'mmx' : codex ? 'codex' : agy ? 'agy' : ''
      }
      if (!backend) {
        throw new Error(
          'analyze_image: CLI not found — none of mmx / codex / agy is installed, so image reading is unavailable. Any ONE of them suffices (all three return the same evidence). ' +
          'If a CLI runs in the terminal but is not detected here, the DSH host PATH is narrower than the interactive shell (common on Linux): set the plugin config mmxBin/codexBin/agyBin to the absolute path from `which <cli>`. ' +
          'Tell the user image reading is unavailable unless they install one of the CLIs (mmx: npm install -g mmx-cli / codex: ChatGPT CLI / agy: Google Antigravity CLI).',
        )
      }

      const prompt = visionPrompt(path, args.prompt)
      const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
      const startedAt = Date.now()

      // ── mmx：vision describe 直连 VLM，输出自由文本（JSON 在 content 里）──
      if (backend === 'mmx') {
        const channel = await mmxChannel()
        if (!channel) throw new Error('analyze_image: mmx CLI not found on this machine. If the CLI runs fine in your terminal but is not found here, the DSH host process PATH is narrower than your interactive shell (common on Linux with nvm/npm-global installs): set the plugin config key (mmxBin/codexBin/agyBin) to the absolute binary path (run `which <cli>` in your terminal to get it), then retry.')
        const shell = ctx.get('shell')
        if (!shell) throw new Error('analyze_image: shell service unavailable')
        const bin = channel.bin || config.mmxBin
        const question = prompt + '\n\n' + VISION_JSON_TEMPLATE
        const cmd =
          bin + ' vision describe --image ' + shq(path) +
          ' --prompt ' + shq(question) + ' --output json --non-interactive --quiet'
        const run = await shellOnce(shell, cmd, Math.max(config.timeoutMs, 120000), exec.signal)
        if (run.code !== 0) {
          throw new Error('analyze_image: mmx failed (exit ' + run.code + '): ' + (run.err || run.out).slice(-500))
        }
        let envelope
        try {
          envelope = JSON.parse(run.out)
        } catch {
          throw new Error('analyze_image: mmx output is not JSON: ' + run.out.slice(0, 300))
        }
        if (envelope?.base_resp?.status_code && envelope.base_resp.status_code !== 0) {
          throw new Error('analyze_image: mmx API error ' + envelope.base_resp.status_code + ': ' + (envelope.base_resp.status_msg || ''))
        }
        // mmx 高密度图会无视 JSON 模板返回散文：不强制、不报错，交给组装器
        // 从原料里提取并兜底（散文进 summary 并标注降级）。
        const result = assembleVisionResult(envelope?.content ?? '', 'mmx')
        if (!result) {
          throw new Error('analyze_image: mmx returned no usable content: ' + String(envelope?.content ?? '').slice(0, 300))
        }
        return { ...result, _meta: { channel: 'mmx', model: 'MiniMax VLM', durationSeconds: ((Date.now() - startedAt) / 1000).toFixed(1) } }
      }

      // ── codex：exec -i 附图 + --output-schema（OpenAI strict，服务端强制）──
      if (backend === 'codex') {
        const channel = await codexChannel()
        if (!channel) throw new Error('analyze_image: codex CLI not found on this machine. If the CLI runs fine in your terminal but is not found here, the DSH host process PATH is narrower than your interactive shell (common on Linux with nvm/npm-global installs): set the plugin config key (mmxBin/codexBin/agyBin) to the absolute binary path (run `which <cli>` in your terminal to get it), then retry.')
        const shell = ctx.get('shell')
        if (!shell) throw new Error('analyze_image: shell service unavailable')
        const bin = channel.bin || config.codexBin
        // 临时目录：放 schema 文件（--output-schema 只吃文件路径）+ 本地图片的
        // 隔离副本（codex -i 的相对路径基于 cwd；隔离目录防图片内注入读兄弟文件，
        // modlens isolateWorkdir 同款思路）
        const dir = join(tmpdir(), 'dsh-chat-imagine-vision-' + Date.now())
        await mkdir(dir, { recursive: true })
        try {
          const schemaFile = join(dir, 'schema.json')
          await writeFile(schemaFile, JSON.stringify(strictSchema(VISION_SCHEMA)))
          let imgArg = path
          if (!isUrl) {
            const extMatch = path.match(/\.[a-z0-9]+$/i)
            const ext = extMatch ? extMatch[0].toLowerCase() : '.png'
            const copyPath = join(dir, 'image' + ext)
            await writeFile(copyPath, await readFile(path))
            imgArg = copyPath
          }
          const cmd =
            bin + ' exec --skip-git-repo-check --ephemeral -s read-only' +
            ' -c ' + JSON.stringify('model_reasoning_effort="low"') +
            ' -i ' + shq(imgArg) +
            ' --output-schema ' + shq(schemaFile) + ' ' +
            shq(prompt) +
            ' < /dev/null'
          // ↑ 经 shell 服务运行时 stdin 是打开的管道，codex 会打印
          // "Reading additional input from stdin..." 然后阻塞等待输入直到
          // 超时（终端手跑没事因为 stdin 是关闭的）。重定向 /dev/null 让它
          // 立即读到 EOF——实测修复。
          const run = await shellOnce(shell, cmd, Math.max(config.timeoutMs, 240000), exec.signal)
          if (run.code !== 0) {
            throw new Error(
              'analyze_image: codex failed (exit ' + run.code + ')' +
                (run.code === -1 ? '，疑似超时（完整 schema 输出较慢，可重试或换 backend "mmx" / "agy"）' : '') +
                ': ' + (run.err || run.out).slice(-300),
            )
          }
          const output = run.out + '\n' + run.err
          // codex 的 stdout 是整个会话记录（会话头、schema 校验失败的半截
          // JSON、模型自我重试旁白都可能混在里面）。组装器的平衡括号扫描
          // 会跳过损坏段，找到真正可解析的最终对象；都找不到则兜底降级。
          const result = assembleVisionResult(output, 'codex')
          return { ...result, _meta: { channel: 'codex', model: 'gpt-5.x (codex)', durationSeconds: ((Date.now() - startedAt) / 1000).toFixed(1) } }
        } finally {
          await cleanupDir(dir)
        }
      }

      // ── agy：--print + --json-schema（envelope.structured_output）────
      if (backend === 'agy') {
        const channel = await agyChannel()
        if (!channel) throw new Error('analyze_image: agy CLI not found on this machine. If the CLI runs fine in your terminal but is not found here, the DSH host process PATH is narrower than your interactive shell (common on Linux with nvm/npm-global installs): set the plugin config key (mmxBin/codexBin/agyBin) to the absolute binary path (run `which <cli>` in your terminal to get it), then retry.')
        const shell = ctx.get('shell')
        if (!shell) throw new Error('analyze_image: shell service unavailable')
        const bin = channel.bin || config.agyBin
        const dir = join(tmpdir(), 'dsh-chat-imagine-vision-' + Date.now())
        await mkdir(dir, { recursive: true })
        try {
          const schemaFile = join(dir, 'schema.json')
          // agy 对 schema 无 strict 要求，直接用原生 VISION_SCHEMA
          await writeFile(schemaFile, JSON.stringify(VISION_SCHEMA))
          // agy 的 flag 解析有两个实测坑：① 必须 --key value 空格分隔（=value 会
          // 碎片化）；② prompt 必须放在第一个 flag 位置（-p 紧跟二进制名）——
          // 放后面时其它 flag 会被误吞进 prompt 文本，输出变成闲聊而非 JSON。
          // 图片让 agent 读绝对路径（prompt 里已带）。在隔离目录里跑（防注入）。
          const cmd =
            'cd ' + shq(dir) + ' && ' + bin +
            ' -p ' + shq(prompt) +
            ' --dangerously-skip-permissions --output-format json --json-schema ' + shq(schemaFile) +
            ' --model gemini-3.7-flash-low --print-timeout 120s'
          const run = await shellOnce(shell, cmd, Math.max(config.timeoutMs, 180000), exec.signal)
          if (run.code !== 0 && !run.out.trim()) {
            throw new Error('analyze_image: agy failed (exit ' + run.code + '): ' + (run.err || run.out).slice(-500))
          }
          let envelope
          try {
            envelope = JSON.parse(run.out)
          } catch {
            envelope = null
          }
          if (envelope?.status && envelope.status !== 'SUCCESS') {
            // agy 对 auth/quota 一律 exit 1 + "Agent execution terminated due to error"，
            // 真实原因在其日志里（modlens 的经验）。给用户可操作的指引。
            throw new Error(
              'analyze_image: agy reported status ' + envelope.status +
                ' ("' + String(envelope.error ?? '').slice(0, 120) + '").' +
                ' Common causes: Google 账号额度用尽（agy 免费档是周桶，桌面 App/CLI/SDK 共享，重试或换渠道）、未登录、或区域限制。' +
                ' 可换 backend "mmx" 或 "codex" 重试，或在终端跑一次 agy 看具体报错。',
            )
          }
          // agy 的 structured_output 已是对象；response 是自由文本（可能含
          // JSON），两者都交给组装器统一处理（对象走字段级修复路径）。
          const rawResult = envelope?.structured_output ?? envelope?.response ?? ''
          const result = assembleVisionResult(
            typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult),
            'agy',
          )
          if (!result) {
            throw new Error('analyze_image: agy returned no usable content: ' + (run.out || run.err).slice(0, 300))
          }
          return {
            ...result,
            _meta: {
              channel: 'agy',
              model: 'gemini-3.7-flash-low',
            durationSeconds: envelope?.duration_seconds ?? ((Date.now() - startedAt) / 1000).toFixed(1),
          },
          }
        } finally {
          await cleanupDir(dir)
        }
      }

      throw new Error('analyze_image: unknown backend "' + backend + '". Use mmx, codex or agy.')
    },
  }))

  // ── 工具：设置默认生图渠道/模型（写入 settings 账本，热生效）──
  ctx.tools.register(defineTool({
    name: 'set_image_default',
    description: 'Set the default image-generation channel and model. The choice is persisted (survives restarts) and used by generate_image whenever backend/model are omitted. REQUIRED before the first generate_image call: generate_image refuses to generate until a default exists. Always call it with the channel the USER picked (from list_image_backends or from their own words), never your own preference; also use it to change the default later.',
    parameters: {
      backend: { type: 'string', required: true, description: 'Channel id to use as default, e.g. "mmx", "codex", "agy" or "openrouter".' },
      model: { type: 'string', description: 'Optional model id to pin as default, e.g. "image-01" (mmx), "image-gen" (codex) or "gpt-image-2". Omit to clear the pinned model (channel default applies).' },
      visionBackend: { type: 'string', description: 'Optional default channel for analyze_image (image reading), e.g. "mmx" (fastest), "codex" or "agy". Pass only when the user also wants to pin the vision default; empty string clears it (auto-pick by speed).' },
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
      // visionBackend 只在明确传入时更新（含空串清除）；未传不动现有值
      const patch = { defaultBackend: backend, defaultModel: model }
      if (args.visionBackend !== undefined) {
        const vb = String(args.visionBackend ?? '').trim()
        if (vb && !['mmx', 'codex', 'agy'].includes(vb)) {
          throw new Error('set_image_default: visionBackend must be one of mmx / codex / agy (API channels have no vision support).')
        }
        patch.visionBackend = vb
      }
      const ok = await writeLedger(patch)
      if (!ok) {
        throw new Error('set_image_default: could not persist the default (settings service unavailable). Edit cordis.yml config defaultBackend/defaultModel instead.')
      }
      const ledger = currentLedger()
      const visionNote = ledger.visionBackend ? `\n识图默认渠道：${ledger.visionBackend}（analyze_image 用）` : ''
      const def = effectiveDefaults()
      return `✅ 默认生图设置已保存：渠道 ${def.defaultBackend}${def.defaultModel ? `，模型 ${def.defaultModel}` : '（模型不固定，用渠道默认）'}。${visionNote}\n以后直接说"生成一张图"就会用这个默认设置；想修改随时再调用本工具。`
    },
  }))
}
