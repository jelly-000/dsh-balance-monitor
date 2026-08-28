// dsh-balance-monitor — local token-activity scanner.
//
// Reads DSH's own session logs ($DSH_HOME/sessions/<workspace>/<session>/
// session.jsonl.zstd) and aggregates what this machine actually burned:
// per-day tokens, requests, turns and chat wall-time, plus a per-provider /
// per-model breakdown taken from the request/header events that precede each
// assistant message.
//
// Decoding note: DSH writes these logs as a *concatenation of many small zstd
// frames* (one per flush). Node's zstd bindings stop at the first frame, so we
// split on the frame magic (28 B5 2F FD) and inflate slice by slice — that
// reproduces `zstd -dc` line for line.
//
// Cost control: every file is fingerprinted by size+mtime and its aggregate is
// cached on disk, so a poll only re-reads logs that actually changed. The scan
// runs in the background and never blocks the RPC reply.

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const REFRESH_MS = 60_000
/** Silence longer than this ends a "chat stretch". */
const IDLE_GAP_MS = 30 * 60_000
const LOG_NAMES = ['session.jsonl.zstd', 'session.jsonl']

// ---------- helpers ----------

function localDate(ms) {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

function addDay(days, date) {
  let day = days[date]
  if (!day) {
    day = days[date] = { date, in: 0, out: 0, cache: 0, reason: 0, req: 0, turns: 0, chatMs: 0 }
  }
  return day
}

function bumpDay(day, usage) {
  day.in += Number(usage.inputTokens) || 0
  day.out += Number(usage.outputTokens) || 0
  day.cache += Number(usage.cacheReadTokens) || 0
  day.reason += Number(usage.reasoningTokens) || 0
  day.req += 1
}

function bumpBucket(bucket, key, date, usage) {
  let bucket_ = bucket[key]
  if (!bucket_) {
    bucket_ = bucket[key] = { tokens: 0, in: 0, out: 0, cache: 0, reason: 0, req: 0, days: {} }
  }
  const inTok = Number(usage.inputTokens) || 0
  const outTok = Number(usage.outputTokens) || 0
  bucket_.tokens += inTok + outTok
  bucket_.in += inTok
  bucket_.out += outTok
  bucket_.cache += Number(usage.cacheReadTokens) || 0
  bucket_.reason += Number(usage.reasoningTokens) || 0
  bucket_.req += 1
  bucket_.days[date] = (bucket_.days[date] || 0) + inTok + outTok
}

/** Split a multi-frame zstd buffer and inflate every frame. */
function inflateFrames(buf) {
  const out = []
  const starts = []
  for (let at = buf.indexOf(MAGIC, 0); at >= 0; at = buf.indexOf(MAGIC, at + 4)) starts.push(at)
  if (!starts.length) return out
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(from, to)))
    } catch {
      // A payload that happens to contain the magic bytes splits a frame in
      // two; retry against the whole tail so nothing is dropped.
      try {
        out.push(zlib.zstdDecompressSync(buf.subarray(from)))
      } catch {
        /* genuinely undecodable — skip */
      }
    }
  }
  return out
}

async function readLog(path) {
  const raw = await readFile(path)
  if (path.endsWith('.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') return null
    return Buffer.concat(inflateFrames(raw)).toString('utf8')
  }
  return raw.toString('utf8')
}

