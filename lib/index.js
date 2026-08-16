// dsh-balance-monitor — host half.
//
// One logical RPC channel, /balance, serving two endpoints:
//
//   "snapshot" — DeepSeek account balance + today's spend. Reads the API key
//   from $DSH_HOME/.credentials.yaml (env DEEPSEEK_API_KEY wins), queries
//   GET https://api.deepseek.com/user/balance, and folds the result into a
//   tiny state file ($DSH_HOME/storages/balance-monitor.json) that keeps the
//   day-start baseline across page refreshes and process restarts.
//   Payload { refresh: false } returns the last known numbers WITHOUT hitting
//   the network (in-memory last, else the disk state) — the UI uses this on
//   mount so nothing is fetched until the user asks.
//
//   "usage" — yearly (rolling 12 calendar months) token consumption and cost.
//   Requires the DeepSeek platform login token (DEEPSEEK_PLATFORM_TOKEN in
//   env, else the DEEPSEEK_PLATFORM_TOKEN line in .credentials.yaml); queries
//   the private dashboard endpoints /api/v0/usage/amount and /api/v0/usage/cost
//   month by month, aggregates, and caches to
//   $DSH_HOME/storages/balance-usage.json. Payload { refresh: false } returns
//   only the cached numbers; { refresh: true } re-queries DeepSeek. The UI
//   only sends { refresh: true } when the user clicks the refresh button.
//
//   "config" — plugin settings persisted in
//   $DSH_HOME/storages/balance-monitor-config.json: balance poll interval
//   (pollMs), low-balance reminder threshold (lowBalanceThreshold), and an
//   optional platform token override (platformToken) that takes precedence
//   over .credentials.yaml (the DEEPSEEK_PLATFORM_TOKEN env var still wins).
//   Actions: { action: 'get' } reads the config, { action: 'set', config }
//   merges a patch and persists it, { action: 'test' } validates the
//   effective platform token against the current month's cost endpoint.
//
// Day-spend semantics: the first successful query of a calendar day (local
// time) becomes that day's baseline; spend = max(0, baseline - current).
// A refill pushes current above baseline, which clamps spend to 0 rather
// than going negative. When the upstream call fails and a state file exists,
// the last known numbers are returned with a `stale: true` flag so the UI
// can keep showing something instead of flashing an error.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-balance-monitor'
export const inject = ['connection']

const BALANCE_API = 'https://api.deepseek.com/user/balance'
const USAGE_API_BASE = 'https://platform.deepseek.com/api/v0/usage'
const CREDENTIALS_FILE = '.credentials.yaml'
const STATE_FILE = 'balance-monitor.json'
const USAGE_STATE_FILE = 'balance-usage.json'
// Rolling window: the current calendar month plus the 11 before it.
const USAGE_MONTHS = 12
// Plugin settings (persisted in $DSH_HOME/storages/balance-monitor-config.json).
const CONFIG_STATE_FILE = 'balance-monitor-config.json'
const DEFAULT_POLL_MS = 60000
const DEFAULT_LOW_BALANCE_THRESHOLD = 1
const MIN_POLL_MS = 5000
const MAX_POLL_MS = 3600000

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function today() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Extract the API key: env first, then the one-line YAML in .credentials.yaml. */
async function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const yaml = await readFile(join(dshHome(), CREDENTIALS_FILE), 'utf8')
    const match = yaml.match(/^DEEPSEEK_API_KEY:\s*(\S+)/m)
    if (match) return match[1]
  } catch {
    // fall through
  }
  return null
}

/** Extract the platform login token (userToken): env first, then the plugin
 *  config override, then .credentials.yaml. */
async function readPlatformToken() {
  if (process.env.DEEPSEEK_PLATFORM_TOKEN) return process.env.DEEPSEEK_PLATFORM_TOKEN
  const config = await loadConfig()
  if (config && typeof config.platformToken === 'string' && config.platformToken) return config.platformToken
  try {
    const yaml = await readFile(join(dshHome(), CREDENTIALS_FILE), 'utf8')
    const match = yaml.match(/^DEEPSEEK_PLATFORM_TOKEN:\s*(\S+)/m)
    if (match) return match[1]
  } catch {
    // fall through
  }
  return null
}

