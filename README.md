[English](README.en.md) | 简体中文


# dsh-balance-monitor

多平台 AI 账户「余额 / 配额 / 用量」一览 + **Token 活动看板**，直接长在 dsh 侧边栏底部。

一个极简的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件：侧边栏底部（设置上方）**按平台堆叠**显示剩余额度、剩余比例条、已用/今日花费；同一个厂商**同时提供 Coding Plan（订阅套餐）和 API 按量**时，行内一键切换口径；没开放余额接口的厂商自动退化成 **DSH 本地实测用量**；再配一个 GitHub 贡献墙样式的 **Token 热力图看板**。样式全用官方设计令牌，克制内敛。

> 为什么做这个：DeepSeek 涨价后你想切智谱等平台，但原插件写死只查 DeepSeek。现在它是**平台适配器注册表 + 双模式 + 本地实测**，配了哪个 key 就显示哪个，DSH 里接了哪个 provider 也自动补一行，不写死。

## 功能

| 功能 | 实现 |
|---|---|
| 多平台堆叠 | 一张卡片自上而下每平台一行（名字 + 剩余 + 比例条 + 已用），随配置自然堆叠 |
| **Coding Plan ↔ API 一键切换** | 每行模式小圆点（绿 = Coding Plan / 灰 = API 按量），点开浮层菜单即切，写进 config 并立刻返回新快照；不用手改任何文件 |
| **自动跟随 DSH** | 读 `settings.yaml` 的 `llm-pi-ai.providers`：接了哪个 provider 就自动补一行（含 baseUrl 反查厂商、自动推断该显示套餐还是按量） |
| **本地实测用量** | 厂商没开放余额接口（智谱 API、b.ai、百炼、方舟、小米…）时，该行改显示 DSH 会话日志里实测的 token / 请求数，不撒谎也不空白 |
| **Token 活动看板** | 5 张统计卡（累计 / 峰值 / 最长聊天时长 / 当前连续天数 / 最长连续天数）+ 52 周**每日 token 热力图**，`每日 / 每周 / 累计` 三档切换，附厂商与模型明细表 |
| 三种适配器 | **balance**（真实余额）、**quota**（滚动窗口配额，多窗口分条显示）、**cost**（近 30 天费用）；外加 **local**（本地实测） |
| 配额取紧约束 | 多窗口时标题数字显示**最紧张的那个窗口**（5h 刚重置但本周已用满 → 显示 0%，倒计时到本周重置），不是最短窗口 |
| 今日花费 | 余额型平台按天记基线（持久化状态文件），花费 = 基线 − 当前；充值不会让数字变负 |
| 通用自定义 | agent 调 `balance_monitor` 的 `addCustom` 接入任意 OpenAI 兼容厂商（Base URL + 路径 + 字段映射），或直接写 `$DSH_HOME/.credentials.yaml`；无需手填设置面板 |
| 收起态小圆点 | 侧边栏收成 36px 后每平台一个小圆点（绿/琥珀/红按剩余着色），悬停 tooltip 列出各平台 + 数值 + 当前模式 |
| 位置 | 注册在官方 `sidebar.footer.action` 槽位 —— 设置上方，零 hack |
| 健壮性 | 60s 轮询 + 切回标签页立即刷新；上游失败保留上次数据（变淡标 stale），不闪错误 |
| 双语 | 跟随 dsh 界面语言（`navigator.language`），中/英自动 |
| 安全 | Key 只留在服务端，浏览器只拿到数字快照 |

## 支持的平台

内置 14 家（按国内接 dsh 的常见程度排序），每家声明自己支持的**模式**；同一 key 两种模式共用，切换只改显示口径：

| id | 显示名 | 环境变量 key | 模式 |
|---|---|---|---|
| deepseek | DeepSeek | `DEEPSEEK_API_KEY` | API 按量（余额 ¥） |
| zhipu | 智谱 GLM | `ZHIPU_API_KEY` | Coding Plan 配额（积分窗口）· API 按量（本地实测） |
| zai | Z.ai（GLM 国际站） | `ZAI_API_KEY` | Coding Plan 配额 · API 按量（本地实测） |
| moonshot | Kimi / 月之暗面 | `MOONSHOT_API_KEY` | Kimi For Coding 配额（5h + 周）· API 余额 ¥ |
| minimax | MiniMax | `MINIMAX_API_KEY` | Coding Plan 配额 · API 按量（本地实测） |
| stepfun | 阶跃星辰 | `STEPFUN_API_KEY` | API 余额 ¥ |
| dashscope | 阿里百炼 Qwen | `DASHSCOPE_API_KEY` | API 按量（本地实测） |
| volcengine | 火山方舟 Doubao | `ARK_API_KEY` | API 按量（本地实测） |
| xiaomi | 小米 MiMo | `XIAOMI_API_KEY` | API 按量（本地实测） |
| siliconflow | 硅基流动 | `SILICONFLOW_API_KEY` | API 余额 ¥ |
| openrouter | OpenRouter | `OPENROUTER_API_KEY` | API credits $ |
| xai | xAI (Grok) | `XAI_API_KEY` | API credits $ |
| openai | OpenAI | `OPENAI_API_KEY` | API 近 30 天费用 $ |
| anthropic | Anthropic | `ANTHROPIC_API_KEY` | API 近 30 天费用 $（需 Admin key） |