async function listLogs(sessionsDir) {
  const found = []
  let workspaces = []
  try {
    workspaces = await readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsDir = join(sessionsDir, ws.name)
    let sessions = []
    try {
      sessions = await readdir(wsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      for (const name of LOG_NAMES) {
        const file = join(wsDir, s.name, name)
        try {
          const st = await stat(file)
          if (st.isFile() && st.size > 0) {
            found.push({ path: file, size: st.size, mtimeMs: Math.round(st.mtimeMs), session: s.name })
          }
        } catch {
          /* not present — fine */
        }
      }
    }
  }
  return found
}

// ---------- one log -> aggregate ----------

function aggregate(text) {
  const days = {}
  const providers = {}
  const models = {}
  // Per-model × per-day in/out/cache cells, so the client can slice any
  // recent window (7d/30d) without re-reading the logs.
  const modelDay = {}
  const openTurns = new Map()
  let current = { provider: 'unknown', model: 'unknown' }
  let longestTurnMs = 0
  let lastTime = 0
  let lines = 0
  // Longest *continuous* chat stretch: events further apart than the idle gap
  // start a new stretch, so a session resumed over three days is not counted
  // as one 80-hour conversation.
  let runStart = 0
  let bestRun = { ms: 0, date: null }

  for (const line of text.split('\n')) {
    if (!line || line.length < 12) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    lines++
    const time = typeof event.time === 'number' ? event.time : 0
    if (time) {
      if (lastTime && time - lastTime <= IDLE_GAP_MS) {
        const ms = time - runStart
        if (ms > bestRun.ms) bestRun = { ms, date: localDate(time) }
      } else {
        runStart = time
      }
      lastTime = time
    }
    const data = event.data || {}

    if (event.type === 'request/header') {
      const cfg = (data.header && data.header.config) || {}
      if (cfg.provider || cfg.model) {
        current = { provider: String(cfg.provider || 'unknown'), model: String(cfg.model || 'unknown') }
      }
    } else if (event.type === 'assistant/message') {
      const usage = data.usage
      if (!usage || !time) continue
      const date = localDate(time)
      const day = addDay(days, date)
      bumpDay(day, usage)
      // Attribution ground truth: every message carries its own provider/model
      // in data.message.source; fall back to the last request/header config.
      const src = (data.message && data.message.source) || {}
      const provider = String(src.provider || current.provider)
      const model = String(src.model || current.model)
      const tokens = (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
      bumpBucket(providers, provider, date, usage)
      const modelKey = model + '@' + provider
      bumpBucket(models, modelKey, date, usage)
      let perModel = modelDay[modelKey]
      if (!perModel) perModel = modelDay[modelKey] = {}
      let cell = perModel[date]
      if (!cell) cell = perModel[date] = { i: 0, o: 0, c: 0 }
      cell.i += Number(usage.inputTokens) || 0
      cell.o += Number(usage.outputTokens) || 0
      cell.c += Number(usage.cacheReadTokens) || 0
    } else if (event.type === 'turn/start') {
      if (time) openTurns.set(data.turn ?? 0, time)
    } else if (event.type === 'turn/end') {
      const started = openTurns.get(data.turn ?? 0)
      openTurns.delete(data.turn ?? 0)
      if (!time) continue
      const date = localDate(time)
      const day = addDay(days, date)
      day.turns += 1
      if (started) {
        const ms = Math.max(0, time - started)
        day.chatMs += ms
        if (ms > longestTurnMs) longestTurnMs = ms
      }
    }
  }

  return {
    days,
    providers,
    models,
    modelDay,
    longestTurnMs,
    span: bestRun,
    sessions: lastTime ? { [localDate(lastTime)]: 1 } : {},
    lines,
  }
}

const EMPTY = { days: {}, providers: {}, models: {}, modelDay: {}, longestTurnMs: 0, span: { ms: 0, date: null }, sessions: {}, lines: 0 }

function mergeInto(target, agg) {
  for (const date of Object.keys(agg.days || {})) {
    const src = agg.days[date]
    const dst = addDay(target.days, date)
    dst.in += src.in
    dst.out += src.out
    dst.cache += src.cache
    dst.reason += src.reason
    dst.req += src.req
    dst.turns += src.turns
    dst.chatMs += src.chatMs
  }
  for (const date of Object.keys(agg.sessions || {})) {
    target.sessions[date] = (target.sessions[date] || 0) + agg.sessions[date]
  }
  for (const kind of ['providers', 'models']) {
    for (const key of Object.keys(agg[kind] || {})) {
      const src = agg[kind][key]
      const dst = target[kind][key] || (target[kind][key] = { tokens: 0, in: 0, out: 0, cache: 0, reason: 0, req: 0, days: {} })
      dst.tokens += src.tokens
      dst.in += src.in
      dst.out += src.out
      dst.cache += src.cache
      dst.reason += src.reason
      dst.req += src.req
      for (const date of Object.keys(src.days || {})) dst.days[date] = (dst.days[date] || 0) + src.days[date]
    }
  }
  for (const key of Object.keys(agg.modelDay || {})) {
    const dst = target.modelDay[key] || (target.modelDay[key] = {})
    for (const date of Object.keys(agg.modelDay[key])) {
      const src = agg.modelDay[key][date]
      const cell = dst[date] || (dst[date] = { i: 0, o: 0, c: 0 })
      cell.i += src.i
      cell.o += src.o
      cell.c += src.c
    }
  }
  if (agg.longestTurnMs > target.longestTurnMs) target.longestTurnMs = agg.longestTurnMs
  if (agg.span && agg.span.ms > target.span.ms) target.span = agg.span
  target.lines += agg.lines || 0
}

// ---------- headline numbers ----------

const dayTokens = (day) => day.in + day.out

function longestRun(set) {
  const sorted = [...set].sort()
  let best = 0
  let run = 0
  let prev = 0
  for (const date of sorted) {
    const parts = date.split('-').map(Number)
    const t = new Date(parts[0], parts[1] - 1, parts[2]).getTime()
    run = prev && t - prev === 86_400_000 ? run + 1 : 1
    prev = t
    if (run > best) best = run
  }
  return best
}

function computeStreaks(activeDates) {
  const set = new Set(activeDates)
  if (!set.size) return { current: 0, longest: 0 }
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  let cursor = midnight.getTime()
  if (!set.has(localDate(cursor))) cursor -= 86_400_000
  if (!set.has(localDate(cursor))) return { current: 0, longest: longestRun(set) }
  let current = 0
  for (;;) {
    if (!set.has(localDate(cursor))) break
    current++
    cursor -= 86_400_000
  }
  return { current, longest: Math.max(current, longestRun(set)) }
}

function summarize(agg, generatedAt) {
  const dates = Object.keys(agg.days).sort()
  const list = dates.map((date) => {
    const day = agg.days[date]
    return {
      date,
      tokens: dayTokens(day),
      in: day.in,
      out: day.out,
      cache: day.cache,
      reason: day.reason,
      req: day.req,
      turns: day.turns,
      chatMs: day.chatMs,
      sessions: (agg.sessions && agg.sessions[date]) || 0,
    }
  })

  let peak = { date: null, tokens: 0 }
  let longestChat = agg.span || { ms: 0, date: null }
  let busiest = { date: null, chatMs: 0 }
  const totals = { tokens: 0, in: 0, out: 0, cache: 0, reason: 0, req: 0, turns: 0, chatMs: 0, sessions: 0 }
  for (const day of list) {
    totals.tokens += day.tokens
    totals.in += day.in
    totals.out += day.out
    totals.cache += day.cache
    totals.reason += day.reason
    totals.req += day.req
    totals.turns += day.turns
    totals.chatMs += day.chatMs
    totals.sessions += day.sessions
    if (day.tokens > peak.tokens) peak = { date: day.date, tokens: day.tokens }
    if (day.chatMs > busiest.chatMs) busiest = { date: day.date, chatMs: day.chatMs }
  }

  const active = list.filter((d) => d.tokens > 0 || d.turns > 0).map((d) => d.date)
  const top = (bucket) =>
    Object.keys(bucket)
      .map((id) => {
        const b = bucket[id]
        return {
          id,
          tokens: b.tokens,
          in: b.in,
          out: b.out,
          cache: b.cache,
          reason: b.reason,
          req: b.req,
          days: Object.keys(b.days || {}).length,
          share: totals.tokens > 0 ? b.tokens / totals.tokens : 0,
        }
      })
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 12)

  // Every model's day cells, for the client-side 7d/30d window slicing.
  const modelDays = Object.keys(agg.modelDay || {})
    .map((id) => {
      const bucket = agg.modelDay[id]
      let tokens = 0
      for (const date of Object.keys(bucket)) tokens += bucket[date].i + bucket[date].o
      return { id, tokens, days: bucket }
    })
    .sort((a, b) => b.tokens - a.tokens)

  return {
    ok: true,
    generatedAt,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    activeDays: active.length,
    totals,
    peak,
    longestChat: { date: longestChat.date, ms: longestChat.ms },
    busiestDay: busiest,
    longestTurnMs: agg.longestTurnMs,
    streaks: computeStreaks(active),
    days: list,
    providers: top(agg.providers),
    models: top(agg.models),
    modelDays,
    providerDays: Object.fromEntries(Object.keys(agg.providers).map((k) => [k, agg.providers[k].days])),
  }
}

// ---------- tracker ----------

// v3: day/bucket tokens = input + output only (prompt-cache reads are excluded from
// the headline metric). v4: models carry in/out/cache splits plus the modelDay
// matrix the client slices into 7d/30d windows. Bump on formula changes so stale
// caches rescan.
const CACHE_VERSION = 4

export function createUsageTracker({ dshHome, cacheFile, onError }) {
  const sessionsDir = join(dshHome, 'sessions')
  const cachePath = join(dshHome, 'storages', cacheFile)
  let fileCache = {}
  let snapshot = null
  let loaded = false
  let running = null
  let lastAt = 0
  let cachedSummary = null
  let summaryCache = null
  let wroteSummary = false

  async function loadCache() {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'))
      if (!raw || raw.version !== CACHE_VERSION) return
      if (raw && typeof raw.files === 'object') fileCache = raw.files
      if (raw && raw.summary && raw.summary.days) {
        cachedSummary = raw.summary
        wroteSummary = true
      }
    } catch {
      fileCache = {}
    }
  }

  async function saveCache() {
    try {
      await mkdir(join(dshHome, 'storages'), { recursive: true })
      await writeFile(cachePath, JSON.stringify({ version: CACHE_VERSION, files: fileCache, summary: summaryCache || cachedSummary || null }))
      wroteSummary = true
    } catch (error) {
      onError?.('usage cache write failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  async function scan() {
    await loadCache()
    const logs = await listLogs(sessionsDir)
    const live = {}
    const merged = { days: {}, providers: {}, models: {}, modelDay: {}, longestTurnMs: 0, span: { ms: 0, date: null }, sessions: {}, lines: 0 }
    let rescanned = 0

    for (const log of logs) {
      const cached = fileCache[log.path]
      live[log.path] = true
      if (cached && cached.size === log.size && cached.mtimeMs === log.mtimeMs) {
        mergeInto(merged, cached.agg || EMPTY)
        continue
      }
      let agg = EMPTY
      try {
        const text = await readLog(log.path)
        if (text) agg = aggregate(text)
      } catch (error) {
        onError?.('read ' + log.session + ' failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      fileCache[log.path] = { size: log.size, mtimeMs: log.mtimeMs, agg }
      mergeInto(merged, agg)
      rescanned++
    }

    for (const key of Object.keys(fileCache)) if (!live[key]) delete fileCache[key]

    lastAt = Date.now()
    snapshot = summarize(merged, lastAt)
    snapshot.rescan = rescanned
    summaryCache = snapshot
    if (rescanned || !wroteSummary) await saveCache()
    return snapshot
  }

  return {
    /** Latest snapshot; kicks off a background refresh when stale. Never blocks. */
    async peek(force) {
      if (!snapshot) {
        // Restart: show the last measured summary at once, then rescan behind it.
        await loadCache()
        if (!snapshot && cachedSummary) {
          snapshot = cachedSummary
          lastAt = Number(cachedSummary.generatedAt) || 0
        }
      }
      if ((force || !snapshot || Date.now() - lastAt > REFRESH_MS) && !running) {
        running = scan()
          .catch((error) => {
            onError?.('usage scan failed: ' + (error instanceof Error ? error.message : String(error)))
            return snapshot
          })
          .finally(() => {
            running = null
          })
      }
      return snapshot
    },
    /** Wait for a fresh scan (used by the dashboard's first open). */
    async now() {
      return running || scan()
    },
  }
}
