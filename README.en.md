简体中文 | [English](README.md)


# dsh-balance-monitor

Multi-provider AI account balance, quota, and token usage in the dsh sidebar, plus a daily token heatmap.

A minimal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin: the sidebar footer (above Settings) stacks one row per provider with remaining credit, a ratio bar and today's spend. When a vendor sells **both a Coding Plan and pay-as-you-go API**, a dot on the row switches the reading between them. Vendors without a billing API fall back to **measured DSH usage**. A GitHub-contribution-style **daily token heatmap** sits below. Everything uses the official design tokens.

> Why: DeepSeek got pricier and you want to move to GLM & friends, but the original plugin was hard-wired to DeepSeek. This is a **provider adapter registry + dual mode + local measurement**: whatever key you configured shows up, and whatever provider dsh is actually pointed at gets its own row.

## Features

| Feature | How |
|---|---|
| Stacked providers | One row per provider (name + remaining + ratio bar + spent), stacking with however many you configure |
| **Coding Plan / API switch** | A mode dot per row (green = Coding Plan / grey = API) opening a popover; the click writes config and the same reply carries the new snapshot, with no file editing and no restart |
| **Follows dsh's own providers** | Reads `llm-pi-ai.providers` from `settings.yaml`: every connected provider gets a row (baseUrl -> vendor lookup, baseUrl -> mode inference) |
| **Local measurement** | No billing API (Zhipu API mode, b.ai, DashScope, Volcano, Xiaomi...)? The row shows tokens/requests actually measured from dsh session logs instead of lying or going blank |
| **Token activity dashboard** | 5 stat cards (total / peak / longest chat / current streak / longest streak) + a 52-week **daily token heatmap** with `Daily / Weekly / Cumulative` toggle, plus per-provider and per-model tables |
| Three adapter kinds | **balance**, **quota** (rolling windows, one bar each), **cost** (30-day spend), plus **local** |
| Quota shows the binding window | The headline is the *tightest* window, not the shortest: a fresh 5-hour window with a spent weekly one reads 0% and counts down to the weekly reset |
| Today's spend | Day-baseline ledger per `provider:mode`; top-ups never make the number negative |
| Generic custom provider | An agent calls `balance_monitor`'s `addCustom` (Base URL + path + field mapping), or write `$DSH_HOME/.credentials.yaml` directly; no hand-filled Settings panel |
| Collapsed rail | At 36px the card becomes one coloured dot per provider, hover tooltip lists name + value + active mode |
| Position | Official `sidebar.footer.action` slot, above Settings |
| Robustness | 60s poll + refresh on tab focus; upstream failures keep the last values (dimmed as stale) instead of flashing an error |
| Bilingual | Follows the dsh UI language (`navigator.language`), zh/en automatically |
| Safety | Keys stay server-side; the browser only ever receives numeric snapshots |

## Supported providers

14 built in (ordered by how commonly they are wired into dsh here); each declares its **modes**, one key serving both:

| id | Label | Env key | Modes |
|---|---|---|---|
| deepseek | DeepSeek | `DEEPSEEK_API_KEY` | API balance (¥) |
| zhipu | Zhipu GLM | `ZHIPU_API_KEY` | Coding Plan quota (credit windows) · API (local measurement) |
| zai | Z.ai (GLM intl.) | `ZAI_API_KEY` | Coding Plan quota · API (local measurement) |
| moonshot | Kimi | `MOONSHOT_API_KEY` | Kimi For Coding quota (5h + week) · API balance (¥) |
| minimax | MiniMax | `MINIMAX_API_KEY` | Coding Plan quota · API (local measurement) |
| stepfun | StepFun | `STEPFUN_API_KEY` | API balance (¥) |
| dashscope | Alibaba Bailian Qwen | `DASHSCOPE_API_KEY` | API (local measurement) |
| volcengine | Volcano Ark Doubao | `ARK_API_KEY` | API (local measurement) |
| xiaomi | Xiaomi MiMo | `XIAOMI_API_KEY` | API (local measurement) |
| siliconflow | SiliconFlow | `SILICONFLOW_API_KEY` | API balance (¥) |
| openrouter | OpenRouter | `OPENROUTER_API_KEY` | API credits ($) |
| xai | xAI (Grok) | `XAI_API_KEY` | API credits ($) |
| openai | OpenAI | `OPENAI_API_KEY` | API 30-day cost ($) |
| anthropic | Anthropic | `ANTHROPIC_API_KEY` | API 30-day cost ($, Admin key) |

