// dsh-balance-monitor — host half.
//
// One RPC channel (/balances) serves the sidebar card. It answers several
// actions on that single channel:
//
//   snapshot     per-provider snapshots + which modes each vendor offers
//   setMode      one-click Coding Plan <-> API switch (persisted)
//   setEnabled   hide / show a vendor
//   saveCustom   add or edit a generic custom provider
//   removeCustom delete a custom provider
//   usage        token-activity dashboard data, from DSH's own session logs
//
// Two kinds of data source:
//   * vendor HTTP endpoints (balance / quota / cost) — keys are resolved host
//     side (env, then $DSH_HOME/.credentials.yaml) and never cross the wire;
//     the browser only sees numbers.
//   * local measurement — several vendors (智谱 API 按量、百炼、方舟、MiMo、
//     B.ai …) publish no balance endpoint at all, so for those we report what
//     DSH actually measured in its session logs instead of nothing.
//
// Config: $DSH_HOME/balance-monitor.config.json
//   { "platforms": { "<id>": { "enabled": true, "label": "…", "mode": "coding" } },
//     "custom": [ { id, label, keyEnv, baseUrl, path, auth, kind, currency, pick } ] }

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { PROVIDERS, inferMode, matchVendor, pickPath, tightestWindow } from './providers.js'
import { createUsageTracker } from './usage.js'

export const name = 'dsh-balance-monitor'
export const inject = ['connection', 'tools']

const CREDENTIALS_FILE = '.credentials.yaml'
const CONFIG_FILE = 'balance-monitor.config.json'
const STATE_FILE = 'balance-monitor.json'
const USAGE_CACHE_FILE = 'balance-monitor-usage.json'
const TIMEOUT_MS = 12_000

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null)
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null)

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function today(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + mm + '-' + dd
}

// ---------- credentials & config ----------

async function readCredentialMap() {
  const map = {}
  try {
    const yaml = await readFile(join(dshHome(), CREDENTIALS_FILE), 'utf8')
    for (const line of yaml.split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i > 0) {
        const key = line.slice(0, i).trim()
        const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
        if (key && val && !key.includes(' ')) map[key] = val
      }
    }
  } catch {
    // no credentials file yet
  }
  return map
}

const getKey = (name, creds) => process.env[name] ?? creds[name] ?? null

async function readConfig() {
  try {
    const raw = JSON.parse(await readFile(join(dshHome(), CONFIG_FILE), 'utf8'))
    return {
      platforms: raw && typeof raw.platforms === 'object' ? raw.platforms : {},
      custom: Array.isArray(raw && raw.custom) ? raw.custom : [],
    }
  } catch {
    return { platforms: {}, custom: [] }
  }
}

/** Store (or replace) one `NAME: value` line in $DSH_HOME/.credentials.yaml. */
async function writeCredential(name, value) {
  const file = join(dshHome(), CREDENTIALS_FILE)
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  const line = name + ': ' + JSON.stringify(value)
  const pattern = new RegExp('^' + name + '\\s*:.*$', 'm')
  const tail = text === '' || text.endsWith('\n') ? text : text + '\n'
  text = pattern.test(text) ? text.replace(pattern, () => line) : tail + line + '\n'
  await writeFile(file, text)
  return true
}

async function writeConfig(config) {
  try {
    await writeFile(join(dshHome(), CONFIG_FILE), JSON.stringify(config, null, 2))
  } catch (error) {
    console.error('[balance-monitor] config write failed:', error)
  }
}

// ---------- per-provider state (spend ledger) ----------

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(join(dshHome(), 'storages', STATE_FILE), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

async function saveState(state) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(join(dshHome(), 'storages', STATE_FILE), JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('[balance-monitor] state write failed:', error)
  }
}

// ---------- which providers does DSH itself talk to? ----------

function parseProviderBlocks(text) {
  const out = []
  let inLlm = false
  let inProviders = false
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (indent === 0) {
      inLlm = line.replace(/:.*$/, '') === 'llm-pi-ai'
      inProviders = false
      current = null
      continue
    }
    if (!inLlm) continue
    if (line === 'providers:' && indent <= 4) {
      inProviders = true
      continue
    }
    if (!inProviders) continue
    if (line.startsWith('- ')) continue
    if (indent <= 4 && line.endsWith(':')) {
      current = { id: line.slice(0, -1).trim(), apiKeyEnv: null, baseUrl: null, displayName: null }
      out.push(current)
      continue
    }
    if (!current || line.includes(':')) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const key = line.slice(0, i).trim()
      const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'baseURL' || key === 'baseUrl') current.baseUrl = value
      else if (key === 'apiKeyEnv') current.apiKeyEnv = value
      else if (key === 'displayName') current.displayName = value
    }
  }
  return out
}