几点实测结论（省得你踩）：

- **智谱没有开放的余额接口**（`/api/biz/balance/query` 直接「请求地址不允许访问」，其余 404），所以 API 模式走本地实测；Coding Plan 模式走 `/api/monitor/usage/quota/limit`，按 `unit` 认窗口（3=5h、2=日、1=月、6=周），`TOKENS_LIMIT / CREDIT_LIMIT / TIME_LIMIT` 三种限额都吃。
- **b.ai 没有计费接口**（一律 `403 HTTP node only allows access to inference API paths`），会自动注册成 `dsh:b-ai` 本地实测行。
- MiniMax 的 `/coding_plan/remains` 要 cookie，`/v1/token_plan/remains` 才吃 Bearer —— 内置的是后者。
- 余额为负（欠费）时不画进度条，数字照实显示。

## 一键切换 Coding Plan / API

点每行右侧的模式小圆点（绿 = Coding Plan / 灰 = API 按量），在浮层菜单里切换：

1. 浏览器发 `{action:'setMode', id, mode}` 到 `/balances`；
2. 服务端写进 `$DSH_HOME/balance-monitor.config.json` 的 `platforms.<id>.mode`；
3. 立刻返回一份新快照，卡片当场更新（不用重启、不用刷新）。

模式优先级：**你的手动覆盖 > 按 DSH baseUrl 推断（含 `/coding`、`/paas/coding`、`anthropic` 判为套餐，否则按量）> 该厂商第一个有 key 的非本地模式**。

## 配置 Key

**不需要额外配置文件**：哪个平台配了 key 就显示哪个；DSH 里接了的 provider 也会自动补一行。key 先查环境变量，否则读 `$DSH_HOME/.credentials.yaml`：

```yaml
# $DSH_HOME/.credentials.yaml
DEEPSEEK_API_KEY: sk-xxxx
ZHIPU_API_KEY: xxxx
MOONSHOT_API_KEY: sk-yyyy
```

环境变量优先级更高：`ZHIPU_API_KEY=xxxx dsh --profile web ...`。

## 通用自定义平台

通过 agent 调 `balance_monitor` 工具的 `addCustom` 接入任意 OpenAI 兼容网关 / 反代 / 小厂商（只写进配置，字段如下）：

| 字段 | 说明 |
|---|---|
| `label` | 卡片上显示的名字（自动生成 id） |
| `baseUrl` | 如 `https://gateway.example.com` |
| `path` | 默认 `/v1/user/balance` |
| `auth` | `bearer`（默认）/ `raw`（原样写进 Authorization）/ `x-api-key` |
| `kind` | balance（余额条）/ quota（配额百分比窗口） |
| `currency` / `modeLabel` | 显示币种 / 模式名 |
| `keyEnv` | 读哪个 env / `.credentials.yaml`；留空则按 `label` 自动生成 `XXX_API_KEY` |
| `apiKey` | 直接写入 `$DSH_HOME/.credentials.yaml`（只在服务端，不回显） |
| `pick` | 取值映射：剩余 / 总额 / 重置时间路径，如 `data.balance` |

映射取不到数时会明确报「按映射取不到数值，检查字段路径（如 data.balance）」，不会静默显示 0。

填映射前先用 `curl -H "Authorization: Bearer $KEY" <base><path>` 看一眼真实 JSON：各家前缀不统一，例如 DeepSeek 的返回就没有 `data` 包装，正确路径是 `balance_infos.0.total_balance`（路径支持 `.` 分段，数组下标写成数字即可）。

## 可选 config

`$DSH_HOME/balance-monitor.config.json`（面板会自己写，也可以手改）：

