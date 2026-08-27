// dsh-balance-monitor — provider registry.
//
// One vendor can sell two very different things: a **Coding Plan** (a
// subscription with rolling 5-hour / weekly windows) and plain **API** access
// (a cash balance, or per-token billing with no public balance endpoint at
// all). Each entry therefore declares `modes`; the sidebar lets you flip
// between them with one click and remembers the choice.
//
// kind:
//   balance — money left on the account (vendor HTTP endpoint)
//   quota   — subscription windows with a reset time (vendor HTTP endpoint)
//   cost    — rolling 30-day spend report (vendor HTTP endpoint)
//   local   — no vendor endpoint exists; report what DSH actually measured in
//             its own session logs (tokens / requests / active days)

// ---------- small parse helpers ----------

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v !== '' && isFinite(Number(v)) ? Number(v) : null)

/** Resolve "data.limits.0.detail.remaining" against a parsed JSON body. */
export function pickPath(body, path) {
  if (!path) return undefined
  let cursor = body
  for (const part of String(path).split('.')) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[part]
  }
  return cursor
}

// Rolling windows are ranked so the shortest (most actionable) one leads.
const WINDOW_RANK = [['5 小时', 0], ['每天', 1], ['本周', 2], ['每周', 2], ['每月', 3], ['工具', 4]]

export function sortWindows(windows) {
  const rank = (label) => {
    for (const [needle, value] of WINDOW_RANK) if (String(label || '').includes(needle)) return value
    return 9
  }
  return windows.sort((a, b) => rank(a.label) - rank(b.label) || (a.resetAt || Infinity) - (b.resetAt || Infinity))
}

/** The window that actually blocks you: highest usage, ties to the soonest reset. */
export function tightestWindow(windows) {
  let best = null
  for (const window of windows || []) {
    if (!window) continue
    const used = window.usedPct ?? 0
    const bestUsed = best ? best.usedPct ?? 0 : -1
    if (used > bestUsed) best = window
  }
  return best
}

function pct(used, total) {
  if (total === null || total === undefined || total === 0) return null
  const ratio = (Number(used) || 0) / Number(total)
  return Math.max(0, Math.min(100, Math.round(ratio * 1000) / 10))
}

// ---------- vendor parsers ----------

function parseDeepSeek(body) {
  const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : []
  const total = infos.reduce((sum, info) => sum + (num(info && info.total_balance) || 0), 0)
  const granted = infos.reduce((sum, info) => sum + (num(info && info.granted_balance) || 0), 0)
  if (!infos.length) {
    const flat = num(body && body.balance) ?? num(body && body.total_balance)
    if (flat === null) return { error: '响应格式变化' }
    return { remaining: flat, total: flat }
  }
  const currency = (infos[0] && infos[0].currency) || 'CNY'
  return {
    remaining: total,
    total,
    currency,
    detail: null,
    available: body && body.is_available === undefined ? undefined : Boolean(body.is_available),
  }
}

// Zhipu / Z.ai report Coding Plan windows as TOKENS_LIMIT, CREDIT_LIMIT or
// TIME_LIMIT entries keyed by `unit` — 3 = rolling 5 hours, 6 = rolling week.
const ZHIPU_UNITS = { 3: '5 小时窗口', 6: '本周窗口', 1: '每月窗口', 2: '每天窗口' }

function parseZhipuQuota(body) {
  const limits = (body && body.data && Array.isArray(body.data.limits) && body.data.limits) || (Array.isArray(body && body.limits) ? body.limits : [])
  if (!limits.length) {
    if (body && body.success === false) return { detail: '未订阅 Coding Plan' }
    return { error: '无配额数据（未订阅 Coding Plan？）' }
  }
  const level = (body && body.data && body.data.level) || (body && body.level) || ''
  const windows = []
  for (const limit of limits) {
    const total = num(limit.total) ?? num(limit.usage) ?? num(limit.quota)
    const used = num(limit.currentValue) ?? num(limit.used) ?? 0
    const remaining = num(limit.remaining) ?? (total === null ? null : total - used)
    const usedPct = num(limit.percentage) !== null ? Math.max(0, Math.min(100, num(limit.percentage))) : pct(used, total)
    const label = ZHIPU_UNITS[num(limit.unit)] || (limit.type === 'TIME_LIMIT' ? '工具调用窗口' : '窗口 ' + (limit.unit ?? '?'))
    windows.push({
      label,
      usedPct,
      used,
      remaining,
      total,
      resetAt: num(limit.nextResetTime) || num(limit.resetTime) || null,
      unit: limit.type === 'CREDIT_LIMIT' ? '积分' : limit.type === 'TIME_LIMIT' ? '次' : 'tokens',
    })
  }
  sortWindows(windows)
  const tightest = tightestWindow(windows)
  return {
    windowMode: true,
    windows,
    detail: [
      level ? '套餐 ' + String(level).toUpperCase() : null,
      tightest && tightest.total != null
        ? tightest.label + '剩 ' + Math.round(tightest.remaining ?? 0) + '/' + Math.round(tightest.total) + ' ' + (tightest.unit || '')
        : null,
    ]
      .filter(Boolean)
      .join(' · ') || null,
  }
}