async function readDshProviders() {
  const files = [join(dshHome(), 'settings.yaml')]
  try {
    const { readdir } = await import('node:fs/promises')
    const profiles = await readdir(join(dshHome(), 'profiles'), { withFileTypes: true })
    for (const entry of profiles) {
      if (entry.isDirectory()) files.push(join(dshHome(), 'profiles', entry.name, 'settings.yaml'))
    }
  } catch {
    // no profiles directory
  }
  const seen = new Map()
  for (const file of files) {
    try {
      for (const provider of parseProviderBlocks(await readFile(file, 'utf8'))) {
        if (!seen.has(provider.id)) seen.set(provider.id, provider)
      }
    } catch {
      // file absent
    }
  }
  return [...seen.values()]
}

// ---------- vendor HTTP call ----------

async function fetchMode(mode, apiKey, signal) {
  const headers = { Accept: 'application/json', ...(mode.headers || {}) }
  Object.assign(headers, mode.auth ? mode.auth(apiKey) : { Authorization: apiKey })
  let url = mode.baseUrl + mode.path
  if (mode.params) {
    const query = {}
    for (const [key, value] of Object.entries(mode.params)) query[key] = typeof value === 'function' ? value() : String(value)
    const qs = new URLSearchParams(query).toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
  }
  let timeout
  try {
    timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
  } catch {
    timeout = AbortSignal.timeout(TIMEOUT_MS)
  }
  const res = await fetch(url, { headers, signal: timeout })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const detail = body && (body.error?.message || body.message || body.msg || body.status_message || body.base_resp?.status_msg)
    throw new Error('HTTP ' + res.status + (detail ? ' · ' + String(detail).slice(0, 90) : text ? ' · ' + text.slice(0, 60) : ''))
  }
  if (!body) throw new Error('返回非 JSON')
  return body
}

/** Declarative field mapping for user-defined providers. */
function pickParser(pick, kind) {
  const map = pick && typeof pick === 'object' ? pick : {}
  const fallback = kind === 'quota'
    ? { usedPct: 'usage_percent', remaining: 'remaining', total: 'total', resetAt: 'reset_time', detail: 'plan' }
    : { remaining: 'balance', total: 'total_balance', available: 'available', detail: 'plan' }
  const paths = { ...fallback, ...map }
  return (body) => {
    const remaining = num(pickPath(body, paths.remaining))
    const total = num(pickPath(body, paths.total))
    const usedPct = num(pickPath(body, paths.usedPct))
    const resetRaw = num(pickPath(body, paths.resetAt))
    const detailRaw = pickPath(body, paths.detail)
    const availableRaw = paths.available ? pickPath(body, paths.available) : undefined
    if (remaining === null && total === null && usedPct === null) {
      throw new Error('按映射取不到数值，检查字段路径（如 data.balance）')
    }
    return {
      remaining,
      total,
      usedPct,
      resetAt: resetRaw && resetRaw < 1e12 ? resetRaw * 1000 : resetRaw,
      detail: typeof detailRaw === 'string' || typeof detailRaw === 'number' ? String(detailRaw) : null,
      available: availableRaw === undefined ? undefined : Boolean(availableRaw),
    }
  }
}

// ---------- row assembly ----------

