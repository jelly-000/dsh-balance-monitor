// dsh-balance-monitor — browser half.
//
// A minimal sidebar footer action (rendered above Settings) showing the
// DeepSeek account balance, a thin remaining-ratio bar, today's spend, and
// the rolling-12-month token/cost totals. Data rides the /balance channel
// provided by the host half.
//
// The balance polls on a configurable interval (default 60s, real network
// query; adjustable in the plugin's settings page, which also covers the
// low-balance reminder threshold and the platform userToken). The yearly
// usage is fetched automatically once per page load and again on the ↻
// button click (which re-queries balance AND the 12-month usage together).
// On mount the card first shows the cached numbers (host answers from disk,
// zero network), then freshens balance and usage over the network.
//
// Hand-written classic-script bundle: the module table answers require()
// for the platform entries (react, react/jsx-runtime); everything else is
// inlined here. No build step, no CSS files — inline styles only, using the
// design-system variables so the card follows the active theme.

window.__ModuleLoader__.load({
  id: 'dsh-balance-monitor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const { jsx, jsxs } = require('react/jsx-runtime');
    const { useCallback, useEffect, useState } = require('react');

    const NS = 'balance';
    const zh = {
      'balance.label': '余额',
      'today.spent': '今日花费',
      'unavailable': '余额不可用',
      'top.up': '充值',
      'low.balance': '余额不足,请充值',
      'yearly.tokens': '近一年Token',
      'yearly.cost': '近一年费用',
      'refresh': '刷新',
      'refreshing': '更新中…',
      'no.data': '点击刷新获取',
      'last.update': '更新于',
      'usage.failed': '用量获取失败',
      'token.breakdown': '缓存命中 {hit} · 未命中 {miss} · 输出 {out}',
      'settings.label': '余额监控',
      'settings.intro': '调整余额卡片的刷新频率与提醒方式。',
      'settings.poll': '自动刷新间隔(秒)',
      'settings.poll.hint': '每隔这么多秒自动刷新一次余额',
      'settings.threshold': '余额提醒阈值',
      'settings.threshold.hint': '余额低于这个数时,卡片会显示充值提醒',
      'settings.token': '平台登录 Token',
      'settings.token.placeholder': '粘贴 Token…',
      'settings.token.hint': '用于「近一年用量」统计;不填保存 = 保持现状,填了保存 = 覆盖旧值。',
      'settings.token.howto': '获取方法:登录 platform.deepseek.com → 按 F12 → Console 输入 localStorage.getItem("userToken") → 复制 value 里那串字符。',
      'settings.token.configured': '已配置',
      'settings.token.unset': '未配置',
      'settings.token.skWarning': '这是 API Key,不是平台登录 Token,请勿填写',
      'settings.token.tooShort': 'Token 太短,请检查是否复制完整',
      'settings.save': '保存设置',
      'settings.test': '测试登录 Token',
      'settings.testing': '测试中…',
      'settings.saved': '已保存',
      'settings.error': '保存失败',
      'settings.invalidPoll': '刷新间隔需为 5–3600 之间的整数(秒)',
      'settings.invalidThreshold': '提醒阈值需为不小于 0 的数字',
      'settings.test.ok': 'token 有效',
      'settings.test.fail': 'token 无效: {msg}',
    };
    const en = {
      'balance.label': 'Balance',
      'today.spent': 'Spent today',
      'unavailable': 'Balance unavailable',
      'top.up': 'Top up',
      'low.balance': 'Low balance — top up',
      'yearly.tokens': 'Tokens (12mo)',
      'yearly.cost': 'Cost (12mo)',
      'refresh': 'Refresh',
      'refreshing': 'Updating…',
      'no.data': 'Click refresh',
      'last.update': 'Updated',
      'usage.failed': 'Usage fetch failed',
      'token.breakdown': 'Cache hit {hit} · Miss {miss} · Output {out}',
      'settings.label': 'Balance Monitor',
      'settings.intro': 'Tune how the balance card refreshes and reminds you.',
      'settings.poll': 'Refresh interval (seconds)',
      'settings.poll.hint': 'How often the balance refreshes automatically',
      'settings.threshold': 'Low-balance reminder threshold',
      'settings.threshold.hint': 'Show the top-up reminder when balance falls below this',
      'settings.token': 'Platform login token',
      'settings.token.placeholder': 'Paste token…',
      'settings.token.hint': 'Used for the 12-month usage stats. Leave empty to keep the current token; enter a new one to replace it.',
      'settings.token.howto': 'How to get it: sign in at platform.deepseek.com → press F12 → Console → run localStorage.getItem("userToken") → copy the string inside value.',
      'settings.token.configured': 'Configured',
      'settings.token.unset': 'Not set',
      'settings.token.skWarning': 'That is an API key, not the platform login token. Do not use it here.',
      'settings.token.tooShort': 'Token looks too short — check you copied it fully.',
      'settings.save': 'Save settings',
      'settings.test': 'Test login token',
      'settings.testing': 'Testing…',
      'settings.saved': 'Saved',
      'settings.error': 'Save failed',
      'settings.invalidPoll': 'Interval must be an integer between 5 and 3600 seconds',
      'settings.invalidThreshold': 'Threshold must be a number >= 0',
      'settings.test.ok': 'Token is valid',
      'settings.test.fail': 'Token invalid: {msg}',
    };

    // DeepSeek platform top-up page (opens in a new tab).
    const TOP_UP_URL = 'https://platform.deepseek.com/top_up';

    // Below this remaining balance (in the account currency) the card shows
    // the big blue low-balance reminder above the amount. Both defaults are
    // overridable from the plugin's settings page.
    const LOW_BALANCE_THRESHOLD = 1;

    // Fallback balance poll interval: the card re-queries the live balance
    // every POLL_MS (default 60s). The rolling 12-month usage is NOT polled —
    // it refreshes on page load and on the ↻ button click.
    const POLL_MS = 60000;

    // ---- plugin config store ----------------------------------------------
    // The settings page writes the saved config here so the sidebar card
    // applies the new poll interval / threshold without a page reload. The
    // store lives for the lifetime of this bundle (one page load).
    const configStore = { value: null, subs: new Set() };
    function setPluginConfig(value) {
      configStore.value = value;
      for (const sub of configStore.subs) sub(value);
    }
    function usePluginConfig() {
      const [value, setValue] = useState(configStore.value);
      useEffect(() => {
        configStore.subs.add(setValue);
        return () => configStore.subs.delete(setValue);
      }, []);
      return value;
    }

    const symbolOf = (currency) => (currency === 'USD' ? '$' : '¥');

    const fmt = (n, currency) => `${symbolOf(currency)}${n.toFixed(2)}`;

    /** Human token count: 亿 / 万 / raw, one decimal. */
    const fmtTokens = (n) => {
      const v = Number(n) || 0;
      if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
      if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
      return `${Math.round(v)}`;
    };

    const fmtTime = (ts) => {
      if (!ts) return '';
      const d = new Date(ts);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${mm}-${dd} ${hh}:${mi}`;
    };

    /**
     * Compact form for the collapsed 36px rail: stair-stepped precision,
     * always floored so the shown value never overstates the balance.
     * ≤5 glyphs ("¥" + 4) fits the rail at 11px; the exact value lives in
     * the tooltip.
     *   < 10        → ¥1.69 (2 decimals, exact)
     *   10–99       → ¥12.3 (1 decimal)
     *   100–9999    → ¥123 / ¥1000 (integer)
     *   ≥ 10000     → ¥12k (integer k)
     */
    const compact = (n, currency) => {
      const s = symbolOf(currency);
      if (n >= 10000) return `${s}${Math.floor(n / 1000)}k`;
      if (n >= 100) return `${s}${Math.floor(n)}`;
      if (n >= 10) return `${s}${Math.floor(n * 10) / 10}`;
      return `${s}${n.toFixed(2)}`;
    };

    /** Remaining fraction of the day-start baseline, clamped to [0, 1]. */
    const ratioOf = (snap) => {
      if (!snap || !(snap.dayStart > 0)) return 0;
      return Math.min(1, Math.max(0, snap.total / snap.dayStart));
    };

    const fillColor = (ratio) =>
      ratio >= 0.2
        ? 'var(--dsw-static-deepseek-500)'
        : ratio >= 0.1
          ? 'var(--dsw-static-amber-500)'
          : 'var(--dsw-static-red-500)';

    const trackStyle = {
      width: '100%',
      height: 3,
      borderRadius: 999,
      background: 'var(--dsw-alias-border-l2)',
      overflow: 'hidden',
      opacity: 0.9,
    };

    const fillStyle = (ratio, stale) => ({
      height: '100%',
      borderRadius: 999,
      background: stale ? 'var(--dsw-alias-label-tertiary)' : fillColor(ratio),
      width: `${(ratio * 100).toFixed(1)}%`,
      transition: 'width 300ms ease',
      opacity: stale ? 0.55 : 1,
    });

    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      width: '100%',
      minWidth: 0,
      padding: '8px 10px',
      borderRadius: 12,
      boxSizing: 'border-box',
    };

    const rowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 8,
      minWidth: 0,
    };

    const labelStyle = {
      fontSize: 12,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary)',
      whiteSpace: 'nowrap',
    };

    const valueStyle = (stale) => ({
      fontSize: 14,
      lineHeight: '18px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      opacity: stale ? 0.55 : 1,
    });

    const spentStyle = {
      fontSize: 11,
      lineHeight: '14px',
      color: 'var(--dsw-alias-label-tertiary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    };

    // Small inline "top up" link, right-aligned on the spent row.
    const topUpLinkStyle = {
      flex: 'none',
      fontSize: 11,
      lineHeight: '14px',
      fontWeight: 600,
      color: 'var(--dsw-alias-button-info-fill)',
      cursor: 'pointer',
      textDecoration: 'none',
      userSelect: 'none',
    };

    // Refresh button: the only way to hit DeepSeek from this card.
    const refreshBtnStyle = {
      flex: 'none',
      width: 22,
      height: 22,
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
      lineHeight: '20px',
      padding: 0,
      cursor: 'pointer',
      userSelect: 'none',
    };

    const refreshBtnDisabledStyle = {
      ...refreshBtnStyle,
      opacity: 0.5,
      cursor: 'default',
    };

    // Big blue low-balance reminder shown above the amount (also a link to
    // the top-up page). The opacity is animated by BreathingReminder for a
    // gentle pulse; the transition lives here so it eases on both fade legs.
    const lowBalanceStyle = {
      fontSize: 18,
      lineHeight: '24px',
      fontWeight: 700,
      color: 'var(--dsw-alias-button-info-fill)',
      cursor: 'pointer',
      textDecoration: 'none',
      userSelect: 'none',
      transition: 'opacity 900ms ease, transform 900ms ease',
    };

    const railStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 36,
      height: 36,
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-secondary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      userSelect: 'none',
    };

    /**
     * Low-balance reminder with a clearly visible breathing pulse: opacity
     * drops to ~15% and the glyph shrinks a touch every 900ms (the CSS
     * transition does the easing). Clicking it opens the top-up page.
     */
    function BreathingReminder({ t }) {
      const [dim, setDim] = useState(false);
      useEffect(() => {
        const timer = window.setInterval(() => setDim((d) => !d), 900);
        return () => window.clearInterval(timer);
      }, []);
      return jsx('a', {
        href: TOP_UP_URL,
        target: '_blank',
        rel: 'noreferrer',
        style: {
          ...lowBalanceStyle,
          opacity: dim ? 0.15 : 1,
          transform: dim ? 'scale(0.97)' : 'scale(1)',
        },
        children: t('low.balance'),
      });
    }

    function BalanceCard({ wide, t, refresh }) {
      const [snap, setSnap] = useState(null);
      const [usage, setUsage] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const cfg = usePluginConfig();
      const pollMs = cfg && Number.isFinite(cfg.pollMs) ? cfg.pollMs : POLL_MS;
      const lowThreshold =
        cfg && Number.isFinite(cfg.lowBalanceThreshold) ? cfg.lowBalanceThreshold : LOW_BALANCE_THRESHOLD;

      // Show the last known numbers instantly (zero network), then fetch the
      // yearly usage once on every page load. Balance is freshened right away
      // by the 60s poll below.
      useEffect(() => {
        (async () => {
          try {
            const [s, u] = await Promise.all([
              refresh({ refresh: false }),
              refresh('usage', { refresh: false }),
            ]);
            if (s && s.ok && s.value) setSnap(s.value);
            if (u && u.ok && u.value) setUsage(u.value);
          } catch {
            // keep showing placeholders
          }
          try {
            const u = await refresh('usage', { refresh: true });
            if (u && u.ok && u.value) setUsage(u.value);
            else if (u && !u.ok && u.error) setUsage({ error: u.error.message });
          } catch {
            // keep the last known numbers
          }
        })();
      }, [refresh]);

      // Live balance polled every pollMs (real network query). Yearly usage
      // is fetched on mount (see above) and on the ↻ button; it is NOT part
      // of this poll.
      useEffect(() => {
        const tick = async () => {
          try {
            const s = await refresh({ refresh: true });
            if (s && s.ok && s.value) setSnap(s.value);
          } catch {
            // keep the last known numbers
          }
        };
        tick();
        const timer = window.setInterval(tick, pollMs);
        return () => window.clearInterval(timer);
      }, [refresh, pollMs]);

      const doRefresh = useCallback(async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
          const [s, u] = await Promise.all([
            refresh({ refresh: true }),
            refresh('usage', { refresh: true }),
          ]);
          if (s && s.ok && s.value) setSnap(s.value);
          if (u && u.ok && u.value) setUsage(u.value);
          else if (u && !u.ok && u.error) setUsage({ error: u.error.message });
        } catch {
          // keep the last known numbers
        } finally {
          setRefreshing(false);
        }
      }, [refresh, refreshing]);

      if (!wide) {
        return jsx(
          'div',
          {
            style: { ...railStyle, cursor: 'pointer' },
            title: snap ? `${t('balance.label')} ${fmt(snap.total, snap.currency)}` : t('unavailable'),
            onClick: () => window.open(TOP_UP_URL, '_blank', 'noreferrer'),
            children: snap ? compact(snap.total, snap.currency) : '—',
          },
        );
      }

      const ratio = ratioOf(snap);
      const stale = snap ? snap.stale === true : false;

      const totals = usage && usage.totals ? usage.totals : null;
      const totalTokens = totals ? totals.cacheHit + totals.cacheMiss + totals.response : null;
      const usageError = usage && usage.error ? usage.error : null;

      const tokenTitle = totals
        ? t('token.breakdown')
            .replace('{hit}', fmtTokens(totals.cacheHit))
            .replace('{miss}', fmtTokens(totals.cacheMiss))
            .replace('{out}', fmtTokens(totals.response))
        : '';

      return jsxs('div', {
        style: cardStyle,
        children: [
          snap && snap.total < lowThreshold
            ? jsx(BreathingReminder, { t })
            : null,
          jsxs('div', {
            style: { ...rowStyle, alignItems: 'center' },
            children: [
              jsx('span', { style: labelStyle, children: t('balance.label') }),
              jsx('strong', {
                style: { ...valueStyle(stale), flex: '1', textAlign: 'right' },
                children: snap ? fmt(snap.total, snap.currency) : '—',
              }),
              jsx('button', {
                type: 'button',
                style: refreshing ? refreshBtnDisabledStyle : refreshBtnStyle,
                title: refreshing ? t('refreshing') : t('refresh'),
                disabled: refreshing,
                onClick: doRefresh,
                children: refreshing ? '…' : '↻',
              }),
            ],
          }),
          jsx('div', {
            style: trackStyle,
            children: jsx('div', { style: fillStyle(ratio, stale) }),
          }),
          jsxs('div', {
            style: { ...spentStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
            children: [
              jsx('span', {
                style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
                children: snap ? `${t('today.spent')} ${fmt(snap.spent, snap.currency)}` : t('unavailable'),
              }),
              jsx('a', {
                href: TOP_UP_URL,
                target: '_blank',
                rel: 'noreferrer',
                style: topUpLinkStyle,
                children: t('top.up'),
              }),
            ],
          }),
          jsxs('div', {
            style: rowStyle,
            title: tokenTitle,
            children: [
              jsx('span', { style: spentStyle, children: t('yearly.tokens') }),
              jsx('span', {
                style: { ...spentStyle, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
                children: totalTokens != null ? fmtTokens(totalTokens) : '—',
              }),
            ],
          }),
          jsxs('div', {
            style: rowStyle,
            title: usage && usage.period ? `${usage.period.from} ~ ${usage.period.to}` : '',
            children: [
              jsx('span', { style: spentStyle, children: t('yearly.cost') }),
              jsx('span', {
                style: { ...spentStyle, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
                children: totals ? fmt(totals.cost, usage.currency || 'CNY') : '—',
              }),
            ],
          }),
          jsx('div', {
            style: { ...spentStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
            children: [
              jsx('span', {
                style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
                children: usageError
                  ? t('usage.failed')
                  : usage && usage.fetchedAt
                    ? `${t('last.update')} ${fmtTime(usage.fetchedAt)}`
                    : t('no.data'),
              }),
            ],
          }),
        ],
      });
    }

    // ---- settings page ----------------------------------------------------

    const settingsSectionStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      width: '100%',
      maxWidth: 720,
      boxSizing: 'border-box',
    };

    const settingsTitleStyle = {
      margin: 0,
      fontSize: 16,
      lineHeight: '24px',
      fontWeight: 500,
      color: 'var(--dsw-alias-label-primary)',
    };

    const settingsIntroStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    };

    const settingsCardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: '12px 14px',
      borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l2)',
    };

    const settingsFieldRowStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    };

    const settingsFieldLabelStyle = {
      fontSize: 12,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
    };

    const settingsInputStyle = {
      boxSizing: 'border-box',
      width: '100%',
      padding: '6px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      lineHeight: '20px',
      outline: 'none',
    };

    const settingsHintStyle = {
      margin: 0,
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary)',
    };

    const settingsStatusStyle = (ok) => ({
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
    });

    const settingsPrimaryBtnStyle = {
      height: 32,
      padding: '0 14px',
      borderRadius: 16,
      border: 'none',
      background: 'var(--dsw-alias-button-primary-fill)',
      color: 'var(--dsw-alias-label-primary-foreground)',
      fontSize: 13,
      lineHeight: '20px',
      fontWeight: 600,
      cursor: 'pointer',
      userSelect: 'none',
    };

    const settingsSecondaryBtnStyle = {
      height: 32,
      padding: '0 14px',
      borderRadius: 16,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
      userSelect: 'none',
    };

    const settingsBtnDisabledStyle = {
      opacity: 0.5,
      cursor: 'default',
    };

    const settingsButtonsRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginTop: 2,
    };

    function SettingsPage({ t, refresh }) {
      const [pollSec, setPollSec] = useState('60');
      const [threshold, setThreshold] = useState('1');
      const [token, setToken] = useState('');
      const [status, setStatus] = useState(null);
      const [saving, setSaving] = useState(false);
      const [testing, setTesting] = useState(false);
      const [meta, setMeta] = useState(null);

      useEffect(() => {
        (async () => {
          try {
            const r = await refresh('config', { action: 'get' });
            if (r && r.ok && r.value) {
              const v = r.value;
              setPollSec(String(Math.round(v.pollMs / 1000)));
              setThreshold(String(v.lowBalanceThreshold));
              setMeta({
                tokenConfigured: v.tokenConfigured,
                tokenPreview: v.tokenPreview,
                tokenSource: v.tokenSource,
              });
            }
          } catch {
            // keep the defaults
          }
        })();
      }, [refresh]);

      // Validate the form and persist it. Returns { ok: boolean }; on failure
      // it sets the error status itself. Used by both save() and testToken()
      // so a test always runs against the just-saved token.
      const persist = async () => {
        const sec = Math.round(Number(pollSec));
        const th = Number(threshold);
        if (!Number.isFinite(sec) || sec < 5 || sec > 3600) {
          setStatus({ ok: false, message: t('settings.invalidPoll') });
          return { ok: false };
        }
        if (!Number.isFinite(th) || th < 0) {
          setStatus({ ok: false, message: t('settings.invalidThreshold') });
          return { ok: false };
        }
        const patch = { pollMs: sec * 1000, lowBalanceThreshold: th };
        const tokenValue = token.trim();
        if (tokenValue) {
          if (tokenValue.startsWith('sk-')) {
            setStatus({ ok: false, message: t('settings.token.skWarning') });
            return { ok: false };
          }
          if (tokenValue.length < 8) {
            setStatus({ ok: false, message: t('settings.token.tooShort') });
            return { ok: false };
          }
          patch.platformToken = tokenValue;
        }
        setSaving(true);
        setStatus(null);
        try {
          const r = await refresh('config', { action: 'set', config: patch });
          if (r && r.ok) {
            const g = await refresh('config', { action: 'get' });
            if (g && g.ok && g.value) {
              const v = g.value;
              setPollSec(String(Math.round(v.pollMs / 1000)));
              setThreshold(String(v.lowBalanceThreshold));
              setMeta({
                tokenConfigured: v.tokenConfigured,
                tokenPreview: v.tokenPreview,
                tokenSource: v.tokenSource,
              });
              setPluginConfig(v);
            }
            return { ok: true };
          }
          setStatus({ ok: false, message: (r && r.error && r.error.message) || t('settings.error') });
          return { ok: false };
        } catch {
          setStatus({ ok: false, message: t('settings.error') });
          return { ok: false };
        } finally {
          setSaving(false);
        }
      };

      const save = async () => {
        const result = await persist();
        if (result.ok) {
          setStatus({ ok: true, message: t('settings.saved') });
          setToken('');
        }
      };

      // Test the login token: persist the current form first (so a newly
      // typed token is what gets tested), then validate it against the
      // platform.
      const testToken = async () => {
        const result = await persist();
        if (!result.ok) return;
        setTesting(true);
        setStatus(null);
        try {
          const r = await refresh('config', { action: 'test' });
          if (r && r.ok && r.value) {
            setStatus(
              r.value.valid
                ? { ok: true, message: t('settings.test.ok') }
                : { ok: false, message: t('settings.test.fail').replace('{msg}', r.value.message || '') },
            );
          } else {
            setStatus({ ok: false, message: (r && r.error && r.error.message) || t('settings.error') });
          }
        } catch {
          setStatus({ ok: false, message: t('settings.error') });
        } finally {
          setTesting(false);
        }
      };

      const tokenStatusText = meta
        ? meta.tokenConfigured
          ? t('settings.token.configured')
          : t('settings.token.unset')
        : '—';

      return jsxs('div', {
        style: settingsSectionStyle,
        children: [
          jsx('h2', { style: settingsTitleStyle, children: t('settings.label') }),
          jsx('p', { style: settingsIntroStyle, children: t('settings.intro') }),
          jsxs('div', {
            style: settingsCardStyle,
            children: [
              jsxs('div', {
                style: settingsFieldRowStyle,
                children: [
                  jsx('label', { style: settingsFieldLabelStyle, children: t('settings.poll') }),
                  jsx('input', {
                    type: 'number',
                    min: 5,
                    max: 3600,
                    step: 5,
                    value: pollSec,
                    onChange: (e) => setPollSec(e.target.value),
                    style: settingsInputStyle,
                  }),
                  jsx('p', { style: settingsHintStyle, children: t('settings.poll.hint') }),
                ],
              }),
              jsxs('div', {
                style: settingsFieldRowStyle,
                children: [
                  jsx('label', { style: settingsFieldLabelStyle, children: t('settings.threshold') }),
                  jsx('input', {
                    type: 'number',
                    min: 0,
                    step: 0.5,
                    value: threshold,
                    onChange: (e) => setThreshold(e.target.value),
                    style: settingsInputStyle,
                  }),
                  jsx('p', { style: settingsHintStyle, children: t('settings.threshold.hint') }),
                ],
              }),
              jsxs('div', {
                style: settingsFieldRowStyle,
                children: [
                  jsxs('label', {
                    style: settingsFieldLabelStyle,
                    children: [
                      t('settings.token'),
                      ' — ',
                      tokenStatusText,
                      meta && meta.tokenPreview ? ` (${meta.tokenPreview})` : '',
                    ],
                  }),
                  jsx('input', {
                    type: 'password',
                    value: token,
                    placeholder: t('settings.token.placeholder'),
                    onChange: (e) => setToken(e.target.value),
                    style: settingsInputStyle,
                    autoComplete: 'off',
                    spellCheck: false,
                  }),
                  token.trim().startsWith('sk-')
                    ? jsx('p', {
                        style: { ...settingsHintStyle, color: 'var(--dsw-alias-state-error-primary)' },
                        children: t('settings.token.skWarning'),
                      })
                    : null,
                  jsx('p', { style: settingsHintStyle, children: t('settings.token.hint') }),
                  jsx('p', { style: settingsHintStyle, children: t('settings.token.howto') }),
                ],
              }),
            ],
          }),
          status ? jsx('p', { style: settingsStatusStyle(status.ok), children: status.message }) : null,
          jsxs('div', {
            style: settingsButtonsRowStyle,
            children: [
              jsx('button', {
                type: 'button',
                style: saving ? { ...settingsPrimaryBtnStyle, ...settingsBtnDisabledStyle } : settingsPrimaryBtnStyle,
                disabled: saving,
                onClick: save,
                children: saving ? '…' : t('settings.save'),
              }),
              jsx('button', {
                type: 'button',
                style: testing ? { ...settingsSecondaryBtnStyle, ...settingsBtnDisabledStyle } : settingsSecondaryBtnStyle,
                disabled: testing,
                onClick: testToken,
                children: testing ? t('settings.testing') : t('settings.test'),
              }),
            ],
          }),
        ],
      });
    }

    const inject = ['connection', 'slots', 'locale'];

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'balance-monitor: dictionaries',
      );

      const connection = ctx.get('connection');
      const refresh = (endpoint, payload) =>
        connection.rpc.call('/balance', typeof endpoint === 'string' ? endpoint : 'snapshot', payload || {});
      const t = ctx.locale.bind(NS);

      // Load plugin settings once so the card applies the saved poll interval
      // and low-balance threshold without a manual page reload.
      (async () => {
        try {
          const r = await refresh('config', { action: 'get' });
          if (r && r.ok && r.value) setPluginConfig(r.value);
        } catch {
          // fall back to defaults
        }
      })();

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'balance-monitor',
          locale: NS,
          inject: () => ({ refresh }),
        },
        BalanceCard,
      ));

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'balance-monitor',
          order: 50,
          label: () => t('settings.label'),
          inject: () => ({ refresh, t }),
        },
        SettingsPage,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
