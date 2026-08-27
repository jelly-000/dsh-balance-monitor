简体中文 | [English](README.md)


# dsh-balance-monitor

dsh-balance-monitor is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that shows balance, quota, and usage across multiple AI providers in the sidebar footer, together with a token heatmap driven by local session logs.

The plugin stacks one row per provider, showing remaining credit, a ratio bar, usage, and today's spend. When a vendor offers both Coding Plan (subscription) and pay-as-you-go API billing, a mode dot on the row switches the reading between the two. Vendors without a balance or billing API automatically fall back to measured DSH usage. The interface uses the official design tokens and stays restrained.

> Background: after DeepSeek raised prices, users may need to move to platforms such as Zhipu, while the original plugin supported only DeepSeek. This plugin is built around a provider adapter registry: it dynamically binds to every configured vendor and automatically includes any provider already connected to dsh.

## Features

| Feature | Description |
|---|---|
| Stacked providers | One row per provider (name, balance, ratio bar, usage), stacked in a single card |
| **Coding Plan / API switch** | A mode dot per row (green = Coding Plan, grey = pay-as-you-go) opens a popover; switching writes the config and returns a new snapshot immediately, with no file editing |
| **Follows dsh providers** | Reads `llm-pi-ai.providers` from `settings.yaml`, adds every connected provider, and infers the vendor and billing mode from the base URL |
| **Local measurement** | Vendors without a balance endpoint (Zhipu API, b.ai, DashScope, Volcano Ark, Xiaomi, etc.) show tokens / requests measured from DSH session logs |
| **Token activity dashboard** | 5 stat cards (total, peak, longest session, current streak, longest streak) + a 52-week daily token heatmap with Daily / Weekly / Cumulative toggle, plus per-provider and per-model tables |
| Adapter kinds | **balance** (live balance), **quota** (rolling-window quota, one bar per window), **cost** (30-day spend); plus **local** |
| Quota shows the binding window | The headline is the tightest window, not the shortest: a fresh 5-hour window with a full weekly one reads 0% and counts down to the weekly reset |
| Today's spend | Day-baseline ledger per `provider:mode`; top-ups never make the figure negative |
| Generic custom provider | An agent calls `balance_monitor`'s `addCustom` (Base URL + path + field mapping), or write to `$DSH_HOME/.credentials.yaml` directly |
| Collapsed rail | At 36px the card becomes one colored dot per provider; hover tooltip lists name, value, and active mode |
| Position | Registered in the official `sidebar.footer.action` slot, above Settings |
| Robustness | 60-second polling plus refresh on tab focus; upstream failures keep the last values (dimmed as stale) instead of flashing an error |
| Bilingual | Follows the dsh UI language (`navigator.language`), zh / en automatically |
| Safety | API keys stay server-side; the browser only ever receives numeric snapshots |

## Supported providers

14 built-in vendors, each declaring its supported billing modes; one key serves both modes, and switching only changes the reading shown:

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
| openai | OpenAI | `OPENAI_API_KEY` | API 30-day spend ($) |
| anthropic | Anthropic | `ANTHROPIC_API_KEY` | API 30-day spend ($) (needs Admin key) |

## Billing API notes

Measured behavior of each vendor's billing endpoint, for reference during configuration:

- **Zhipu** has no public balance endpoint (`/api/biz/balance/query` is refused; the rest return 404), so API mode uses local measurement. Coding Plan mode uses `/api/monitor/usage/quota/limit`, reads the window from `unit` (3 = 5 hour, 2 = day, 1 = month, 6 = week), and supports `TOKENS_LIMIT / CREDIT_LIMIT / TIME_LIMIT`.
- **b.ai** has no billing endpoint (always `403 HTTP node only allows access to inference API paths`), so it auto-registers as a `dsh:b-ai` local-measurement row.
- **MiniMax**: `/coding_plan/remains` requires a cookie; `/v1/token_plan/remains` accepts Bearer. The plugin uses the latter.
- **Negative balance**: when the balance is negative (in arrears), the plugin skips the ratio bar but still shows the number.

## Coding Plan / API switch

Click the mode dot on a row (green = Coding Plan, grey = pay-as-you-go) and choose from the popover:

1. The browser sends `{action:'setMode', id, mode}` to `/balances`;
2. The host writes `platforms.<id>.mode` in `$DSH_HOME/balance-monitor.config.json`;
3. The endpoint returns a new snapshot immediately and the card updates in place, with no restart or refresh.

Mode precedence: **manual override > inference from the dsh base URL (`/coding`, `/paas/coding`, `anthropic` are treated as subscription, the rest as usage-based) > the vendor's first non-local mode with a configured key**.

## Configuring keys

No extra configuration file is required: vendors with a key are shown automatically, and providers already connected to dsh are added too. Keys are read from environment variables first, then from `$DSH_HOME/.credentials.yaml`:

```yaml
# `$DSH_HOME/.credentials.yaml`
DEEPSEEK_API_KEY: sk-xxxx
ZHIPU_API_KEY: xxxx
MOONSHOT_API_KEY: sk-yyyy
```

Environment variables take precedence: `ZHIPU_API_KEY=xxxx dsh --profile web ...`.