Findings from probing these APIs (so you don't have to):

- **Zhipu exposes no balance endpoint** (`/api/biz/balance/query` -> "request address not allowed", everything else 404), so API mode is measured locally; Coding Plan mode uses `/api/monitor/usage/quota/limit`, keyed on `unit` (3 = 5h, 2 = day, 1 = month, 6 = week) across `TOKENS_LIMIT / CREDIT_LIMIT / TIME_LIMIT`.
- **b.ai has no billing API** at all (every path -> `403 HTTP node only allows access to inference API paths`); it auto-registers as a `dsh:b-ai` local row.
- MiniMax `/coding_plan/remains` demands cookies; `/v1/token_plan/remains` accepts Bearer, so that is the one wired in.
- A negative balance (overdrawn) is shown as-is with the bar suppressed.

## Switching Coding Plan / API

Click the mode dot in a row (green = Coding Plan / grey = API), then pick from the popover:

1. the browser sends `{action:'setMode', id, mode}` on `/balances`;
2. the host writes `platforms.<id>.mode` into `$DSH_HOME/balance-monitor.config.json`;
3. the reply is a fresh snapshot, so the card updates on the spot.

Mode precedence: **your override > inference from dsh's baseUrl (`/coding`, `/paas/coding`, `anthropic` -> Coding Plan, else API) > first non-local mode with a key**.

## Configuring keys

**No config file needed**: a provider appears once it has a key, and every provider dsh is pointed at gets a row too. Keys come from the environment first, else `$DSH_HOME/.credentials.yaml`:

```yaml
# $DSH_HOME/.credentials.yaml
DEEPSEEK_API_KEY: sk-xxxx
ZHIPU_API_KEY: xxxx
MOONSHOT_API_KEY: sk-yyyy
```

Environment wins: `ZHIPU_API_KEY=xxxx dsh --profile web ...`.

## Generic custom provider

An agent calls the `balance_monitor` tool's `addCustom` for any OpenAI-compatible gateway or reverse proxy (fields below):

| Field | Meaning |
|---|---|
| `label` | row label (id derived from it) |
| `baseUrl` | e.g. `https://gateway.example.com` |
| `path` | defaults to `/v1/user/balance` |
| `auth` | `bearer` (default) / `raw` (verbatim Authorization) / `x-api-key` |
| `kind` | balance (money bar) / quota (percentage windows) |
| `currency` / `modeLabel` | display currency / mode name |
| `keyEnv` | which env / `.credentials.yaml` entry to read; empty -> auto-derived `NAME_API_KEY` from `label` |
| `apiKey` | written straight into `$DSH_HOME/.credentials.yaml` (server-side only, never echoed) |
| `pick` | field mapping for remaining / total / resetAt, e.g. `data.balance` |

If the mapping yields no number the row says so rather than showing a silent 0.

Check the real JSON first (`curl -H "Authorization: Bearer $KEY" <base><path>`): prefixes are not standardised. DeepSeek's own response has no `data` wrapper, so the path is `balance_infos.0.total_balance`. Paths split on `.`, array indices are written as numbers.

## Optional config

`$DSH_HOME/balance-monitor.config.json` (the panels write it for you; hand-editing is fine too):

```json
{
  "platforms": {
    "zhipu": { "label": "Zhipu GLM", "enabled": true, "mode": "coding" },
    "deepseek": { "enabled": false }
  },
  "custom": [
    { "id": "custom-mygateway", "label": "My gateway", "baseUrl": "https://gw.example.com",
      "path": "/v1/user/balance", "auth": "bearer", "kind": "balance", "currency": "USD",
      "pick": { "remaining": "balance", "total": "total_balance", "resetAt": "" } }
  ]
}
```

## Token activity dashboard

Open it with the `Token activity` button. Everything is computed **locally** from `$DSH_HOME/sessions/*/*/session.jsonl[.zstd]` with no vendor call, so even the local-measurement providers have data.

- **Total tokens**: input + output across all sessions (cache-read appears only in the tooltip/footnote; reasoning is never counted)
- **Peak day**: highest single-day total, with its date
- **Longest chat**: longest continuous stretch (a > 30 min gap between events ends it, so an idle overnight session is not a chat)
- **Current / longest streak**: consecutive active days
- **Heatmap**: 52 GitHub-style weeks (about a year), Monday-aligned, month + weekday axes, `sqrt`-scaled 5-level colour, `Daily / Weekly / Cumulative` metric toggle, per-cell tooltip with tokens / requests / turns / duration

Implementation note: dsh's `.zstd` files are **concatenated frames** and `zstdDecompressSync` stops after frame one, so the scanner splits on the `28 B5 2F FD` magic and inflates each frame (32621 frames, 0 failures). Per-file `size + mtimeMs` fingerprints are cached in `$DSH_HOME/storages/balance-monitor-usage.json`: ~2s cold, ~300ms warm, and after a restart the cached summary paints instantly while a rescan runs behind it.

## Install

The browser bundle is a hand-written classic script with **no build step**:

```sh
dsh plugin --profile web add "github:<you>/dsh-balance-monitor#main"
```

Then restart the Web UI (`dsh --profile web`). Editing `lib/client.js` only needs a page refresh; `index.js` / `providers.js` / `usage.js` need a dsh restart.

## How it works

- **Host half** `lib/index.js`: registers the `/balances` RPC channel (loopback trust fence) with actions `snapshot` / `setMode` / `setEnabled` / `setLabel` / `saveCustom` / `removeCustom` / `usage`; every mutation returns a fresh snapshot.
- **Registry** `lib/providers.js`: vendor x mode x parser, plus `matchVendor(baseUrl)` and `inferMode(baseUrl)`.
- **Usage scanner** `lib/usage.js`: session logs -> per-day / per-provider / per-model aggregates, streaks, heatmap series.
- **Client half** `lib/client.js`: sidebar card (wide + rail), mode dot, and two floating panels (dashboard / settings) whose open state lives in `sessionStorage`.

The day-baseline ledger (`$DSH_HOME/storages/balance-monitor.json`) is keyed by `provider:mode`, so switching modes does not poison the other mode's "today":

```json
{
  "deepseek:api": { "date": "2026-08-27", "dayStart": 100.0, "lastTotal": 99.5, "spent": 0.5, "updatedAt": 1755200000000 },
  "zhipu:coding": { "date": "2026-08-27", "dayStart": 500, "lastTotal": 372, "spent": 128, "updatedAt": 1755200000000 }
}
```

## Security

- API keys never leave the host: the browser only sees numeric snapshots over RPC.
- The channel uses the `loopback` trust policy.
- No telemetry; network traffic is only the official balance/quota/cost endpoints, plus local session-log reads.

## Layout

```
dsh-balance-monitor/
├── package.json        # dsh.bundle (patch) + dsh.client (browser registry)
├── cordis.patch.yml    # inserts this single combined plugin line
└── lib/
    ├── index.js        # host: /balances channel, config + ledger, row assembly
    ├── providers.js    # provider adapter registry (modes, auth, parsers)
    ├── usage.js        # session-log scanner -> daily tokens / duration / streaks
    └── client.js       # browser: card, mode dot/popover, heatmap dashboard (no build)
```

## Development

No toolchain. After editing, `node --check lib/*.js` (`client.js` is a classic script, so keep ESM syntax out of it).

## License

MIT