async function fetchBalance(apiKey, signal) {
  const res = await fetch(BALANCE_API, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!res.ok) throw new Error(`balance api responded ${res.status}`)
  const json = await res.json()
  const infos = Array.isArray(json.balance_infos) ? json.balance_infos : []
  const info = infos.find((i) => i.currency === 'CNY') ?? infos[0]
  if (!info) throw new Error('balance api returned no balance_infos')
  return {
    available: json.is_available === true,
    currency: info.currency,
    total: Number.parseFloat(info.total_balance),
    granted: Number.parseFloat(info.granted_balance),
    toppedUp: Number.parseFloat(info.topped_up_balance),
  }
}

/**
 * GET one dashboard endpoint. A browser-like User-Agent is required — the
 * platform WAF (awswaf) blocks bare script clients with 429.
 */
async function fetchDashboard(url, token, signal) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      Referer: 'https://platform.deepseek.com/',
    },
    signal,
  })
  if (!res.ok) throw new Error(`usage api responded ${res.status}`)
  const json = await res.json()
  if (!json || json.code === 40003) {
    throw new Error('DeepSeek platform token is invalid or expired (code 40003)')
  }
  if (json.code !== 0) {
    throw new Error(`usage api error code ${json.code}: ${json.msg ?? ''}`)
  }
  return json
}

/** Extract per-model usage dicts from an amount/cost response (handles both biz_data shapes). */
function pickModelUsage(resp) {
  let bd = resp?.data?.biz_data
  if (Array.isArray(bd)) bd = bd[0] ?? null
  const total = bd && Array.isArray(bd.total) ? bd.total : []
  const out = {}
  for (const item of total) {
    const u = {}
    for (const e of item.usage ?? []) {
      u[e.type] = Number.parseFloat(e.amount) || 0
    }
    out[item.model] = u
  }
  return out
}

/** Fetch amount+cost for one month and fold into a plain month summary. */
async function fetchMonthUsage(token, year, month, signal) {
  const [amt, cst] = await Promise.all([
    fetchDashboard(`${USAGE_API_BASE}/amount?month=${month}&year=${year}`, token, signal),
    fetchDashboard(`${USAGE_API_BASE}/cost?month=${month}&year=${year}`, token, signal),
  ])
  const am = pickModelUsage(amt)
  const cs = pickModelUsage(cst)
  const models = new Set([...Object.keys(am), ...Object.keys(cs)])
  const m = { month: `${year}-${String(month).padStart(2, '0')}`, cacheHit: 0, cacheMiss: 0, prompt: 0, response: 0, requests: 0, cost: 0 }
  for (const model of models) {
    const a = am[model] ?? {}
    const c = cs[model] ?? {}
    m.cacheHit += a.PROMPT_CACHE_HIT_TOKEN ?? 0
    m.cacheMiss += a.PROMPT_CACHE_MISS_TOKEN ?? 0
    m.prompt += a.PROMPT_TOKEN ?? 0
    m.response += a.RESPONSE_TOKEN ?? 0
    m.requests += a.REQUEST ?? 0
    m.cost +=
      (c.PROMPT_TOKEN ?? 0) +
      (c.PROMPT_CACHE_HIT_TOKEN ?? 0) +
      (c.PROMPT_CACHE_MISS_TOKEN ?? 0) +
      (c.RESPONSE_TOKEN ?? 0) +
      (c.REQUEST ?? 0)
  }
  m.cost = Math.round(m.cost * 100) / 100
  return m
}

/** Fetch the rolling 12-calendar-month window and aggregate. */
async function fetchYearlyUsage(token, signal) {
  const now = new Date()
  const months = []
  for (let i = USAGE_MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }
  const from = months[0]
  const to = months[months.length - 1]
  const perMonth = []
  const totals = { cacheHit: 0, cacheMiss: 0, prompt: 0, response: 0, requests: 0, cost: 0 }
  for (const { year, month } of months) {
    const m = await fetchMonthUsage(token, year, month, signal)
    perMonth.push(m)
    for (const k of Object.keys(totals)) totals[k] += m[k]
  }
  totals.cost = Math.round(totals.cost * 100) / 100
  return {
    period: {
      from: `${from.year}-${String(from.month).padStart(2, '0')}`,
      to: `${to.year}-${String(to.month).padStart(2, '0')}`,
    },
    months: perMonth,
    totals,
    currency: 'CNY',
  }
}