function localSnapshot(row, usage, date) {
  const ids = row.dshIds && row.dshIds.length ? row.dshIds : row.aliases || []
  const matched = []
  let tokens = 0
  let req = 0
  let todayTokens = 0
  let todayReq = 0
  const activeDays = new Set()
  if (usage) {
    for (const entry of usage.providers) {
      const hit = ids.some((alias) => alias && (entry.id === alias || entry.id.includes(alias) || alias.includes(entry.id)))
      if (!hit) continue
      matched.push(entry.id)
      tokens += entry.tokens
      req += entry.req
      const days = usage.providerDays[entry.id] || {}
      for (const [date_, value] of Object.entries(days)) {
        if (value > 0) activeDays.add(date_)
        if (date_ === date) todayTokens += value
      }
    }
    todayReq = matched.length ? (usage.days.find((d) => d.date === date)?.req ?? 0) : 0
  }
  const known = matched.length > 0
  return {
    id: row.id,
    label: row.label,
    kind: 'local',
    type: 'local',
    mode: row.mode,
    modes: row.modes,
    currency: 'TOKEN',
    tokens,
    req,
    todayTokens,
    todayReq,
    activeDays: activeDays.size,
    firstDate: usage ? usage.firstDate : null,
    lastDate: usage ? usage.lastDate : null,
    detail: known ? matched.join(' · ') : null,
    pending: !usage,
    available: known,
    stale: false,
    note: row.note,
  }
}

function buildRows({ config, creds, dshProviders, usage }) {
  const claimed = new Map()
  const rows = []

  for (const provider of dshProviders) {
    const vendor = matchVendor(provider.baseUrl)
    if (vendor) {
      const list = claimed.get(vendor.id) || []
      list.push({ id: provider.id, baseUrl: provider.baseUrl })
      claimed.set(vendor.id, list)
      continue
    }
    // Unknown gateway (B.ai, a proxy, a self-hosted vLLM…): still worth
    // reporting, via local measurement keyed by the DSH provider id.
    const id = 'dsh:' + provider.id
    const override = config.platforms[id] || {}
    if (override.enabled === false) continue
    rows.push({
      id,
      label: override.label || provider.displayName || provider.id,
      keyEnv: provider.apiKeyEnv,
      kind: 'local',
      mode: 'api',
      modes: [{ id: 'api', label: 'DSH 实测' }],
      dshIds: [provider.id],
      aliases: [provider.id],
      note: '该服务商未开放余额 API，显示 DSH 本地实测用量',
      auto: true,
    })
  }

  for (const vendor of PROVIDERS) {
    const override = config.platforms[vendor.id] || {}
    if (override.enabled === false) continue
    const key = getKey(vendor.keyEnv, creds)
    const dsh = claimed.get(vendor.id) || []
    if (!key && !dsh.length) continue
    const modes = vendor.modes.map((mode) => ({ id: mode.id, label: mode.label, kind: mode.kind }))
    // Preference order: explicit user switch > whatever DSH is pointed at >
    // the first mode that can actually answer with the key we have.
    let mode = override.mode && vendor.modes.some((m) => m.id === override.mode) ? override.mode : null
    if (!mode && dsh.length) {
      const inferred = inferMode(dsh[0].baseUrl)
      if (vendor.modes.some((m) => m.id === inferred)) mode = inferred
    }
    if (!mode) mode = (key && vendor.modes.find((m) => m.kind !== 'local')) || vendor.modes.find((m) => m.kind === 'local') || vendor.modes[0]
    mode = typeof mode === 'string' ? mode : mode.id
    const spec = vendor.modes.find((m) => m.id === mode) || vendor.modes[0]
    rows.push({
      id: vendor.id,
      label: override.label || vendor.label,
      keyEnv: vendor.keyEnv,
      kind: spec.kind,
      mode: spec.id,
      modes,
      spec,
      dshIds: dsh.map((entry) => entry.id),
      aliases: spec.aliases || [vendor.id],
      note: spec.note,
      currency: spec.currency || 'CNY',
    })
  }

  for (const custom of config.custom) {
    if (!custom || !custom.id) continue
    const override = config.platforms[custom.id] || {}
    if (override.enabled === false) continue
    const kind = custom.kind === 'quota' ? 'quota' : 'balance'
    const spec = {
      id: 'api',
      label: custom.modeLabel || '自定义',
      kind,
      currency: custom.currency || 'CNY',
      baseUrl: String(custom.baseUrl || '').replace(/\/+$/, ''),
      path: custom.path || '/',
      auth: custom.auth === 'raw' ? (key) => ({ Authorization: key }) : custom.auth === 'x-api-key' ? (key) => ({ 'x-api-key': key }) : (key) => ({ Authorization: 'Bearer ' + key }),
      headers: custom.headers || null,
      params: null,
      parse: pickParser(custom.pick, kind),
    }
    rows.push({
      id: custom.id,
      label: override.label || custom.label || custom.id,
      keyEnv: custom.keyEnv || '',
      kind,
      mode: 'api',
      modes: [{ id: 'api', label: spec.label, kind }],
      spec,
      dshIds: [],
      aliases: [custom.id],
      custom: true,
      currency: spec.currency,
    })
  }

  return rows
}