// Kimi For Coding: limits[] = rolling 5h, usage = rolling week.
function parseKimiCoding(body) {
  const windows = []
  const limits = Array.isArray(body && body.limits) ? body.limits : []
  for (const limit of limits) {
    const detail = limit.detail || limit
    const total = num(detail.limit)
    const remaining = num(detail.remaining)
    if (total === null && remaining === null) continue
    windows.push({
      label: limit.type === 'WEEKLY' || limit.type === 'week' ? '本周窗口' : '5 小时窗口',
      usedPct: pct(total - (remaining ?? 0), total),
      remaining,
      total,
      resetAt: num(detail.resetTime) || null,
      unit: 'tokens',
    })
  }
  const weekly = (body && body.usage) || {}
  if (num(weekly.limit) !== null) {
    windows.push({
      label: '本周窗口',
      usedPct: pct(num(weekly.limit) - (num(weekly.remaining) ?? 0), num(weekly.limit)),
      remaining: num(weekly.remaining),
      total: num(weekly.limit),
      resetAt: num(weekly.resetTime) || null,
      unit: 'tokens',
    })
  }
  if (!windows.length) return { error: '无配额数据（未订阅 Kimi Coding？）' }
  sortWindows(windows)
  return { windowMode: true, windows }
}

// MiniMax coding plan: model_remains[] with a 5h interval plus a weekly rollup.
function parseMiniMaxCoding(body) {
  const rows = Array.isArray(body && body.model_remains) ? body.model_remains : []
  const row = rows.find((r) => r && r.model_name === 'general') || rows[0]
  if (!row) return { error: body && body.base_resp && body.base_resp.status_msg ? String(body.base_resp.status_msg) : '无配额数据' }
  const windows = []
  const intervalPct = num(row.current_interval_used_percent) ?? (num(row.current_interval_remaining_percent) !== null ? 100 - num(row.current_interval_remaining_percent) : null)
  if (intervalPct !== null) {
    windows.push({ label: '5 小时窗口', usedPct: Math.max(0, Math.min(100, intervalPct)), resetAt: num(row.end_time) || null, unit: '次' })
  }
  if (num(row.current_weekly_status) === 1 || num(row.current_weekly_used_percent) !== null || num(row.current_weekly_remaining_percent) !== null) {
    const weeklyPct = num(row.current_weekly_used_percent) ?? (num(row.current_weekly_remaining_percent) !== null ? 100 - num(row.current_weekly_remaining_percent) : null)
    windows.push({ label: '本周窗口', usedPct: weeklyPct, resetAt: num(row.weekly_end_time) || null, unit: '次' })
  }
  if (!windows.length) return { error: '无配额数据' }
  sortWindows(windows)
  return {
    windowMode: true,
    windows,
    detail: row.start_time ? '本周期 ' + new Date(row.start_time).toLocaleDateString('zh-CN') : null,
  }
}

function parseMoonshotBalance(body) {
  const data = (body && body.data) || body || {}
  const remaining = num(data.available_balance) ?? num(data.balance)
  const total = num(data.total_balance) ?? remaining
  if (remaining === null) return { error: '无余额数据' }
  return {
    remaining,
    total,
    currency: 'CNY',
    detail: null,
    available: data.is_active === undefined ? undefined : Boolean(data.is_active),
  }
}

function parseStepFunBalance(body) {
  const data = (body && body.data) || body || {}
  const remaining = num(data.available_balance) ?? num(data.balance)
  const total = num(data.total_balance) ?? remaining
  if (remaining === null) return { error: '无余额数据' }
  return { remaining, total, currency: 'CNY', detail: '总额 ' + (total ?? 0).toFixed(2) }
}

function parseXaiCredits(body) {
  const data = (body && body.data) || body || {}
  const credits = num(data.credits) ?? num(data.remaining_credits) ?? num(data.balance)
  if (credits === null) return { error: '无额度数据' }
  const limit = num(data.limit) ?? num(data.monthly_limit)
  return {
    remaining: credits,
    total: limit === null ? credits : limit,
    currency: 'USD',
    detail: data.name ? 'Key ' + data.name : null,
  }
}