const statePath = () => join(dshHome(), 'storages', STATE_FILE)
const usageStatePath = () => join(dshHome(), 'storages', USAGE_STATE_FILE)

async function loadState() {
  try {
    const state = JSON.parse(await readFile(statePath(), 'utf8'))
    if (state && typeof state.date === 'string' && typeof state.dayStart === 'number') return state
  } catch {
    // no state yet
  }
  return null
}

async function loadUsageState() {
  try {
    const state = JSON.parse(await readFile(usageStatePath(), 'utf8'))
    if (state && state.totals && state.period) return state
  } catch {
    // no state yet
  }
  return null
}

async function saveState(state) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(statePath(), JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('[balance-monitor] state write failed:', error)
  }
}

async function saveUsageState(state) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(usageStatePath(), JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('[balance-monitor] usage state write failed:', error)
  }
}

const configPath = () => join(dshHome(), 'storages', CONFIG_STATE_FILE)

async function loadConfig() {
  try {
    const config = JSON.parse(await readFile(configPath(), 'utf8'))
    if (config && typeof config === 'object') return config
  } catch {
    // no config yet
  }
  return null
}

async function saveConfig(config) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(configPath(), JSON.stringify(config, null, 2))
  } catch (error) {
    console.error('[balance-monitor] config write failed:', error)
  }
}

/** Clamp an integer setting (e.g. poll interval in ms) into its allowed range. */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Clamp a float setting (e.g. the low-balance threshold) into its range. */
function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const maskToken = (token) => {
  if (!token) return null
  if (token.length <= 8) return '****'
  return `${token.slice(0, 4)}*****${token.slice(-4)}`
}

/** Read the effective plugin config with every setting normalized. */
async function effectiveConfig() {
  const config = (await loadConfig()) ?? {}
  return {
    pollMs: clampInt(config.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS),
    lowBalanceThreshold: clampNum(config.lowBalanceThreshold, 0, 1000000, DEFAULT_LOW_BALANCE_THRESHOLD),
    platformToken: config.platformToken && typeof config.platformToken === 'string' ? config.platformToken : null,
  }
}

async function handleConfig(payload, signal) {
  const action = payload && payload.action
  if (action === 'get') {
    const config = await effectiveConfig()
    const source = config.platformToken
      ? 'plugin'
      : process.env.DEEPSEEK_PLATFORM_TOKEN
        ? 'env'
        : 'credentials'
    return {
      ok: true,
      value: {
        pollMs: config.pollMs,
        lowBalanceThreshold: config.lowBalanceThreshold,
        tokenConfigured: Boolean(config.platformToken),
        tokenPreview: maskToken(config.platformToken),
        tokenSource: source,
      },
    }
  }
  if (action === 'set') {
    const patch = payload && payload.config ? payload.config : {}
    const config = (await loadConfig()) ?? {}
    if (patch.pollMs !== undefined) config.pollMs = clampInt(patch.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS)
    if (patch.lowBalanceThreshold !== undefined) {
      config.lowBalanceThreshold = clampNum(patch.lowBalanceThreshold, 0, 1000000, DEFAULT_LOW_BALANCE_THRESHOLD)
    }
    if (patch.platformToken !== undefined) {
      const token = typeof patch.platformToken === 'string' ? patch.platformToken.trim() : ''
      config.platformToken = token || null
    }
    await saveConfig(config)
    const saved = await effectiveConfig()
    return {
      ok: true,
      value: {
        saved: true,
        pollMs: saved.pollMs,
        lowBalanceThreshold: saved.lowBalanceThreshold,
        tokenConfigured: Boolean(saved.platformToken),
        tokenPreview: maskToken(saved.platformToken),
      },
    }
  }
  if (action === 'test') {
    const token = await readPlatformToken()
    if (!token) {
      return { ok: true, value: { valid: false, message: 'DEEPSEEK_PLATFORM_TOKEN not configured' } }
    }
    try {
      const now = new Date()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      await fetchDashboard(`${USAGE_API_BASE}/cost?month=${month}&year=${now.getFullYear()}`, token, signal)
      return { ok: true, value: { valid: true, message: 'ok' } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: true, value: { valid: false, message } }
    }
  }
  return {
    ok: false,
    error: { code: 'bad-request', message: `unknown config action: ${action}`, details: {} },
  }
}