## Generic custom providers

An agent calls `balance_monitor`'s `addCustom` to connect any OpenAI-compatible gateway / reverse proxy / small vendor (written only to config; fields below):

| Field | Description |
|---|---|
| `label` | Display name on the card (id is auto-generated) |
| `baseUrl` | e.g. `https://gateway.example.com` |
| `path` | default `/v1/user/balance` |
| `auth` | `bearer` (default) / `raw` (written verbatim into Authorization) / `x-api-key` |
| `kind` | balance (balance bar) / quota (quota percentage window) |
| `currency` / `modeLabel` | currency / mode name |
| `keyEnv` | the env / `.credentials.yaml` entry to read; if empty, `XXX_API_KEY` is derived from `label` |
| `apiKey` | written straight into `$DSH_HOME/.credentials.yaml` (host-only, never echoed) |
| `pick` | value mapping: remaining / total / reset-time paths, e.g. `data.balance` |

If the mapping cannot resolve a value, the plugin reports "mapping did not resolve a value; check the field path (e.g. data.balance)" instead of silently showing 0.

Before configuring, inspect the real response with `curl -H "Authorization: Bearer $KEY" <base><path>`: prefixes vary across vendors. For example, DeepSeek's response has no `data` wrapper, and the correct path is `balance_infos.0.total_balance` (paths use `.` as a separator; array indices are written as plain numbers).

## Optional config

```json
{
  "platforms": {
    "zhipu": { "label": "Zhipu GLM", "enabled": true, "mode": "coding" },
    "deepseek": { "enabled": false }
  },
  "custom": [
    { "id": "custom-mygateway", "label": "My gateway", "baseUrl": "https://gw.example.com",
      "path": "/v1/user/balance", "auth": "bearer", "kind": "balance", "currency": "CNY",
      "pick": { "remaining": "balance", "total": "total_balance", "resetAt": "" } }
  ]
}
```

## Token activity dashboard

Open the `▦ Token activity` dashboard. All data comes from local `$DSH_HOME/sessions/*/*/session.jsonl[.zstd]`, and no vendor endpoint is called, so local-measurement providers have data too.

- **Total tokens**: the sum of in + out across all sessions (cache reads are counted only in tooltips/footnotes; reasoning tokens are excluded; `亿` / `万` Chinese counting)
- **Peak tokens**: the highest single-day value, with its date
- **Longest session**: the longest continuous conversation (adjacent events more than 30 minutes apart are treated as disconnected, so idle overnight sessions are not counted)
- **Current / longest streak**: consecutive active days
- **Heatmap**: a 52-week (about one year) GitHub-style contribution grid, aligned to Mondays, with month and weekday axes, colored by `sqrt` into 5 levels; Daily / Weekly / Cumulative toggle, and per-cell tooltips showing that day's tokens / requests / turns / duration

Parsing notes: dsh's `.zstd` files are a multi-frame concatenated stream, and `zstdDecompressSync` decodes only the first frame; the plugin splits frames by the `28 B5 2F FD` magic and decodes each before concatenating (tested over 32,621 frames with 0 failures). Fingerprint caching uses `size + mtimeMs` (`$DSH_HOME/storages/balance-monitor-usage.json`): about 2 s cold scan, about 300 ms hit; after a restart it opens instantly from the cached digest and rescans in the background.

## Installation

The browser bundle is a hand-written classic script with no build step:

```sh
dsh plugin --profile web add "github:<you>/dsh-balance-monitor#main"
```

Then restart the Web UI (`dsh --profile web`). Editing `lib/client.js` only requires a page refresh; editing `lib/index.js` / `providers.js` / `usage.js` requires a dsh restart.

## How it works

- **Host** `lib/index.js`: registers the `/balances` RPC channel (loopback trust fence), with `snapshot` / `setMode` / `setEnabled` / `setLabel` / `saveCustom` / `removeCustom` / `usage` actions; every write returns a new snapshot immediately.
- **Adapter registry** `lib/providers.js`: vendor × mode × parser, including `matchVendor(baseUrl)` and `inferMode(baseUrl)`.
- **Usage scan** `lib/usage.js`: scans session logs, aggregates by day / vendor / model, and produces streaks and heatmap data.
- **Browser** `lib/client.js`: sidebar card (expanded / collapsed) + the Token activity dashboard panel; panel open/close state is kept in `sessionStorage` so it survives a refresh.

The daily-baseline ledger (`$DSH_HOME/storages/balance-monitor.json`) is keyed by `provider:mode`, so switching modes never contaminates the other reading's "spent today":

```json
{
  "deepseek:api": { "date": "2026-08-27", "dayStart": 100.0, "lastTotal": 99.5, "spent": 0.5, "updatedAt": 1755200000000 },
  "zhipu:coding": { "date": "2026-08-27", "dayStart": 500, "lastTotal": 372, "spent": 128, "updatedAt": 1755200000000 }
}
```

## Security

- API keys never leave the host; the browser only sees numeric snapshots over RPC.
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

No toolchain. After editing, run `node --check lib/*.js` (`client.js` is a classic script, so keep ESM syntax out of it).

## License

MIT