```json
{
  "platforms": {
    "zhipu": { "label": "智谱GLM", "enabled": true, "mode": "coding" },
    "deepseek": { "enabled": false }
  },
  "custom": [
    { "id": "custom-mygateway", "label": "我的网关", "baseUrl": "https://gw.example.com",
      "path": "/v1/user/balance", "auth": "bearer", "kind": "balance", "currency": "CNY",
      "pick": { "remaining": "balance", "total": "total_balance", "resetAt": "" } }
  ]
}
```

## Token 活动看板

`▦ Token 活动` 打开。数据**全部来自本地** `$DSH_HOME/sessions/*/*/session.jsonl[.zstd]`，不查任何厂商接口，所以「本地实测」型平台也有数。

- **累计 Token 数** —— 全部会话的 in + out 之和（缓存读只进 tooltip/脚注，推理不计入；`亿`/`万` 中文计数）
- **峰值 Token 数** —— 单日最高，标注日期
- **最长聊天时长** —— 单次连续对话最长时长（相邻事件间隔 > 30min 断开，避免把跨天挂机算成聊天）
- **当前 / 最长连续天数** —— 打卡式 streak
- **热力图** —— 52 周（约一年）GitHub 贡献墙，周一对齐，月份轴 + 星期轴，颜色按 `sqrt` 分 5 档；`每日 / 每周 / 累计` 切换度量，格子 tooltip 给当天 tokens / 请求 / 轮次 / 时长

解析要点：dsh 的 `.zstd` 是**多帧拼接**流，`zstdDecompressSync` 只会解出第一帧 —— 这里按 magic `28 B5 2F FD` 切帧逐帧解压再拼接（实测 32621 帧 0 失败）。按 `size + mtimeMs` 做指纹缓存（`$DSH_HOME/storages/balance-monitor-usage.json`），冷扫 ~2s、命中 ~300ms；重启后先用缓存摘要秒开，再后台重扫。

## 安装

浏览器端 bundle 是手写 classic script，**无构建步骤**：

```sh
dsh plugin --profile web add "github:<you>/dsh-balance-monitor#main"
```

然后重启 Web UI（`dsh --profile web`）。改 `lib/client.js` 刷新页面即可；改 `lib/index.js` / `providers.js` / `usage.js` 需重启 dsh。

## 工作原理

- **服务端半** `lib/index.js` —— 注册 `/balances` RPC 通道（loopback 信任围栏）。动作：`snapshot` / `setMode` / `setEnabled` / `setLabel` / `saveCustom` / `removeCustom` / `usage`；所有写操作直接返回新快照。
- **适配器注册表** `lib/providers.js` —— 厂商 × 模式 × 解析器，含 `matchVendor(baseUrl)` 与 `inferMode(baseUrl)`。
- **用量扫描** `lib/usage.js` —— 会话日志 → 按日/厂商/模型聚合 + 连续天数 + 热力图数据。
- **浏览器半** `lib/client.js` —— 侧边栏卡片（展开/收起两态）+ 两个浮层面板（活动看板 / 设置），面板开关状态存 `sessionStorage`，刷新不丢。

每日基线账本（`$DSH_HOME/storages/balance-monitor.json`）按 `平台id:模式` 记账，切换模式不会污染对方的「今日已用」：

```json
{
  "deepseek:api": { "date": "2026-08-27", "dayStart": 100.0, "lastTotal": 99.5, "spent": 0.5, "updatedAt": 1755200000000 },
  "zhipu:coding": { "date": "2026-08-27", "dayStart": 500, "lastTotal": 372, "spent": 128, "updatedAt": 1755200000000 }
}
```

## 安全说明

- API key 永不离开服务端：浏览器只能通过 RPC 看到数字快照。
- 通道走 `loopback` 信任策略。
- 无遥测；网络请求仅各平台官方余额/配额/用量接口 + 本地会话日志读取。

## 目录结构

```
dsh-balance-monitor/
├── package.json        # dsh.bundle (patch) + dsh.client (浏览器注册表)
├── cordis.patch.yml    # 插入这一个组合插件行
└── lib/
    ├── index.js        # 服务端半：/balances 通道、config/账本读写、行装配
    ├── providers.js    # 厂商适配器注册表（模式、鉴权、解析器、baseUrl 反查）
    ├── usage.js        # 会话日志扫描 → 每日 token / 时长 / 连续天数
    └── client.js       # 浏览器半：卡片 + 模式小圆点/浮层 + 热力图看板（手写，无构建）
```

## 开发

无需工具链。改完 `node --check lib/*.js` 确认语法即可（`client.js` 是 classic script，别加 ESM 语法）。

## License

MIT