function parseOpenRouter(body) {
  const data = (body && body.data) || body || {}
  const credits = num(data.total_credits)
  const usage = num(data.total_usage)
  if (credits === null && usage === null) return { error: '无额度数据' }
  const remaining = credits === null ? null : credits - (usage || 0)
  return {
    remaining,
    total: credits,
    currency: 'USD',
    detail: usage === null ? null : '已消耗 $' + usage.toFixed(2),
  }
}

function parseSiliconFlow(body) {
  const data = (body && body.data) || body || {}
  const remaining = num(data.balance) ?? num(data.totalBalance) ?? num(data.total_balance)
  const total = num(data.totalBalance) ?? num(data.total_balance) ?? num(data.balance)
  if (remaining === null) return { error: '无余额数据' }
  const granted = num(data.grantedBalance) ?? num(data.granted_balance)
  return {
    remaining,
    total,
    currency: 'CNY',
    detail: null,
  }
}

// OpenAI / Anthropic only expose a rolling report — surface it as spend, not
// as a balance, so the bar never lies about what is left.
function parseCostReport(body) {
  const results = (body && body.results) || (body && body.data && body.data.results) || []
  let cost = 0
  let seen = false
  const lines = []
  for (const row of results) {
    const value = num(row && (row.cost ?? (row.results && row.results.total_cost)))
    if (value === null) continue
    seen = true
    cost += value
    const label = (row && (row.group_id || row.line_item || row.name)) || ''
    if (label) lines.push(label + ' $' + value.toFixed(2))
  }
  const flat = num(body && (body.total_cost || (body.data && body.data.total_cost)))
  if (!seen && flat !== null) {
    cost = flat
    seen = true
  }
  if (!seen) return { error: '无用量数据' }
  return {
    costMode: true,
    remaining: null,
    total: null,
    spent: cost,
    spentLabel: '近 30 天消耗',
    currency: 'USD',
    detail: lines.length ? lines.slice(0, 2).join(' · ') : null,
  }
}

// ---------- registry ----------

const bearer = (key) => ({ Authorization: 'Bearer ' + key })