async function snapshotRow(row, { creds, state, date, usage, signal }) {
  if (row.kind === 'local') return localSnapshot(row, usage, date)

  const base = {
    id: row.id,
    label: row.label,
    kind: row.kind,
    type: row.kind,
    mode: row.mode,
    modes: row.modes,
    currency: row.currency,
    custom: row.custom || false,
    auto: row.auto || false,
    note: row.note || null,
    dshIds: row.dshIds,
  }
  const apiKey = row.keyEnv ? getKey(row.keyEnv, creds) : null
  if (!apiKey) {
    return { ...base, remaining: null, total: null, spent: null, available: false, stale: false, error: '未配置 ' + (row.keyEnv || 'API Key') }
  }

  const ledgerKey = row.id + ':' + row.mode
  try {
    const raw = row.spec.parse(await fetchMode(row.spec, apiKey, signal))
    if (raw.error) return { ...base, remaining: null, total: null, spent: null, available: false, stale: false, error: raw.error }

    if (row.kind === 'cost') {
      const snap = {
        ...base,
        remaining: null,
        total: null,
        spent: round2(raw.spent ?? 0),
        spentLabel: raw.spentLabel || '近 30 天消耗',
        detail: raw.detail ?? null,
        available: raw.available !== false,
        stale: false,
      }
      state[ledgerKey] = { date, lastTotal: snap.spent, updatedAt: Date.now() }
      return snap
    }

    if (row.kind === 'quota') {
      const windows = (raw.windows || []).map((window) => ({
        ...window,
        usedPct: window.usedPct === null || window.usedPct === undefined ? null : Math.round(window.usedPct * 10) / 10,
      }))
      // A fresh 5-hour window means nothing when the weekly one is spent: the
      // headline is the *binding* window, and the countdown is when it clears.
      const tightest = tightestWindow(windows)
      const soonest = windows.reduce((min, window) => (window.resetAt && (!min || window.resetAt < min) ? window.resetAt : min), null)
      const worstPct = tightest ? tightest.usedPct ?? null : null
      const declared = raw.remaining === null || raw.remaining === undefined ? null : round2(raw.remaining)
      return {
        ...base,
        remaining: declared !== null ? declared : worstPct === null ? null : Math.round((100 - worstPct) * 10) / 10,
        total: raw.total ?? 100,
        spent: raw.spent != null ? round2(raw.spent) : worstPct,
        spentLabel: raw.spentLabel || (tightest ? tightest.label + '已用' : '已用'),
        detail: raw.detail ?? null,
        resetAt: raw.resetAt ?? (tightest && tightest.resetAt) ?? soonest,
        windows,
        available: raw.available !== false,
        stale: false,
      }
    }

    // balance — keep a per-day ledger so "今日已用" survives refills
    const remaining = round2(raw.remaining ?? raw.total)
    const stored = state[ledgerKey] || {}
    const sameDay = stored.date === date
    const dayStart = sameDay && typeof stored.dayStart === 'number' ? stored.dayStart : remaining
    const prevTotal = sameDay && typeof stored.lastTotal === 'number' ? stored.lastTotal : remaining
    let todaySpent = sameDay && typeof stored.spent === 'number' ? stored.spent : 0
    if (prevTotal > remaining) todaySpent += prevTotal - remaining
    todaySpent = round2(todaySpent)
    const baseline = Math.max(dayStart, remaining ?? 0)
    state[ledgerKey] = { date, dayStart: baseline, lastTotal: remaining, spent: todaySpent, updatedAt: Date.now() }
    const total = raw.total !== null && raw.total !== undefined ? round2(raw.total) : baseline
    return {
      ...base,
      remaining,
      total,
      spent: todaySpent,
      spentLabel: '今日已用',
      detail: raw.detail ?? null,
      resetAt: raw.resetAt ?? null,
      usedPct: raw.usedPct ?? null,
      available: raw.available !== false,
      stale: false,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stored = state[ledgerKey]
    if (stored && Number.isFinite(stored.lastTotal)) {
      return {
        ...base,
        remaining: row.kind === 'balance' ? stored.lastTotal : null,
        total: row.kind === 'balance' ? stored.dayStart : null,
        spent: stored.spent ?? null,
        spentLabel: row.kind === 'balance' ? '今日已用' : '近 30 天消耗',
        available: false,
        stale: true,
        error: message,
      }
    }
    return { ...base, remaining: null, total: null, spent: null, available: false, stale: true, error: message }
  }
}

/**
 * Every candidate row for the settings panel — including vendors with no key
 * and rows the user hid, which never reach buildRows().
 */
function listPlatforms({ config, creds, dshProviders }) {
  const claimed = new Map()
  const list = []

  for (const provider of dshProviders) {
    const vendor = matchVendor(provider.baseUrl)
    if (vendor) {
      if (!claimed.has(vendor.id)) claimed.set(vendor.id, [])
      claimed.get(vendor.id).push(provider.id)
      continue
    }
    const id = 'dsh:' + provider.id
    const override = config.platforms[id] || {}
    list.push({
      id,
      label: override.label || provider.displayName || provider.id,
      modes: [{ id: 'api', label: 'DSH 实测' }],
      mode: 'api',
      enabled: override.enabled !== false,
      hasKey: Boolean(provider.apiKeyEnv && getKey(provider.apiKeyEnv, creds)),
      auto: true,
    })
  }

  for (const vendor of PROVIDERS) {
    const override = config.platforms[vendor.id] || {}
    list.push({
      id: vendor.id,
      label: override.label || vendor.label,
      modes: vendor.modes.map((mode) => ({ id: mode.id, label: mode.label, kind: mode.kind })),
      mode: override.mode || null,
      enabled: override.enabled !== false,
      hasKey: Boolean(vendor.keyEnv && getKey(vendor.keyEnv, creds)),
      connected: (claimed.get(vendor.id) || []).length > 0,
    })
  }

  for (const custom of config.custom) {
    if (!custom || !custom.id) continue
    const override = config.platforms[custom.id] || {}
    list.push({
      id: custom.id,
      label: override.label || custom.label || custom.id,
      modes: [{ id: 'api', label: custom.modeLabel || '自定义' }],
      mode: 'api',
      enabled: override.enabled !== false,
      hasKey: Boolean(custom.keyEnv && getKey(custom.keyEnv, creds)),
      custom: true,
    })
  }

  return list
}

// ---------- plugin ----------

export function apply(ctx) {
  const tracker = createUsageTracker({
    dshHome: dshHome(),
    cacheFile: USAGE_CACHE_FILE,
    onError: (message) => console.error('[balance-monitor] ' + message),
  })

  async function buildSnapshot({ forceUsage, signal } = {}) {
    const [creds, config, state, dshProviders, usage] = await Promise.all([
      readCredentialMap(),
      readConfig(),
      loadState(),
      readDshProviders(),
      tracker.peek(forceUsage),
    ])
    const date = today()
    const rows = buildRows({ config, creds, dshProviders, usage })
    const snapshots = []
    for (const row of rows) snapshots.push(await snapshotRow(row, { creds, state, date, usage, signal }))
    await saveState(state)

    const hint = !snapshots.length
      ? '未配置任何平台 Key：在 $DSH_HOME/.credentials.yaml 里加入对应 API_KEY，或在 DSH 设置里接一个服务商'
      : null
    return {
      ok: true,
      value: snapshots,
      hint,
      meta: {
        date,
        usageReady: Boolean(usage),
        usageGeneratedAt: usage ? usage.generatedAt : null,
        dshProviders: dshProviders.map((provider) => ({ id: provider.id, baseUrl: provider.baseUrl, displayName: provider.displayName })),
        platforms: listPlatforms({ config, creds, dshProviders }),
      },
    }
  }

  async function mutateConfig(mutate) {
    const config = await readConfig()
    mutate(config)
    await writeConfig(config)
    return buildSnapshot()
  }

  const handleAction = async (payload, signal) => {
    const action = (payload && payload.action) || 'snapshot'
    try {
      if (action === 'setMode') {
        const id = String(payload.id || '')
        const mode = String(payload.mode || '')
        if (!id || !mode) throw new Error('setMode 需要 id 与 mode')
        return await mutateConfig((config) => {
          // Guard against a stale client offering a mode the row dropped.
          const vendor = PROVIDERS.find((entry) => entry.id === id)
          const custom = config.custom.find((entry) => entry && entry.id === id)
          const allowed = vendor ? vendor.modes.map((entry) => entry.id) : custom ? ['api'] : []
          if (!allowed.includes(mode)) throw new Error('未知模式：' + id + ' / ' + mode)
          config.platforms[id] = { ...(config.platforms[id] || {}), mode }
        })
      }
      if (action === 'setEnabled') {
        const id = String(payload.id || '')
        return await mutateConfig((config) => {
          config.platforms[id] = { ...(config.platforms[id] || {}), enabled: payload.enabled !== false }
        })
      }
      if (action === 'setLabel') {
        const id = String(payload.id || '')
        const label = String(payload.label || '').slice(0, 24)
        return await mutateConfig((config) => {
          config.platforms[id] = { ...(config.platforms[id] || {}), label }
        })
      }
      if (action === 'saveCustom') {
        const input = payload.provider || {}
        const baseUrl = String(input.baseUrl || '').trim()
        if (!/^https?:\/\/.+/.test(baseUrl)) throw new Error('baseURL 需形如 https://api.example.com')
        const label = String(input.label || '').trim().slice(0, 24) || baseUrl.replace(/^https?:\/\//, '').split('/')[0]
        const id = String(input.id || '').trim() || 'custom-' + label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '')
        const provider = {
          id,
          label,
          keyEnv: String(input.keyEnv || '').trim().toUpperCase() || id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY',
          baseUrl: baseUrl.replace(/\/+$/, ''),
          path: String(input.path || '/').trim() || '/',
          auth: ['bearer', 'raw', 'x-api-key'].includes(input.auth) ? input.auth : 'bearer',
          kind: input.kind === 'quota' ? 'quota' : 'balance',
          currency: String(input.currency || 'CNY').slice(0, 4).toUpperCase(),
          modeLabel: String(input.modeLabel || '自定义').slice(0, 16),
          pick: input.pick && typeof input.pick === 'object' ? input.pick : null,
          headers: input.headers && typeof input.headers === 'object' ? input.headers : null,
        }
        if (input.apiKey) await writeCredential(provider.keyEnv, String(input.apiKey))
        return await mutateConfig((config) => {
          const index = config.custom.findIndex((entry) => entry && entry.id === provider.id)
          if (index >= 0) config.custom[index] = provider
          else config.custom.push(provider)
          config.platforms[provider.id] = { ...(config.platforms[provider.id] || {}), enabled: true }
        })
      }
      if (action === 'removeCustom') {
        const id = String(payload.id || '')
        return await mutateConfig((config) => {
          config.custom = config.custom.filter((entry) => entry && entry.id !== id)
          delete config.platforms[id]
        })
      }
      if (action === 'usage') {
        const usage = payload.force ? await tracker.now() : await tracker.peek(true)
        return { ok: true, value: usage || (await tracker.now()) }
      }
      return await buildSnapshot({ forceUsage: Boolean(payload && payload.forceUsage), signal })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'internal', message: action + ' failed: ' + message, details: {} } }
    }
  }

  ctx.connection.rpc.handle('/balances', (_endpoint, payload, signal) => handleAction(payload, signal), { authority: 'loopback' })

  // ---------- agent-facing configuration ----------
  // The card has no settings UI on purpose: the user says what they want in one
  // sentence, the agent performs it here. Same actions as the RPC, compact output.
  const valueOf = (row) => {
    if (!row) return null
    if (row.error) return row.error
    if (row.kind === 'local' || row.tokens != null) return row.tokens + ' tokens'
    if (row.kind === 'cost') return (row.spent != null ? row.spent : row.remaining) + (row.currency ? ' ' + row.currency : '')
    if (row.remaining != null) return row.remaining + (row.currency ? ' ' + row.currency : '')
    return null
  }

  const digest = (result) => {
    if (!result || result.ok !== true) {
      return { ok: false, error: result && result.error ? result.error.message : 'failed' }
    }
    const rows = Array.isArray(result.value) ? result.value : []
    const byId = new Map(rows.map((row) => [row.id, row]))
    const meta = result.meta || {}
    return {
      ok: true,
      date: meta.date || null,
      platforms: (meta.platforms || []).map((platform) => {
        const row = byId.get(platform.id)
        return {
          id: platform.id,
          label: platform.label,
          shown: platform.enabled !== false,
          hasKey: Boolean(platform.hasKey),
          mode: row && row.mode ? row.mode : platform.mode,
          modes: (platform.modes || []).map((mode) => mode.id + '=' + mode.label).join(' | '),
          value: valueOf(row),
        }
      }),
      hint: result.hint || null,
    }
  }

  const usageDigest = (result) => {
    const usage = result && result.ok === true ? result.value : null
    if (!usage) return { ok: false, error: result && result.error ? result.error.message : 'no usage data' }
    const days = Array.isArray(usage.days) ? usage.days : []
    return {
      ok: true,
      range: (usage.firstDate || '?') + ' -> ' + (usage.lastDate || '?'),
      activeDays: usage.activeDays,
      totals: usage.totals,
      peak: usage.peak,
      streaks: usage.streaks,
      providers: usage.providers,
      models: usage.models,
      last14: days.slice(-14).map((day) => ({ date: day.date, tokens: day.tokens, req: day.req, turns: day.turns })),
      note: 'tokens = input + output; cache reads and reasoning tokens excluded',
    }
  }

  const runTool = async (args, exec) => {
    const input = args || {}
    const action = String(input.action || 'status')
    const signal = exec && exec.signal
    if (action === 'status') return digest(await handleAction({ action: 'snapshot' }, signal))
    if (action === 'refresh') return digest(await handleAction({ action: 'snapshot', forceUsage: true }, signal))
    if (action === 'usage') return usageDigest(await handleAction({ action: 'usage', force: Boolean(input.force) }, signal))
    if (action === 'setCredential') {
      const name = String(input.name || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '')
      if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name) || !input.value) return { ok: false, error: 'setCredential 需要 name 与 value' }
      await writeCredential(name, String(input.value))
      return { ok: true, credential: name, stored: true }
    }
    if (action === 'addCustom') return digest(await handleAction({ action: 'saveCustom', provider: input.provider || {} }, signal))
    return digest(await handleAction({ action, id: input.id, mode: input.mode, enabled: input.enabled, label: input.label }, signal))
  }

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    try {
      ctx.tools.register({
        name: 'balance_monitor',
        description:
          '侧边栏「余额」卡片的配置入口。卡片上没有设置界面，一切由你代劳：status 查询各平台余额/配额/用量与当前计费方式；refresh 强制重新拉取；' +
          'setMode {id, mode} 在同一厂商的 Coding Plan 与 API 按量之间切换；setEnabled {id, enabled} 显示或隐藏某平台；setLabel {id, label} 改名；' +
          'addCustom {provider:{label,baseUrl,path,auth,kind,currency,modeLabel,keyEnv,apiKey,pick}} 接入任意 OpenAI 兼容厂商（apiKey 写入 $DSH_HOME/.credentials.yaml）；' +
          'removeCustom {id} 删除自定义厂商；setCredential {name, value} 保存或更新一个密钥；usage 读取本机 Token 用量统计。' +
          '用户说「我想用某家的 API」「换成套餐」「接一个新平台」「这个月用了多少 token」时直接调用本工具完成，不要让用户去点设置。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'refresh', 'setMode', 'setEnabled', 'setLabel', 'addCustom', 'removeCustom', 'setCredential', 'usage'] },
            id: { type: 'string', description: '平台 id：deepseek / zhipu / custom-xxx / dsh:<provider-id>' },
            mode: { type: 'string', description: 'setMode 的目标计费方式 id（见 status 返回的 modes）' },
            enabled: { type: 'boolean', description: 'setEnabled：是否显示在卡片上' },
            label: { type: 'string', description: 'setLabel：卡片上显示的名字（最长 24 字）' },
            force: { type: 'boolean', description: 'usage：重新扫描会话日志' },
            name: { type: 'string', description: 'setCredential：环境变量名，如 DEEPSEEK_API_KEY' },
            value: { type: 'string', description: 'setCredential：密钥值，只写入凭据文件、不回显' },
            provider: { type: 'object', description: 'addCustom：{label,baseUrl,path,auth,kind,currency,modeLabel,keyEnv,apiKey,pick}' },
          },
          required: ['action'],
          additionalProperties: true,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: runTool,
      })
    } catch (error) {
      console.error('[balance-monitor] tool registration failed:', error)
    }
  }
}