export function apply(ctx) {
  // In-process fallback so a transient upstream failure after a success
  // still answers the UI without touching disk.
  let last = null

  /** Serve the freshest known snapshot without hitting the network. */
  async function cachedSnapshot() {
    const fallback = last ?? (await loadState())
    const lastTotal =
      fallback &&
      (typeof fallback.lastTotal === 'number'
        ? fallback.lastTotal
        : typeof fallback.total === 'number'
          ? fallback.total
          : NaN)
    if (fallback && Number.isFinite(lastTotal)) {
      return {
        date: fallback.date,
        dayStart: fallback.dayStart,
        total: lastTotal,
        currency: fallback.lastCurrency ?? fallback.currency ?? 'CNY',
        available: false,
        spent: fallback.spent ?? Math.max(0, fallback.dayStart - lastTotal),
        updatedAt: fallback.updatedAt ?? 0,
        stale: true,
      }
    }
    return null
  }

  async function handleSnapshot(payload, signal) {
    if (payload && payload.refresh === false) {
      const cached = await cachedSnapshot()
      return cached ? { ok: true, value: cached } : { ok: true, value: null }
    }
    try {
      const apiKey = await readApiKey()
      if (!apiKey) {
        return {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'DEEPSEEK_API_KEY not found in .credentials.yaml',
            details: {},
          },
        }
      }
      const balance = await fetchBalance(apiKey, signal)
      const state = (await loadState()) ?? {}
      const date = today()
      const sameDay = state.date === date
      const sameCurrency = state.lastCurrency === undefined || state.lastCurrency === balance.currency

      // Cross-day or currency switch: reset the day-start baseline and the
      // spend ledger (never carry either across days or currencies).
      let dayStart = sameDay && sameCurrency ? state.dayStart : balance.total
      let spent = sameDay && sameCurrency ? (state.spent ?? 0) : 0
      const prevTotal = sameDay && sameCurrency ? state.lastTotal : balance.total

      // Spend ledger: accumulate balance *drops* only. A refill (or refund)
      // raises the balance and is not consumption, so it must not inflate
      // today's spend — and must not wash out spend already accumulated.
      if (prevTotal > balance.total) {
        spent += prevTotal - balance.total
        spent = Math.round(spent * 100) / 100 // keep float drift out of the ledger
      }

      // Refill re-fills the bar: the baseline follows balance rises, so the
      // ratio bar reads full right after a top-up and every later drop is
      // visible immediately instead of being clamped at 100%.
      if (balance.total > dayStart) dayStart = balance.total

      await saveState({
        date,
        dayStart,
        lastTotal: balance.total,
        lastCurrency: balance.currency,
        spent,
        updatedAt: Date.now(),
      })

      const snapshot = {
        date,
        dayStart,
        total: balance.total,
        currency: balance.currency,
        available: balance.available,
        spent,
        updatedAt: Date.now(),
        stale: false,
      }
      last = snapshot
      return { ok: true, value: snapshot }
    } catch (error) {
      // Upstream failure: serve the freshest known numbers if we have any.
      const cached = await cachedSnapshot()
      if (cached) return { ok: true, value: cached }
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: { code: 'internal', message: `balance query failed: ${message}`, details: {} },
      }
    }
  }

  async function handleUsage(payload, signal) {
    const wantRefresh = payload && payload.refresh === true
    const cached = await loadUsageState()
    if (!wantRefresh) {
      // Cached read only — never touches the network.
      return cached ? { ok: true, value: { ...cached, cached: true } } : { ok: true, value: null }
    }
    try {
      const token = await readPlatformToken()
      if (!token) {
        return {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'DEEPSEEK_PLATFORM_TOKEN not found in .credentials.yaml',
            details: {},
          },
        }
      }
      const usage = await fetchYearlyUsage(token, signal)
      const value = { ...usage, fetchedAt: Date.now(), cached: false }
      await saveUsageState(value)
      return { ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (cached) {
        return { ok: true, value: { ...cached, cached: true, error: message } }
      }
      return {
        ok: false,
        error: { code: 'internal', message: `usage query failed: ${message}`, details: {} },
      }
    }
  }

  ctx.connection.rpc.handle(
    '/balance',
    async (endpoint, payload, signal) => {
      if (endpoint === 'usage') return handleUsage(payload, signal)
      if (endpoint === 'config') return handleConfig(payload, signal)
      return handleSnapshot(payload, signal)
    },
    { authority: 'loopback' },
  )
}
