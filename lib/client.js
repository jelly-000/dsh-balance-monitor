// dsh-balance-monitor — browser half.
//
// One sidebar footer card plus two floating panels, all served by the single
// host channel /balances:
//   * every row carries one-click mode chips (Coding Plan <-> API 按量) — the
//     host persists the pick and answers with that endpoint's numbers;
//   * "Token 活动" opens a contribution-graph dashboard built from DSH's own
//     session logs (累计 / 峰值 / 最长聊天 / 连续天数 + 每日·每周·累计 heatmap);
//   * "平台设置" toggles vendors and registers a generic custom provider
//     (baseURL + path + keyEnv + auth + field mapping) for any gateway that is
//     not in the built-in list.
//
// Keys never reach the browser: every mutation is an RPC the host performs.
// Hand-written classic-script bundle; no build step.

window.__ModuleLoader__.load({
  id: 'dsh-balance-monitor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const { jsx, jsxs } = require('react/jsx-runtime');
    const { useEffect, useState } = require('react');
    const { createRoot } = require('react-dom/client');

    const NS = 'balance';
    const zh = {
      'title': '余额 / 用量',
      'unavailable': '余额不可用',
      'noKey': '未配置任何平台 Key',
    };
    const en = {
      'title': 'Balance / Usage',
      'unavailable': 'Balance unavailable',
      'noKey': 'No provider key configured',
    };

    const POLL_MS = 60000;
    const PANEL_OPEN_KEY = 'dsh-balance-monitor.panel';

    // ---------------------------------------------------------------- text --

    const DICT = {
      usageBtn: ['Token 活动', 'Tokens'],
      needRestart: ['宿主版本较旧：重启 DSH 后此功能可用', 'Older host running — restart DSH to enable this'],
    cacheRead: ['缓存读', 'Cache read'],
    notCounted: ['（未计入）', ' (not counted)'],
      todaySpent: ['今日已用', 'Spent today'],
      unavailable: ['余额不可用', 'Balance unavailable'],
      refreshBtn: ['刷新', 'Refresh'],
      close: ['关闭', 'Close'],
      usageTitle: ['Token 活动', 'Token activity'],
      totalTokens: ['累计 Token 数', 'Total tokens'],
      peakTokens: ['峰值 Token 数', 'Peak day'],
      longestChat: ['最长聊天时长', 'Longest chat'],
      currentStreak: ['当前连续天数', 'Current streak'],
      longestStreak: ['最长连续天数', 'Longest streak'],
      daily: ['每日', 'Daily'],
      weekly: ['每周', 'Weekly'],
      cumulative: ['累计', 'Cumulative'],
      less: ['少', 'Less'],
      more: ['多', 'More'],
      footnote: ['数据来自本机 DSH 会话日志，只统计已记录的请求', 'Measured from this machine’s DSH session logs'],
      loading: ['正在统计本地会话日志…', 'Scanning local session logs…'],
      scanError: ['读不到会话日志', 'Session logs unreadable'],
      providers: ['平台', 'Providers'],
      models: ['模型', 'Models'],
      tokens: ['Token', 'Tokens'],
      requests: ['请求', 'Requests'],
      activeDays: ['活跃天数', 'Active days'],
      todayTokens: ['今日', 'today'],
      pending: ['统计中…', 'scanning…'],
      switchMode: ['切换计费方式', 'Switch billing mode'],
      costWindow: ['近 30 天', '30d'],
      requestsUnit: [' 次请求', ' req'],
      turnsUnit: [' 轮', ' turns'],
      turnsTotal: ['对话轮次', 'Turns'],
      chatTotal: ['聊天总时长', 'Total chat'],
      sessionsTotal: ['会话数', 'Sessions'],
    };

    const LANG = String(navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 ? 0 : 1;
    const tr = (key) => (DICT[key] ? DICT[key][LANG] : key);
    const DAY_UNIT = LANG === 0 ? '天' : 'd';

    // ------------------------------------------------------------- numbers --

    const symbolOf = (currency) => (currency === 'USD' ? '$' : currency === 'TOKEN' ? '' : '¥');
    const num = (n) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(2));
    const currencyless = (n) => String(Math.round(n));
    const fmt = (n, currency) => (n == null ? '—' : currency === 'QTY' || currency === 'TOKEN' ? currencyless(n) : (n < 0 ? '-' : '') + symbolOf(currency) + num(Math.abs(n)));

    const trimOne = (value) => String(Math.round(value * 10) / 10);

    /** 亿 / 万 (zh) or B / M / k (en) — the dashboard headline scale. */
    function compactTokens(n) {
      if (n == null || !Number.isFinite(Number(n))) return '—';
      const value = Number(n);
      if (LANG === 0) {
        if (value >= 1e8) return trimOne(value / 1e8) + '亿';
        if (value >= 1e4) return trimOne(value / 1e4) + '万';
        return currencyless(value);
      }
      if (value >= 1e9) return trimOne(value / 1e9) + 'B';
      if (value >= 1e6) return trimOne(value / 1e6) + 'M';
      if (value >= 1e3) return trimOne(value / 1e3) + 'k';
      return currencyless(value);
    }

    const compact = (n, currency) => {
      if (n == null) return '—';
      if (currency === 'TOKEN') return compactTokens(n);
      // An overdrawn account reads -¥0.33, not ¥-0.33.
      const sign = n < 0 ? '-' : '';
      const value = Math.abs(n);
      const s = symbolOf(currency);
      if (currency === 'QTY') return currencyless(value) + '%';
      if (value >= 10000) return sign + s + Math.floor(value / 1000) + 'k';
      if (value >= 100) return sign + s + Math.floor(value);
      if (value >= 10) return sign + s + (Math.floor(value * 10) / 10);
      return sign + s + value.toFixed(1);
    };

    function fmtDuration(ms) {
      if (!ms || ms < 0) return '—';
      const total = Math.floor(ms / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (LANG === 0) {
        if (h > 0) return h + '小时' + (m ? m + '分' : '');
        if (m > 0) return m + '分' + (s ? s + '秒' : '');
        return s + '秒';
      }
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    const fmtCountdown = (ms) => {
      const t = Math.max(0, Math.floor(ms / 1000));
      const d = Math.floor(t / 86400);
      const h = Math.floor((t % 86400) / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = t % 60;
      if (d > 0) return d + 'd ' + h + 'h';
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    };

    const MONTHS_ZH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthLabel = (month) => (LANG === 0 ? MONTHS_ZH[month] : MONTHS_EN[month]);

    const localDate = (ms) => {
      const d = new Date(ms);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };

    // ---------------------------------------------------------- panel bus --

    const bus = {
      panel: null,
      call: null,
      snapshot: null,
      listeners: new Set(),
      open(name, snapshot) {
        this.panel = this.panel === name ? null : name;
        if (snapshot) this.snapshot = snapshot;
        try { window.sessionStorage.setItem(PANEL_OPEN_KEY, this.panel || ''); } catch (e) { /* private mode */ }
        this.emit();
      },
      close() {
        this.panel = null;
        try { window.sessionStorage.setItem(PANEL_OPEN_KEY, ''); } catch (e) { /* private mode */ }
        this.emit();
      },
      setSnapshot(snapshot) {
        this.snapshot = snapshot;
        this.emit();
      },
      emit() {
        this.listeners.forEach((fn) => fn());
      },
      subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      },
    };

    // ------------------------------------------------------------- styles --

    const ratioOf = (snap) => {
      if (!snap || !(snap.total > 0)) return 0;
      return Math.min(1, Math.max(0, snap.remaining / snap.total));
    };

    const fillColor = (ratio) =>
      ratio >= 0.2 ? 'var(--dsw-alias-state-business-primary)' : ratio >= 0.1 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)';

    const dotColor = (snap) => {
      if (snap.stale) return 'var(--dsw-alias-label-tertiary)';
      if (snap.kind === 'local') return 'var(--dsw-alias-state-business-primary)';
      if (snap.kind === 'cost' || !(snap.total > 0)) return 'var(--dsw-alias-border-l2)';
      return fillColor(ratioOf(snap));
    };

    const SANS = "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif)";
    const MONO = "var(--ds-font-family-code, 'SF Mono', ui-monospace, Menlo, Consolas, monospace)";

    const cardStyle = { display: 'flex', flexDirection: 'column', gap: 6, width: '100%', minWidth: 0, padding: '8px 10px', borderRadius: 12, boxSizing: 'border-box' };

    const headerStyle = {
      fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 600, letterSpacing: 0.02,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
    };

    const blockStyle = { display: 'flex', flexDirection: 'column', gap: 4, width: '100%', minWidth: 0, padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' };
    const headRow = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, minWidth: 0 };
    const labelStyle = { fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-label-secondary)', fontWeight: 600, whiteSpace: 'nowrap' };
    const valueStyle = (stale) => ({ fontSize: 13, lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', opacity: stale ? 0.55 : 1 });
    const subStyle = (stale) => ({ fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: stale ? 0.55 : 1 });
    const detailStyle = { fontSize: 10, lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
    const errorStyle = { fontSize: 10, lineHeight: '14px', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
    const resetStyle = { fontSize: 10, lineHeight: '14px', color: 'var(--dsw-alias-state-warn-label)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
    const emptyStyle = { fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary)' };
    const railStyle = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 999, boxSizing: 'border-box', overflow: 'hidden' };
    const iconBtnStyle = {
      fontSize: 10, lineHeight: '14px', padding: '1px 4px', borderRadius: 6, border: '1px solid transparent',
      background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontFamily: SANS, whiteSpace: 'nowrap',
    };
    /** Frosted-glass action pill (Apple-style): an obvious, clickable control. */
    const actionBtn = {
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px',
      borderRadius: 999, cursor: 'pointer', fontFamily: SANS, fontSize: 10, lineHeight: '12px',
      fontWeight: 500, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap',
      WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
      background: 'linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent), color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent))',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
    };
    /** Bound the vendor list so the card always fits in the sidebar. */
    const rowsScrollStyle = { maxHeight: 'min(46vh, 320px)', overflowY: 'auto', display: 'flex', flexDirection: 'column' };
    const dotStack = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 };
    const dotStyle = (snap) => ({ width: 6, height: 6, borderRadius: 999, background: dotColor(snap), flexShrink: 0 });
    const railWrapStyle = { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' };
    const collapsedRow = { display: 'flex', alignItems: 'center', gap: 4 };
    const collapsedValue = { fontSize: 10, lineHeight: '14px', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' };
    const moreTickStyle = { fontSize: 10, lineHeight: '12px', color: 'var(--dsw-alias-label-tertiary)' };
    const tooltipStyle = {
      position: 'absolute', left: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)', padding: '6px 8px',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l3)',
      borderRadius: 8, fontSize: 11, lineHeight: '15px', zIndex: 999, whiteSpace: 'nowrap', boxShadow: 'var(--dsw-shadow-lv3, 0 4px 14px rgba(0, 0, 0, 0.18))',
    };
    const tooltipRow = { fontVariantNumeric: 'tabular-nums' };


    const backdropStyle = {
      position: 'fixed', inset: 0, background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))', zIndex: 2147483000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: SANS,
    };

    const panelStyle = {
      width: 'min(940px, 96vw)', maxHeight: 'min(86vh, 780px)', overflow: 'auto',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12,
      boxShadow: 'var(--dsw-shadow-lv3, 0 18px 48px rgba(0, 0, 0, 0.4))', boxSizing: 'border-box', padding: '14px 16px 18px',
    };

    const panelHead = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' };
    const panelTitle = { fontSize: 13, fontWeight: 600 };
    const statCard = { flex: '1 1 0', minWidth: 0, padding: '0 12px 0 0', boxSizing: 'border-box' };
    const statLabel = { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
    const statValue = { fontSize: 18, lineHeight: '24px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
    const statNote = { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
    const segStyle = { display: 'inline-flex', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', overflow: 'hidden' };
    const segItem = (active) => ({
      fontSize: 10, lineHeight: '18px', padding: '2px 10px', border: 'none', cursor: 'pointer', fontFamily: SANS,
      background: active ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
      color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)', fontWeight: active ? 600 : 400,
    });
    const HEAT_LEVELS = [0, 0.18, 0.38, 0.62, 0.86, 1];
    const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 11, fontVariantNumeric: 'tabular-nums' };
    const thStyle = { textAlign: 'left', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', fontWeight: 600, padding: '4px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2)' };
    const tdStyle = (right) => ({ textAlign: right ? 'right' : 'left', padding: '4px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' });
    const sectionTitle = { fontSize: 10, fontWeight: 600, marginBottom: 4, color: 'var(--dsw-alias-label-secondary)' };

    // ---------------------------------------------------------------- card --

    /** Circular gauge — same information as the bar, 16px of horizontal space. */
    /** Circular gauge — same information as the bar, 16px of horizontal space. */
    function Ring({ ratio, stale, title, size }) {
      const d = size || 16;
      const sw = d >= 14 ? 2 : 1.5;
      const r = (d - sw) / 2;
      const circumference = 2 * Math.PI * r;
      const clamped = Math.max(0, Math.min(1, ratio));
      return jsx('svg', {
        width: d,
        height: d,
        viewBox: '0 0 ' + d + ' ' + d,
        'aria-hidden': true,
        title,
        style: { flex: '0 0 auto', opacity: stale ? 0.55 : 1, transform: 'rotate(-90deg)' },
        children: [
          jsx('circle', { cx: d / 2, cy: d / 2, r, strokeWidth: sw, style: { fill: 'none', stroke: 'var(--dsw-alias-border-l3)' } }, 'track'),
          jsx('circle', {
            cx: d / 2, cy: d / 2, r, strokeWidth: sw, strokeLinecap: 'round',
            strokeDasharray: circumference, strokeDashoffset: circumference * (1 - clamped),
            style: { fill: 'none', stroke: stale ? 'var(--dsw-alias-label-tertiary)' : fillColor(clamped) },
          }, 'fill'),
        ],
      });
    }

    /** Tiny round affordance by the vendor name — the only mode UI in the card. */
    function ModeDot({ open, coding, title, onClick }) {
      const c = coding ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)';
      return jsx('button', {
        type: 'button',
        'aria-label': title,
        title,
        onClick: (event) => {
          event.stopPropagation();
          onClick();
        },
        style: {
          width: 16,
          height: 16,
          flex: '0 0 auto',
          marginLeft: 5,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 999,
          padding: 0,
          cursor: 'pointer',
          border: '1px solid color-mix(in srgb, ' + c + ' ' + (open ? 100 : 55) + '%, transparent)',
          background: open ? 'color-mix(in srgb, ' + c + ' 16%, transparent)' : 'transparent',
          transition: 'background 0.15s, border-color 0.15s',
        },
        children: jsx('span', {
          style: {
            width: 6,
            height: 6,
            display: 'block',
            borderRadius: 999,
            background: c,
            boxShadow: open ? '0 0 0 2px color-mix(in srgb, ' + c + ' 28%, transparent)' : 'none',
          },
        }),
      });
    }

    const modeItemStyle = (active) => ({
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      width: '100%',
      textAlign: 'left',
      padding: '4px 7px',
      borderRadius: 7,
      cursor: 'pointer',
      border: 'none',
      background: active ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 11,
      lineHeight: '15px',
      fontWeight: active ? 600 : 400,
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    });

    /** The small card that lists both billing modes for this vendor. */
    function ModePopover({ snap, onPick, onClose }) {
      return jsxs('div', {
        children: [
          jsx('div', { style: { position: 'fixed', inset: 0, zIndex: 30 }, onClick: onClose }, 'backdrop'),
          jsxs('div', {
            style: {
              position: 'absolute',
              left: 0,
              bottom: 16,
              zIndex: 31,
              minWidth: 132,
              padding: 3,
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
              boxShadow: 'var(--dsw-shadow-lv3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            },
            children: [
              (snap.modes || []).map((mode) =>
                jsxs('button', {
                  type: 'button',
                  style: modeItemStyle(mode.id === snap.mode),
                  onClick: (event) => {
                    event.stopPropagation();
                    if (mode.id !== snap.mode) onPick(snap.id, mode.id);
                    onClose();
                  },
                  children: [
                    jsx('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: mode.label }),
                    mode.note && mode.note !== mode.label
                      ? jsx('span', { style: { flex: '0 1 auto', fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '9em' }, children: mode.note })
                      : null,
                    jsx('span', {
                      style: { flex: '0 0 auto', width: 12, textAlign: 'center', fontSize: 11, color: 'var(--dsw-alias-state-business-primary)' },
                      children: mode.id === snap.mode ? '\u2713' : '',
                    }),
                  ],
                }, mode.id),
              ),
            ],
          }, 'card'),
        ],
      });
    }

    function modeLabelOf(snap, modeId) {
      const mode = (snap.modes || []).find((m) => m.id === modeId);
      return mode ? mode.label : String(modeId);
    }

    function headerButtons() {
      return jsx('div', {
        style: { display: 'flex', gap: 4 },
        children: [
          jsx('button', { type: 'button', style: actionBtn, title: tr('usageTitle'), onClick: () => bus.open('usage'), children: tr('usageBtn') }, 'usage'),
        ],
      });
    }

    function rowValue(s) {
      if (s.kind === 'local') return s.pending ? tr('pending') : compactTokens(s.tokens);
      if (s.kind === 'cost') return fmt(s.spent, s.currency);
      if (s.kind === 'quota') return s.remaining == null ? '—' : s.remaining + '%';
      return fmt(s.remaining, s.currency);
    }

    function rowSub(s) {
      if (s.kind === 'local') return tr('todayTokens') + ' ' + compactTokens(s.todayTokens) + ' · ' + (s.req || 0) + tr('requestsUnit');
      if (s.spent == null || !s.spentLabel) return s.error || '';
      return s.kind === 'quota' ? s.spentLabel + ' ' + s.spent + '%' : s.spentLabel + ' ' + fmt(s.spent, s.currency);
    }

    function BalancesCard({ wide, t, refresh, call }) {
      const [data, setData] = useState(null);
      const [hover, setHover] = useState(false);
      const [now, setNow] = useState(Date.now());
      const [busy, setBusy] = useState(null);
      const [modeOpen, setModeOpen] = useState(null);

      const publish = (result) => {
        if (!result || !result.ok) return result;
        setData(result);
        bus.setSnapshot(result);
        return result;
      };

      const tick = async () => {
        try {
          publish(await refresh());
        } catch (e) {
          /* keep the last known snapshot */
        }
      };

      const act = async (payload) => {
        setBusy(payload.id || payload.action || true);
        try {
          const result = await call(payload);
          publish(result);
          return result;
        } finally {
          setBusy(null);
        }
      };

      useEffect(() => {
        tick();
        const timer = window.setInterval(tick, POLL_MS);
        const onVisible = () => {
          if (document.visibilityState === 'visible') tick();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [refresh]);

      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
      }, []);

      const snaps = ((data && data.value) || []).filter((s) => s.hasKey !== false);
      const hint = data && data.hint;

      if (!wide) {
        if (!snaps.length) return jsx('div', { style: railStyle, title: hint || tr('unavailable'), children: '—' });
        const visible = snaps.slice(0, 5);
        const more = snaps.length > 5;
        return jsx('div', {
          style: railWrapStyle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          children: [
            jsx('div', {
              style: dotStack,
              children: visible
                .map((s) =>
                  jsx('div', {
                    style: collapsedRow,
                    children: [
                      jsx('span', { style: dotStyle(s) }),
                      jsx('span', {
                        style: collapsedValue,
                        children: s.kind === 'local' ? compactTokens(s.tokens) : s.remaining != null ? compact(s.remaining, s.currency) : s.spent != null ? compact(s.spent, s.currency) : '—',
                      }),
                    ],
                  }, s.id),
                )
                .concat(more ? [jsx('span', { style: moreTickStyle, children: '+' + (snaps.length - 5) }, 'more')] : []),
            }),
            hover
              ? jsx('div', {
                  style: tooltipStyle,
                  children: snaps.map((s) =>
                    jsx('div', {
                      style: tooltipRow,
                      children:
                        s.label +
                        (s.modes && s.modes.length > 1 ? ' [' + modeLabelOf(s, s.mode) + ']' : '') +
                        ' · ' +
                        (s.kind === 'local' ? compactTokens(s.tokens) + ' tokens' : s.remaining != null ? fmt(s.remaining, s.currency) : s.spent != null ? fmt(s.spent, s.currency) : '—') +
                        (s.detail && s.kind !== 'balance' ? ' (' + s.detail + ')' : '') +
                        (s.resetAt && s.resetAt > now ? ' ⟳ ' + fmtCountdown(s.resetAt - now) : ''),
                    }, s.id),
                  ),
                })
              : null,
          ],
        });
      }

      if (!snaps.length) {
        return jsxs('div', {
          style: cardStyle,
          children: [
            jsx('div', { style: headerStyle, children: [headerButtons()] }),
            jsx('div', { style: emptyStyle, children: hint || tr('unavailable') }),
          ],
        });
      }

      return jsxs('div', {
        style: cardStyle,
        children: [
          jsx('div', { style: headerStyle, children: [headerButtons()] }),
          jsx('div', { style: rowsScrollStyle, children: snaps.map((s, i) => {
            const local = s.kind === 'local';
            const hasGauge = !local && s.remaining != null && (s.total > 0 || s.remaining <= 0);
            const gaugeRatio = ratioOf(s);
            const windows = s.windows && s.windows.length > 1 ? s.windows : null;
            const multi = s.modes && s.modes.length > 1;
            return jsxs('div', {
              style: Object.assign({}, blockStyle, { position: 'relative' }, i === snaps.length - 1 ? { borderBottom: 'none' } : {}),
              children: [
                jsxs('div', {
                  style: headRow,
                  children: [
                    jsxs('span', {
                      style: labelStyle,
                      children: [
                        s.label,
                        multi
                          ? jsx(ModeDot, {
                              open: modeOpen === s.id,
                              coding: s.mode !== 'api',
                              title: modeLabelOf(s, s.mode) + ' · ' + tr('switchMode'),
                              onClick: () => setModeOpen(modeOpen === s.id ? null : s.id),
                            }, 'mode-dot')
                          : null,
                        busy === s.id ? jsx('span', { style: { marginLeft: 4, opacity: 0.6 }, children: '…' }) : null,
                      ],
                    }),
                    jsxs('strong', {
                      style: Object.assign({}, valueStyle(s.stale), { display: 'flex', alignItems: 'center', gap: 6 }),
                      children: [
                        rowValue(s),
                        local ? jsx('span', { style: { fontSize: 10, fontWeight: 400, marginLeft: 3, opacity: 0.7 }, children: 'tokens' }) : null,
                        s.kind === 'cost' ? jsx('span', { style: { fontSize: 10, fontWeight: 400, marginLeft: 3, opacity: 0.7 }, children: tr('costWindow') }) : null,
                        hasGauge ? jsx(Ring, { ratio: gaugeRatio, stale: s.stale, title: Math.round(gaugeRatio * 100) + '%' }) : null,
                      ],
                    }),
                  ],
                }),
                windows
                  ? jsx('div', {
                      style: { display: 'flex', flexDirection: 'column', gap: 3 },
                      children: windows.map((w) =>
                        jsxs('div', {
                          style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
                          children: [
                            jsx(Ring, { ratio: w.usedPct == null ? 0 : 1 - w.usedPct / 100, stale: s.stale, size: 12, title: w.label + ' ' + (w.usedPct == null ? '—' : w.usedPct + '%') }),
                            jsx('span', { children: w.label }),
                            jsx('span', { style: { color: 'var(--dsw-alias-label-secondary)' }, children: w.total ? Math.round(w.remaining == null ? 0 : w.remaining) + '/' + Math.round(w.total) + (w.unit || '') : w.usedPct == null ? '—' : w.usedPct + '%' }),
                            jsx('span', { style: { marginLeft: 'auto' }, children: w.resetAt && w.resetAt > now ? '⟳ ' + fmtCountdown(w.resetAt - now) : '' }),
                          ],
                        }, w.label),
                      ),
                    })
                  : null,
                jsx('div', { style: subStyle(s.stale), children: rowSub(s) }),
                s.detail && s.kind !== 'balance' ? jsx('div', { style: detailStyle, children: s.detail }) : null,
                local && s.note ? jsx('div', { style: detailStyle, children: s.note }) : null,
                s.error && local ? jsx('div', { style: errorStyle, children: s.error }) : null,
                !windows && s.resetAt && s.resetAt > now ? jsx('div', { style: resetStyle, children: '⟳ 下次重置 ' + fmtCountdown(s.resetAt - now) }) : null,
                modeOpen === s.id && multi
                  ? jsx(ModePopover, {
                      snap: s,
                      onPick: (id, mode) => act({ action: 'setMode', id, mode }),
                      onClose: () => setModeOpen(null),
                    }, 'mode-popover')
                  : null,
              ],
            }, s.id);
          }) }),
        ],
      });
    }

    // ------------------------------------------------ token activity panel --

    const WEEKS_SHOWN = 52;
    const CELL = 12;

    /** 52 Monday-aligned columns ending in the current week (calendar maths, DST-safe). */
    function buildWeeks() {
      const today = new Date();
      const mondayOffset = (today.getDay() + 6) % 7;
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset - (WEEKS_SHOWN - 1) * 7);
      const columns = [];
      for (let w = 0; w < WEEKS_SHOWN; w++) {
        const cells = [];
        for (let d = 0; d < 7; d++) {
          const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
          cells.push({ key: localDate(date.getTime()), date });
        }
        columns.push(cells);
      }
      return columns;
    }

    function Heatmap({ days, metric }) {
      const byDate = {};
      days.forEach((d) => {
        byDate[d.date] = d;
      });

      const columns = buildWeeks();

      const weekTotals = columns.map((cells) =>
        cells.reduce((sum, cell) => {
          const day = byDate[cell.key];
          return sum + (day ? day.tokens || 0 : 0);
        }, 0),
      );

      let running = 0;
      const cumArr = days.map((day) => {
        running += day.tokens || 0;
        return { date: day.date, run: running };
      });
      const grandTotal = running;

      let max = 0;
      if (metric === 'cumulative') max = grandTotal;
      else if (metric === 'weekly') weekTotals.forEach((value) => { max = Math.max(max, value); });
      else days.forEach((day) => { max = Math.max(max, day.tokens || 0); });

      const valueFor = (cell, columnIndex) => {
        if (metric === 'weekly') return weekTotals[columnIndex] || 0;
        if (metric === 'cumulative') {
          let run = 0;
          for (const e of cumArr) {
            if (e.date <= cell.key) run = e.run;
            else break;
          }
          return run;
        }
        const day = byDate[cell.key];
        return day ? day.tokens || 0 : 0;
      };

      const levelOf = (value) => {
        if (!value || value <= 0 || !max) return 0;
        const ratio = Math.sqrt(Math.min(1, value / max));
        return ratio > 0.75 ? 5 : ratio > 0.5 ? 4 : ratio > 0.25 ? 3 : ratio > 0.05 ? 2 : 1;
      };

      // One label per month, thinned so a label never has to share fewer than
      // four columns of room with its neighbour (52 columns can be ~15px each).
      const monthMarks = [];
      let lastMonth = -1;
      columns.forEach((cells, index) => {
        const month = cells[0].date.getMonth();
        if (month === lastMonth) return;
        lastMonth = month;
        const label = monthLabel(month);
        const previous = monthMarks[monthMarks.length - 1];
        if (previous && previous.label === label) return;
        if (previous && index - previous.index < 4) previous.index = index;
        else monthMarks.push({ index, label });
      });

      const nowKey = localDate(Date.now());

      const GAP = 3;
      const RAIL = 26;
      const cols = 'repeat(' + columns.length + ', minmax(0, 1fr))';
      const monthAt = new Map(monthMarks.map((m) => [m.index, m.label]));

      return jsx('div', {
        style: { width: '100%', minWidth: 0 },
        children: jsx('div', {
          style: { display: 'grid', gridTemplateColumns: RAIL + 'px minmax(0, 1fr)', columnGap: GAP, rowGap: 3 },
          children: [
            jsx('div', {}, 'corner'),
            jsx('div', {
              style: { display: 'grid', gridTemplateColumns: cols, gap: GAP, minWidth: 0 },
              children: columns.map((cells, index) =>
                jsx('span', { style: { fontSize: 10, lineHeight: '12px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden' }, children: monthAt.get(index) || '' }, 'month-' + index),
              ),
            }, 'months'),
            jsx('div', {
              style: { display: 'grid', gridTemplateRows: 'repeat(7, ' + CELL + 'px)', gap: GAP },
              children: ['一', '二', '三', '四', '五', '六', '日'].map((label, index) =>
                jsx('span', { style: { height: CELL, lineHeight: CELL + 'px', fontSize: 9, color: 'var(--dsw-alias-label-tertiary)', textAlign: 'right' }, children: index % 2 === 0 ? label : '' }, label),
              ),
            }, 'weekdays'),
            jsx('div', {
              style: { display: 'grid', gridTemplateRows: 'repeat(7, ' + CELL + 'px)', gridAutoFlow: 'column', gridTemplateColumns: cols, gap: GAP, minWidth: 0 },
              children: columns.map((cells, columnIndex) =>
                cells.map((cell) => {
                  const day = byDate[cell.key];
                  const value = valueFor(cell, columnIndex);
                  const level = levelOf(value);
                  const future = cell.date.getTime() > Date.now();
                  const title =
                    cell.key +
                    (day
                      ? ' · ' + compactTokens(day.tokens) + ' tokens · ' + day.req + tr('requestsUnit') + ' · ' + day.turns + tr('turnsUnit') + ' · ' + fmtDuration(day.chatMs) + ' · ' + tr('cacheRead') + ' ' + compactTokens(day.cache)
                      : metric === 'weekly' && value
                        ? ' · ' + compactTokens(value) + ' tokens'
                        : '');
                  return jsx('div', {
                    title,
                    style: {
                      height: CELL,
                      borderRadius: 2,
                      background: future ? 'transparent' : level ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)',
                      opacity: future ? 0.12 : level ? HEAT_LEVELS[level] : 0.35,
                    },
                  }, cell.key);
                }),
              ),
            }, 'grid'),
            jsx('div', {
              style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, marginTop: 8, gridColumn: '1 / -1', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
              children: [
                jsx('div', {
                  style: { display: 'flex', alignItems: 'center', gap: 4 },
                  children: [
                    jsx('span', { children: tr('less') }),
                    [1, 2, 3, 4, 5].map((level) =>
                      jsx('span', { style: { width: CELL, height: CELL, borderRadius: 2, display: 'inline-block', background: 'var(--dsw-alias-state-business-primary)', opacity: HEAT_LEVELS[level] } }, level),
                    ),
                    jsx('span', { children: tr('more') }),
                  ],
                }),
              ],
            }),
          ],
        }),
      });
    }

    function UsagePanel({ call, onClose }) {
      const [state, setState] = useState({ loading: true, data: null, error: null });
      const [metric, setMetric] = useState('daily');

      const load = async (force) => {
        setState((prev) => ({ loading: true, data: prev.data, error: null }));
        try {
          const result = await call({ action: 'usage', force: Boolean(force) });
          const value = result && result.value;
          if (result && result.ok && value && Array.isArray(value.days) && value.totals) setState({ loading: false, data: value, error: null });
          else if (result && result.ok) setState({ loading: false, data: null, error: tr('needRestart') });
          else setState({ loading: false, data: null, error: (result && result.error && result.error.message) || tr('scanError') });
        } catch (e) {
          setState({ loading: false, data: null, error: e instanceof Error ? e.message : String(e) });
        }
      };

      useEffect(() => {
        load(true);
      }, []);

      const data = state.data;
      // Every field is read defensively: an older host build can answer with a
      // payload that predates some of these keys, and one undefined must not
      // blank the whole panel.
      const totals = (data && data.totals) || {};
      const peak = (data && data.peak) || {};
      const longest = (data && data.longestChat) || {};
      const streaks = (data && data.streaks) || {};
      const stats = data
        ? [
            { label: tr('totalTokens'), value: compactTokens(totals.tokens || 0), note: (data.firstDate || '—') + ' → ' + (data.lastDate || '—') },
            { label: tr('peakTokens'), value: compactTokens(peak.tokens || 0), note: peak.date || '—' },
            { label: tr('longestChat'), value: fmtDuration(longest.ms || 0), note: longest.date || '—' },
            { label: tr('currentStreak'), value: (streaks.current || 0) + DAY_UNIT, note: (data.activeDays || 0) + ' ' + tr('activeDays') },
            { label: tr('longestStreak'), value: (streaks.longest || 0) + DAY_UNIT, note: compactTokens(totals.req || 0) + tr('requestsUnit') },
          ]
        : [];

      return jsx('div', {
        style: backdropStyle,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
        children: jsx('div', {
          style: panelStyle,
          children: [
            jsx('div', {
              style: panelHead,
              children: [
                jsxs('div', {
                  style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
                  children: [
                    jsx('span', { style: panelTitle, children: tr('usageTitle') }),
                    jsx('div', {
                      style: segStyle,
                      children: [['daily', tr('daily')], ['weekly', tr('weekly')], ['cumulative', tr('cumulative')]].map((item) =>
                        jsx('button', { type: 'button', style: segItem(metric === item[0]), onClick: () => setMetric(item[0]), children: item[1] }, item[0]),
                      ),
                    }),
                  ],
                }),
                jsxs('div', {
                  style: { display: 'flex', gap: 6, alignItems: 'center' },
                  children: [
                    jsx('button', { type: 'button', style: iconBtnStyle, onClick: () => load(true), children: tr('refreshBtn') }),
                    jsx('button', { type: 'button', style: iconBtnStyle, onClick: onClose, children: '✕ ' + tr('close') }),
                  ],
                }),
              ],
            }),
            state.loading
              ? jsx('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', padding: '30px 0', textAlign: 'center' }, children: tr('loading') })
              : state.error
                ? jsx('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', padding: '20px 0' }, children: state.error })
                : jsxs('div', {
                    style: { display: 'flex', flexDirection: 'column', gap: 14 },
                    children: [
                      jsx('div', {
                        style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
                        children: stats.map((stat) =>
                          jsx('div', {
                            style: statCard,
                            children: [
                              jsx('div', { style: statLabel, children: stat.label }),
                              jsx('div', { style: statValue, children: stat.value }),
                              jsx('div', { style: statNote, children: stat.note }),
                            ],
                          }, stat.label),
                        ),
                      }),
                      jsx(Heatmap, { days: data.days, metric }),
                      jsxs('div', {
                        style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
                        children: [
                          tr('footnote'),
                          ' · ' + data.activeDays + ' ' + tr('activeDays') + ' · ' + data.totals.turns + ' ' + tr('turnsTotal') + ' · ' + data.totals.sessions + ' ' + tr('sessionsTotal') + ' · ' + fmtDuration(data.totals.chatMs) + ' ' + tr('chatTotal'),
                          ' · ' + tr('cacheRead') + ' ' + compactTokens(data.totals.cache) + tr('notCounted'),
                        ],
                      }),
                      jsx('div', {
                        style: { display: 'flex', gap: 18, flexWrap: 'wrap' },
                        children: [
                          jsx('div', {
                            style: { flex: '1 1 260px', minWidth: 0 },
                            children: [
                              jsx('div', { style: sectionTitle, children: tr('providers') }),
                              jsx('table', {
                                style: tableStyle,
                                children: [
                                  jsx('thead', {
                                    children: jsx('tr', {
                                      children: [
                                        jsx('th', { style: thStyle, children: tr('providers') }),
                                        jsx('th', { style: Object.assign({}, thStyle, { textAlign: 'right' }), children: tr('tokens') }),
                                        jsx('th', { style: Object.assign({}, thStyle, { textAlign: 'right' }), children: tr('requests') }),
                                        jsx('th', { style: Object.assign({}, thStyle, { textAlign: 'right' }), children: tr('activeDays') }),
                                      ],
                                    }),
                                  }),
                                  jsx('tbody', {
                                    children: data.providers.map((row) =>
                                      jsx('tr', {
                                        children: [
                                          jsx('td', { style: tdStyle(false), children: row.id }),
                                          jsx('td', { style: tdStyle(true), children: compactTokens(row.tokens) }),
                                          jsx('td', { style: tdStyle(true), children: row.req }),
                                          jsx('td', { style: tdStyle(true), children: row.days }),
                                        ],
                                      }, row.id),
                                    ),
                                  }),
                                ],
                              }),
                            ],
                          }, 'providers'),
                          jsx('div', {
                            style: { flex: '1 1 260px', minWidth: 0 },
                            children: [
                              jsx('div', { style: sectionTitle, children: tr('models') }),
                              jsx('table', {
                                style: tableStyle,
                                children: [
                                  jsx('thead', {
                                    children: jsx('tr', {
                                      children: [
                                        jsx('th', { style: thStyle, children: tr('models') }),
                                        jsx('th', { style: Object.assign({}, thStyle, { textAlign: 'right' }), children: tr('tokens') }),
                                        jsx('th', { style: Object.assign({}, thStyle, { textAlign: 'right' }), children: tr('requests') }),
                                      ],
                                    }),
                                  }),
                                  jsx('tbody', {
                                    children: data.models.map((row) =>
                                      jsx('tr', {
                                        children: [
                                          jsx('td', { style: Object.assign({}, tdStyle(false), { fontFamily: MONO, fontSize: 10 }), children: row.id }),
                                          jsx('td', { style: tdStyle(true), children: compactTokens(row.tokens) }),
                                          jsx('td', { style: tdStyle(true), children: row.req }),
                                        ],
                                      }, row.id),
                                    ),
                                  }),
                                ],
                              }),
                            ],
                          }, 'models'),
                        ],
                      }),
                    ],
                  }),
          ],
        }),
      });
    }



    function PanelHost() {
      const [, bump] = useState(0);
      useEffect(() => bus.subscribe(() => bump((n) => n + 1)), []);
      useEffect(() => {
        if (!bus.panel) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') bus.close();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [bus.panel]);
      if (!bus.panel || !bus.call) return null;
      if (bus.panel === 'usage') return jsx(UsagePanel, { call: bus.call, onClose: () => bus.close() });
      return null;
    }

    // -------------------------------------------------------------- wiring --

    const inject = ['connection', 'slots', 'locale'];

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'balance-monitor: dictionaries',
      );

      const connection = ctx.get('connection');
      // A host half from before this build still answers on the old channel;
      // use it read-only until DSH is restarted and the actions come back.
      let channel = '/balances';
      const call = async (payload) => {
        try {
          return normalize(await connection.rpc.call(channel, 'snapshot', payload || {}));
        } catch (error) {
          if (channel !== '/balances') throw error;
          channel = '/balance';
          try {
            return normalize(await connection.rpc.call('/balance', 'snapshot', {}));
          } catch (fallback) {
            channel = '/balances';
            throw error;
          }
        }
      };
      // A host from before this build answers with one DeepSeek snapshot object
      // instead of a row array; wrap it so the card still renders.
      const normalize = (result) => {
        const value = result && result.value;
        if (!value || Array.isArray(value)) return result;
        if (typeof value.total !== 'number' && value.available == null) return result;
        return {
          ok: result.ok !== false,
          value: [
            {
              id: 'deepseek',
              label: 'DeepSeek',
              kind: 'balance',
              mode: 'api',
              modes: [],
              currency: value.currency || 'CNY',
              remaining: typeof value.total === 'number' ? value.total : null,
              total: null,
              spent: typeof value.spent === 'number' ? value.spent : null,
              spentLabel: tr('todaySpent'),
              available: value.available !== false,
              stale: value.stale === true,
              updatedAt: value.updatedAt || 0,
              detail: null,
              error: null,
            },
          ],
          meta: { legacy: true, platforms: null },
        };
      };

      const refresh = () => call({});
      bus.call = call;

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'balance-monitor',
          locale: NS,
          inject: () => ({ refresh, call }),
        },
        BalancesCard,
      ));

      try {
        let element = document.getElementById('dsh-balance-monitor-panel');
        if (!element) {
          element = document.createElement('div');
          element.id = 'dsh-balance-monitor-panel';
          document.body.appendChild(element);
        }
        if (!element.__root) element.__root = createRoot(element);
        element.__root.render(jsx(PanelHost, {}));
        let stored = '';
        try { stored = window.sessionStorage.getItem(PANEL_OPEN_KEY) || ''; } catch (e) { /* private mode */ }
        if (stored === 'usage' && bus.panel !== stored) bus.open(stored);
      } catch (e) {
        console.error('[balance-monitor] panel host failed', e);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