export const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    hosts: ['api.deepseek.com'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'balance',
        currency: 'CNY',
        baseUrl: 'https://api.deepseek.com',
        path: '/user/balance',
        auth: bearer,
        parse: parseDeepSeek,
      },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    keyEnv: 'ZHIPU_API_KEY',
    hosts: ['open.bigmodel.cn'],
    modes: [
      {
        id: 'coding',
        label: 'Coding Plan',
        kind: 'quota',
        baseUrl: 'https://open.bigmodel.cn',
        path: '/api/monitor/usage/quota/limit',
        auth: bearer,
        parse: parseZhipuQuota,
      },
      {
        id: 'api',
        label: 'API 按量',
        kind: 'local',
        note: '智谱未开放余额 API，这里显示 DSH 本地实测用量',
        aliases: ['zhipu', 'glm', 'bigmodel', 'zhipu-coding'],
      },
    ],
  },
  {
    id: 'zai',
    label: 'Z.ai (GLM 国际站)',
    keyEnv: 'ZAI_API_KEY',
    hosts: ['api.z.ai'],
    modes: [
      {
        id: 'coding',
        label: 'Coding Plan',
        kind: 'quota',
        baseUrl: 'https://api.z.ai',
        path: '/api/monitor/usage/quota/limit',
        auth: bearer,
        parse: parseZhipuQuota,
      },
      {
        id: 'api',
        label: 'API 按量',
        kind: 'local',
        note: 'Z.ai 未开放余额 API，这里显示 DSH 本地实测用量',
        aliases: ['zai', 'z-ai', 'zdotai'],
      },
    ],
  },
  {
    id: 'moonshot',
    label: 'Kimi / 月之暗面',
    keyEnv: 'MOONSHOT_API_KEY',
    hosts: ['api.moonshot.cn', 'api.moonshot.ai', 'api.kimi.com'],
    modes: [
      {
        id: 'coding',
        label: 'Kimi Code',
        kind: 'quota',
        baseUrl: 'https://api.kimi.com',
        path: '/coding/v1/usages',
        auth: bearer,
        parse: parseKimiCoding,
      },
      {
        id: 'api',
        label: 'API 按量',
        kind: 'balance',
        currency: 'CNY',
        baseUrl: 'https://api.moonshot.cn',
        path: '/v1/users/me/balance',
        auth: bearer,
        parse: parseMoonshotBalance,
        aliases: ['moonshot', 'kimi'],
      },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    keyEnv: 'MINIMAX_API_KEY',
    hosts: ['api.minimaxi.com', 'api.minimax.chat', 'api.minimax.io'],
    modes: [
      {
        id: 'coding',
        label: 'Coding Plan',
        kind: 'quota',
        baseUrl: 'https://api.minimaxi.com',
        path: '/v1/token_plan/remains',
        auth: bearer,
        params: { Page: 1, PageSize: 20 },
        parse: parseMiniMaxCoding,
      },
      {
        id: 'api',
        label: 'API 按量',
        kind: 'local',
        note: 'MiniMax 余额只在控制台可见，这里显示 DSH 本地实测用量',
        aliases: ['minimax', 'minimaxi'],
      },
    ],
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    keyEnv: 'STEPFUN_API_KEY',
    hosts: ['api.stepfun.com', 'api.stepfun.ai'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'balance',
        currency: 'CNY',
        baseUrl: 'https://api.stepfun.com',
        path: '/v1/accounts',
        auth: bearer,
        parse: parseStepFunBalance,
        aliases: ['stepfun', 'step'],
      },
    ],
  },
  {
    id: 'dashscope',
    label: '阿里百炼 Qwen',
    keyEnv: 'DASHSCOPE_API_KEY',
    hosts: ['dashscope.aliyuncs.com', 'coding.dashscope.aliyuncs.com'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'local',
        note: '百炼余额无公开 API，这里显示 DSH 本地实测用量',
        aliases: ['dashscope', 'qwen', 'aliyun', 'bailian'],
      },
    ],
  },
  {
    id: 'volcengine',
    label: '火山方舟 Doubao',
    keyEnv: 'ARK_API_KEY',
    hosts: ['ark.cn-beijing.volces.com'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'local',
        note: '方舟余额查询需 AK/SK 签名，这里显示 DSH 本地实测用量',
        aliases: ['volcengine', 'ark', 'doubao', 'volces'],
      },
    ],
  },
  {
    id: 'xiaomi',
    label: '小米 MiMo',
    keyEnv: 'XIAOMI_API_KEY',
    hosts: ['api.xiaomi.com', 'token-plan-sgp.xiaomimimo.com', 'mimo.xiaomi.com'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'local',
        note: 'MiMo 无公开余额 API，这里显示 DSH 本地实测用量',
        aliases: ['xiaomi', 'mimo', 'mimocode'],
      },
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    keyEnv: 'SILICONFLOW_API_KEY',
    hosts: ['api.siliconflow.cn', 'api.siliconflow.com'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'balance',
        currency: 'CNY',
        baseUrl: 'https://api.siliconflow.cn',
        path: '/v1/user/info',
        auth: bearer,
        parse: parseSiliconFlow,
        aliases: ['siliconflow'],
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    hosts: ['openrouter.ai'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'balance',
        currency: 'USD',
        baseUrl: 'https://openrouter.ai',
        path: '/api/v1/credits',
        auth: bearer,
        parse: parseOpenRouter,
        aliases: ['openrouter'],
      },
    ],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    keyEnv: 'XAI_API_KEY',
    hosts: ['api.x.ai'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'balance',
        currency: 'USD',
        baseUrl: 'https://api.x.ai',
        path: '/v1/api-key',
        auth: bearer,
        parse: parseXaiCredits,
        aliases: ['xai', 'x-ai', 'grok'],
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    hosts: ['api.openai.com'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'cost',
        currency: 'USD',
        baseUrl: 'https://api.openai.com',
        path: '/v1/usage/cost/v1/reports',
        auth: bearer,
        params: {
          start_date: () => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
          end_date: () => new Date().toISOString().slice(0, 10),
          bucket_width: 'day',
          group_by: 'project',
        },
        parse: parseCostReport,
        aliases: ['openai', 'chatgpt'],
      },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    hosts: ['api.anthropic.com'],
    modes: [
      {
        id: 'api',
        label: 'API 按量',
        kind: 'cost',
        currency: 'USD',
        baseUrl: 'https://api.anthropic.com',
        path: '/v1/cost_report/s3_report_url',
        auth: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
        parse: parseCostReport,
        aliases: ['anthropic', 'claude'],
      },
    ],
  },
]

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]))

/** Host fragment -> registry entry, used to recognise DSH's own providers. */
export function matchVendor(baseUrl) {
  const url = String(baseUrl || '').toLowerCase()
  if (!url) return null
  for (const provider of PROVIDERS) {
    for (const host of provider.hosts || []) {
      if (url.includes(host)) return provider
    }
  }
  return null
}

/** Coding-plan URLs are recognisable by their path; everything else is API. */
export function inferMode(baseUrl) {
  const url = String(baseUrl || '').toLowerCase()
  if (/coding|\/claude|anthropic|\/paas\/coding/.test(url)) return 'coding'
  return 'api'
}
