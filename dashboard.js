const getMonitorHtml = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Instagram Monitor</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --surface: #ffffff;
      --surface-2: #f8fafc;
      --surface-3: #eef2f6;
      --text: #17212b;
      --muted: #657184;
      --line: #dce2ea;
      --line-strong: #c8d1dc;
      --soft: #eef2f6;
      --ok: #16843a;
      --warn: #a86600;
      --bad: #c7352d;
      --blue: #2f68c5;
      --ink: #0f1720;
      --accent: #2f68c5;
      --accent-soft: rgba(47, 104, 197, .12);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, #ffffff 0, #f4f6f8 260px, #eef2f6 100%);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      min-height: 74px;
      padding: 14px 28px;
      background: rgba(255, 255, 255, 0.88);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(18px);
      box-shadow: 0 1px 0 rgba(15, 23, 32, .04), 0 14px 34px rgba(26, 36, 50, .08);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: #fff;
      background: #17212b;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14), 0 10px 18px rgba(23, 33, 43, .18);
      font-size: 13px;
      font-weight: 900;
    }
    h1 { margin: 0; font-size: 16px; letter-spacing: 0; font-weight: 700; }
    .brand-sub {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }
    .workspace-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      margin: 0 0 16px;
    }
    .workspace-title {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .eyebrow {
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0;
      text-transform: none;
    }
    h2 {
      margin: 0;
      color: var(--ink);
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .refresh-note {
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
    }
    button { font: inherit; }
    .summary {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      min-width: 0;
    }
    .stat {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 8px 20px rgba(22, 32, 44, .06);
    }
    .stat strong { color: var(--text); font-size: 17px; line-height: 1; }
    .stat.active strong { color: var(--blue); }
    .stat.complete strong { color: var(--ok); }
    .stat.waiting strong { color: var(--muted); }
    .stat.issue strong { color: var(--bad); }
    main {
      width: 100%;
      margin: 0;
      padding: 18px 16px 28px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      align-items: start;
    }
    .card {
      position: relative;
      overflow: hidden;
      border: 2px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      min-width: 0;
      box-shadow: 0 14px 34px rgba(27, 38, 52, .1);
      transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
    }
    .card:hover {
      transform: translateY(-1px);
      box-shadow: 0 18px 42px rgba(27, 38, 52, .14);
    }
    .card.running { border-color: rgba(47, 104, 197, .68); }
    .card.done { border-color: rgba(22, 132, 58, .62); }
    .card.failed { border-color: rgba(199, 53, 45, .72); }
    .card-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      min-height: 62px;
      padding: 12px 12px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    .account-wrap { min-width: 0; display: grid; gap: 2px; }
    .account {
      min-width: 0;
      color: var(--ink);
      font-size: 15px;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-sub {
      display: none;
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-status {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .history-btn {
      min-height: 30px;
      padding: 5px 9px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 1px 0 rgba(255, 255, 255, .8);
    }
    .history-btn:hover { border-color: var(--blue); color: var(--blue); }
    .queue {
      color: var(--warn);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .pill {
      flex: 0 0 auto;
      max-width: 118px;
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      padding: 5px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      text-transform: capitalize;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pill.running, .pill.ready, .pill.loaded, .pill.liking, .pill.liked, .pill.commenting, .pill.navigating, .pill.login, .pill.starting, .pill.validating-session {
      color: var(--blue);
      border-color: rgba(47, 104, 197, .36);
      background: rgba(47, 104, 197, .08);
    }
    .pill.queued { color: var(--warn); border-color: rgba(168, 102, 0, .34); background: rgba(168, 102, 0, .08); }
    .pill.done, .pill.commented { color: var(--ok); border-color: rgba(22, 132, 58, .34); background: rgba(22, 132, 58, .08); }
    .pill.failed, .pill.error { color: var(--bad); border-color: rgba(199, 53, 45, .4); background: rgba(199, 53, 45, .08); }
    .state-panel {
      display: grid;
      gap: 8px;
      padding: 9px 12px 11px;
      border-bottom: 1px solid var(--line);
      background: var(--surface-2);
    }
    .state-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: none;
    }
    .state-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state-time {
      flex: 0 0 auto;
      text-transform: none;
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state-steps {
      display: grid;
      grid-template-columns: repeat(8, minmax(0, 1fr));
      gap: 5px;
    }
    .state-step {
      height: 5px;
      border-radius: 999px;
      background: #dfe5ec;
    }
    .state-step.reached {
      background: var(--accent);
    }
    .card.done .state-step.reached {
      background: var(--ok);
    }
    .card.failed .state-step.reached {
      background: var(--bad);
    }
    .preview-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10.2;
      min-height: clamp(300px, 22vw, 430px);
      background: var(--soft);
      overflow: hidden;
    }
    .placeholder,
    .media-thumb,
    .media-fallback,
    .live-frame {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .placeholder {
      background: #e8edf3;
    }
    .card.pending .preview-wrap {
      background: #edf1f5;
    }
    .card.pending .placeholder {
      background: #edf1f5;
    }
    .card.done .preview-wrap,
    .card.done .placeholder {
      background: #eef3ef;
    }
    .card.running .placeholder {
      background: #edf4ff;
    }
    .media-thumb {
      display: block;
      object-fit: contain;
      background: #edf1f5;
      transition: filter .18s ease, transform .24s ease;
    }
    .card.pending .media-thumb {
      filter: grayscale(.55) saturate(.72) brightness(.74);
      opacity: .82;
    }
    .card.done .media-thumb {
      filter: grayscale(.72) saturate(.56) brightness(.86);
      opacity: .9;
    }
    .card.running .media-thumb {
      filter: saturate(.92) brightness(.94);
    }
    .card.pending .media-fallback {
      filter: grayscale(.18) saturate(.72) brightness(.82);
    }
    .card.done .media-fallback {
      filter: grayscale(.72) saturate(.56) brightness(.94);
    }
    .card.failed .media-fallback {
      filter: grayscale(.28) brightness(.96);
    }
    .media-fallback {
      display: block;
      padding: 0;
      color: var(--muted);
      overflow: hidden;
      background:
        linear-gradient(135deg, var(--accent-soft), transparent 38%),
        linear-gradient(135deg, #f8fafc, #e9eef4 70%);
    }
    .media-fallback::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(120deg, rgba(255, 255, 255, .9), transparent 24%, transparent 64%, rgba(255, 255, 255, .5)),
        repeating-linear-gradient(90deg, rgba(23, 33, 43, .05) 0 1px, transparent 1px 46px);
      opacity: .72;
      pointer-events: none;
    }
    .fallback-card {
      position: absolute;
      inset: 22px;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 18px;
      min-width: 0;
    }
    .fallback-type {
      justify-self: start;
      padding: 6px 9px;
      border: 1px solid rgba(230, 237, 243, .14);
      border-radius: 999px;
      color: var(--text);
      background: rgba(255, 255, 255, .72);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .fallback-center {
      align-self: center;
      justify-self: center;
      width: min(100%, 360px);
      display: grid;
      justify-items: center;
      gap: 12px;
      text-align: center;
    }
    .fallback-mark {
      display: grid;
      place-items: center;
      width: 76px;
      height: 76px;
      border: 1px solid rgba(230, 237, 243, .16);
      border-radius: 18px;
      color: var(--ink);
      background: rgba(255, 255, 255, .7);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .9), 0 16px 34px rgba(27, 38, 52, .12);
      font-size: 20px;
      font-weight: 900;
    }
    .fallback-title {
      max-width: 100%;
      color: var(--text);
      font-size: clamp(20px, 2.1vw, 28px);
      font-weight: 900;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fallback-caption {
      max-width: 42ch;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .media-fallback:not([hidden]) ~ .tile-shade,
    .media-fallback:not([hidden]) ~ .tile-info {
      display: none;
    }
    .live-frame {
      display: block;
      object-fit: contain;
      background: #0b0c0f;
      opacity: 0;
      will-change: opacity;
    }
    .live-frame.visible {
      opacity: 1;
    }
    .card.live .media-thumb,
    .card.live .media-fallback {
      opacity: 0;
      pointer-events: none;
      transition: none;
    }
    .card.live .placeholder,
    .card.live .tile-shade,
    .card.live .tile-info {
      display: none;
    }
    .tile-shade {
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(15, 23, 32, .02), rgba(15, 23, 32, .06) 54%, rgba(15, 23, 32, .52));
      pointer-events: none;
    }
    .tile-info {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 9px;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 8px;
      color: var(--text);
      pointer-events: none;
    }
    .media-name {
      display: none;
      min-width: 0;
      font-size: 13px;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .7);
    }
    .row-tag {
      flex: 0 0 auto;
      color: #c9d1d9;
      font-size: 11px;
      padding: 3px 6px;
      border: 1px solid rgba(201, 209, 217, .18);
      border-radius: 999px;
      background: rgba(15, 23, 32, .64);
    }
    .done-mark,
    .failed-mark {
      position: absolute;
      right: 10px;
      top: 10px;
      padding: 6px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
      z-index: 3;
    }
    .error-mark {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      padding: 7px 11px;
      border-radius: 7px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
      z-index: 3;
    }
    .done-mark {
      color: #fff;
      background: rgba(22, 132, 58, .94);
      border: 1px solid rgba(22, 132, 58, .52);
      box-shadow: 0 10px 22px rgba(22, 132, 58, .2);
    }
    .failed-mark {
      color: #fff;
      background: rgba(199, 53, 45, .94);
      border: 1px solid rgba(199, 53, 45, .42);
    }
    .error-mark {
      left: 10px;
      right: 10px;
      top: auto;
      bottom: 10px;
      transform: none;
      max-width: calc(100% - 20px);
      padding: 6px 8px;
      background: rgba(199, 53, 45, .94);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      text-transform: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card.live .preview-wrap::after {
      content: "LIVE";
      position: absolute;
      right: 8px;
      bottom: 8px;
      padding: 4px 7px;
      border-radius: 999px;
      background: rgba(22, 132, 58, .94);
      color: #fff;
      font-size: 10px;
      font-weight: 800;
    }
    .empty {
      grid-column: 1 / -1;
      min-height: 340px;
      display: grid;
      place-items: center;
      border: 1px dashed var(--line-strong);
      border-radius: 8px;
      color: var(--muted);
      background: rgba(255, 255, 255, .72);
      text-align: center;
      padding: 28px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .7);
    }
    .history-inline {
      position: absolute;
      inset: 8px;
      z-index: 4;
      display: grid;
      grid-template-rows: auto 1fr;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, .96);
      box-shadow: 0 18px 42px rgba(27, 38, 52, .18);
      backdrop-filter: blur(16px);
      overflow: hidden;
    }
    .history-inline-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 9px;
      border-bottom: 1px solid var(--line);
      color: var(--text);
      font-size: 12px;
      font-weight: 800;
      background: var(--surface-2);
    }
    .close-inline-history {
      width: 24px;
      height: 24px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      line-height: 1;
      cursor: pointer;
    }
    .history-list {
      overflow: auto;
      padding: 8px;
      display: grid;
      align-content: start;
      gap: 7px;
    }
    .history-event {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface);
      padding: 7px;
      display: grid;
      gap: 4px;
      box-shadow: 0 1px 0 rgba(15, 23, 32, .03);
    }
    .history-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .history-action { font-weight: 800; text-transform: capitalize; }
    .history-time { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .history-message,
    .history-target {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    [hidden] { display: none !important; }
    @media (max-width: 1180px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      header { align-items: flex-start; flex-direction: column; }
      .summary { white-space: normal; }
      .workspace-head { align-items: flex-start; flex-direction: column; }
      .refresh-note { white-space: normal; }
    }
    @media (max-width: 640px) {
      header { padding: 12px 14px; }
      main { padding: 14px; }
      .grid { grid-template-columns: 1fr; }
      .preview-wrap { min-height: 260px; }
      .card-head { grid-template-columns: 1fr; align-items: start; }
      .card-status { justify-content: space-between; }
      .summary { gap: 8px; }
      .stat { min-height: 34px; padding: 6px 8px; }
      .stat strong { font-size: 15px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-mark">IG</div>
      <div>
        <h1>Instagram Monitor</h1>
        <div class="brand-sub">Accounts</div>
      </div>
    </div>
    <div class="summary" id="summary">Connecting...</div>
  </header>
  <main>
    <section class="workspace-head">
      <div class="workspace-title">
        <div class="eyebrow">Dashboard</div>
        <h2>Actions</h2>
      </div>
      <div class="refresh-note" id="refreshNote">Connecting...</div>
    </section>
    <div class="grid" id="grid"></div>
  </main>
  <script>
    const grid = document.getElementById('grid');
    const summary = document.getElementById('summary');
    const refreshNote = document.getElementById('refreshNote');
    const cards = new Map();
    const accountStreams = new Map();
    let emptyState = null;

    const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
    const statusClass = value => String(value || 'pending').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const normalizeStatus = value => {
      const status = String(value || '').toLowerCase();
      if (['done', 'completed', 'commented', 'skipped'].includes(status)) return 'done';
      if (['failed', 'error'].includes(status)) return 'failed';
      if (['running', 'active', 'working', 'queued', 'navigating', 'loaded', 'liking', 'liked', 'commenting', 'ready', 'login', 'login-needed', 'starting', 'validating-session', 'verification', 'manual-verification', 'paused'].includes(status)) return 'running';
      return 'pending';
    };
    const lifecycleStates = ['queued', 'starting', 'logged_in', 'navigating', 'liked', 'commenting', 'verified', 'done'];
    const lifecycleRank = state => {
      const normalized = String(state || '').toLowerCase();
      const alias = {
        ready: 'logged_in',
        login: 'starting',
        loaded: 'navigating',
        liking: 'liked',
        commented: 'verified',
        completed: 'done',
        success: 'done',
        skipped: 'done',
        error: 'failed',
        stalled: 'failed',
        unverified: 'failed'
      }[normalized] || normalized;
      if (alias === 'failed') return -1;
      const index = lifecycleStates.indexOf(alias);
      return index >= 0 ? index : 1;
    };
    const getActionState = (item, status, phase) => {
      if (status === 'done') return 'done';
      if (status === 'failed') return 'failed';
      return item.actionState || phase || status || 'starting';
    };
    const getStateTitle = state => {
      const label = {
        queued: 'Queued',
        starting: 'Starting',
        logged_in: 'Logged in',
        navigating: 'Navigating',
        liked: 'Liked',
        commenting: 'Commenting',
        verified: 'Verified',
        done: 'Done',
        failed: 'Needs attention'
      }[String(state || '').toLowerCase()];
      return label || String(state || 'Starting').replace(/[-_]/g, ' ');
    };
    const getStateStepsHtml = (item, status, phase) => {
      const state = getActionState(item, status, phase);
      const rank = typeof item.actionStateRank === 'number' && item.actionStateRank >= 0
        ? Math.min(item.actionStateRank, lifecycleStates.length - 1)
        : lifecycleRank(state);
      const reachedRank = status === 'failed' && rank < 0 ? Math.max(0, lifecycleRank(phase)) : rank;
      return lifecycleStates.map((step, index) => {
        const reached = index <= reachedRank || status === 'done';
        return '<span class="state-step' + (reached ? ' reached' : '') + '" title="' + escapeText(getStateTitle(step)) + '"></span>';
      }).join('');
    };
    const isManualPhase = value => ['login-needed', 'verification', 'manual-verification', 'paused'].includes(String(value || '').toLowerCase());
    const isManualMessage = value => /verification page opened|manual verification|security code|two[- ]factor|confirm it'?s you|suspicious login|verify (your )?(account|identity)|checkpoint|captcha|i'?m not a robot|recaptcha|not logged in|manual instagram login|full experience|tablet app|input\\[name="?email"?\\]/i.test(String(value || ''));
    const formatTime = value => {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString();
    };
    const formatShortTime = value => {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    const compact = (value, fallback) => {
      const text = String(value || '').trim();
      if (!text) return fallback || '';
      return text.length > 72 ? text.slice(0, 69) + '...' : text;
    };
    const getEmbedPartsFromContentKey = contentKey => {
      const parts = String(contentKey || '').split(':');
      if (parts.length < 2) return null;
      const kind = parts[0] === 'reels' ? 'reel' : parts[0];
      const shortcode = parts.slice(1).join(':');
      if (!['p', 'reel', 'tv'].includes(kind) || !shortcode) return null;
      return { kind, shortcode };
    };
    const getEmbedPartsFromUrl = urlValue => {
      try {
        const url = new URL(urlValue);
        const parts = url.pathname.split('/').filter(Boolean);
        const kind = parts[0] === 'reels' ? 'reel' : parts[0];
        const shortcode = parts[1];
        if (!['p', 'reel', 'tv'].includes(kind) || !shortcode) return null;
        return { kind, shortcode };
      } catch (_error) {
        return null;
      }
    };
    const getInstagramMediaUrl = item => {
      const parts = getEmbedPartsFromContentKey(item.contentKey) || getEmbedPartsFromUrl(item.url);
      if (!parts) return null;
      return 'https://www.instagram.com/' + parts.kind + '/' + encodeURIComponent(parts.shortcode) + '/media/?size=l';
    };
    const getEmbedParts = item => getEmbedPartsFromContentKey(item.contentKey) || getEmbedPartsFromUrl(item.url);
    const getMediaKindLabel = item => {
      const parts = getEmbedParts(item);
      if (!parts) return 'Post';
      if (parts.kind === 'reel') return 'Reel';
      if (parts.kind === 'tv') return 'Video';
      return 'Post';
    };
    const getShortcode = item => {
      const parts = getEmbedParts(item);
      return parts ? parts.shortcode : '';
    };
    const getDisplayTarget = item => {
      const parts = getEmbedParts(item);
      if (parts) return getMediaKindLabel(item) + ' ' + parts.shortcode;
      return item.contentKey || item.url || 'Post not selected';
    };
    const accentPalette = [
      ['#58a6ff', 'rgba(88, 166, 255, .18)'],
      ['#3fb950', 'rgba(63, 185, 80, .18)'],
      ['#d29922', 'rgba(210, 153, 34, .18)'],
      ['#f778ba', 'rgba(247, 120, 186, .16)'],
      ['#a371f7', 'rgba(163, 113, 247, .17)'],
      ['#39c5cf', 'rgba(57, 197, 207, .16)']
    ];
    const hashText = value => {
      const text = String(value || '');
      let hash = 0;
      for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
      }
      return Math.abs(hash);
    };
    const getAccentPair = item => accentPalette[hashText(item.contentKey || item.url || item.accountKey || item.account) % accentPalette.length];
    const getFallbackHtml = (item, phase) => {
      const kind = getMediaKindLabel(item);
      const account = item.account || item.accountKey || 'default';
      const caption = compact(getDisplayTarget(item) || item.scheduledAt || phase || 'Waiting', 'Waiting');
      return '<div class="fallback-card">'
        + '<div class="fallback-type">' + escapeText(kind) + '</div>'
        + '<div class="fallback-center">'
        + '<div class="fallback-mark">IG</div>'
        + '<div class="fallback-title">@' + escapeText(account) + '</div>'
        + '<div class="fallback-caption">' + escapeText(caption) + '</div>'
        + '</div>'
        + '</div>';
    };
    const getTaskKey = session => {
      const task = session.currentTask || {};
      return task.contentKey || task.requestedContentKey || '';
    };
    const getItemStatus = item => {
      const task = item.session ? item.session.currentTask || {} : {};
      if (
        task.loginRequired
        || task.verificationRequired
        || isManualPhase(task.phase)
        || isManualPhase(item.phase)
        || isManualMessage(task.error || item.error)
      ) return 'running';
      if (task.skipped || task.phase === 'commented' || item.status === 'done' || item.phase === 'done' || item.phase === 'commented') return 'done';
      if (task.error || item.error) return 'failed';
      if (item.session && (item.session.browserStarted || item.session.currentTask)) return 'running';
      return normalizeStatus(item.status);
    };
    const getPhaseLabel = item => {
      const status = getItemStatus(item);
      const task = item.session ? item.session.currentTask || {} : {};
      if (status === 'done') return 'done';
      if (status === 'failed') return 'failed';
      return task.phase || item.phase || status;
    };
    const getCardKey = item => item.postKey || ('session:' + item.accountKey + ':' + (item.contentKey || 'active'));
    const isVisibleDashboardItem = item => ['running', 'done', 'failed'].includes(getItemStatus(item));
    const statusRank = item => ({ running: 0, failed: 1, done: 2, pending: 3 }[getItemStatus(item)] ?? 4);
    const itemRowNumber = item => {
      const rowNumber = Number(item.rowNumber);
      return Number.isFinite(rowNumber) ? rowNumber : Number.MAX_SAFE_INTEGER;
    };
    const sortDashboardItems = items => items.sort((a, b) => {
      const rankDiff = statusRank(a) - statusRank(b);
      if (rankDiff) return rankDiff;
      const rowDiff = itemRowNumber(a) - itemRowNumber(b);
      if (rowDiff) return rowDiff;
      return String(a.accountKey || a.account || '').localeCompare(String(b.accountKey || b.account || ''));
    });

    const hasVisibleSessionWork = session => {
      const task = session.currentTask || {};
      const hasTarget = Boolean(
        task.contentKey
        || task.requestedContentKey
        || task.finalContentKey
        || task.originalUrl
        || task.finalUrl
        || session.url
      );
      const hasQueuedWork = Boolean(Number(session.pendingOperations || 0) > 0 || Number(session.queuedOperations || 0) > 0);
      const hasLiveManualWork = Boolean(
        session.browserStarted
        && (
          session.manualVerification
          || task.verificationRequired
          || task.loginRequired
          || isManualPhase(task.phase)
          || isManualMessage(task.error)
        )
      );
      const finalClosedPhase = ['ready', 'commented', 'done', 'completed', 'skipped'].includes(String(task.phase || '').toLowerCase());

      if (!hasTarget) {
        return false;
      }

      if (!session.browserStarted && !hasQueuedWork && !hasLiveManualWork) {
        return false;
      }

      if (!session.browserStarted && finalClosedPhase) {
        return false;
      }

      return Boolean(
        hasTarget
        || hasQueuedWork
        || hasLiveManualWork
        || task.error
      );
    };

    const mergeDashboardItems = data => {
      const posts = (data.dashboardPosts || []).map(post => ({ ...post }));
      const sessions = (data.activeSessions || []).filter(hasVisibleSessionWork);
      const usedSessions = new Set();
      const items = posts.map(post => {
        const matchedSession = sessions.find(session => {
          const taskKey = getTaskKey(session);
          return session.accountKey === post.accountKey && taskKey && post.contentKey && taskKey === post.contentKey;
        });
        if (matchedSession) {
          usedSessions.add(matchedSession.accountKey + '::' + getTaskKey(matchedSession));
        }
        return { ...post, session: matchedSession || null };
      });
      const sessionOnly = sessions
        .filter(session => !usedSessions.has(session.accountKey + '::' + getTaskKey(session)))
        .map(session => {
          const task = session.currentTask || {};
          return {
            postKey: 'session:' + session.accountKey + ':' + (task.contentKey || task.requestedContentKey || 'active'),
            account: session.account || session.accountKey,
            accountKey: session.accountKey,
            contentKey: task.contentKey || task.requestedContentKey || null,
            url: task.finalUrl || task.originalUrl || session.url || null,
            rowNumber: null,
            comment: null,
            scheduledAt: null,
            status: normalizeStatus(task.phase || 'running'),
            phase: task.phase || null,
            actionState: task.actionState || null,
            actionStateRank: task.actionStateRank ?? null,
            error: task.error || null,
            updatedAt: task.updatedAt || null,
            session
          };
        });
      return sortDashboardItems(sessionOnly.concat(items).filter(isVisibleDashboardItem));
    };

    const createCard = key => {
      const card = document.createElement('section');
      card.className = 'card';
      card.innerHTML = '<div class="card-head">'
        + '<div class="account-wrap"><div class="account"></div><div class="card-sub"></div></div>'
        + '<div class="card-status"><button class="history-btn" type="button">History</button><span class="queue"></span><span class="pill"></span></div>'
        + '</div>'
        + '<div class="state-panel">'
        + '<div class="state-meta"><span class="state-name"></span><span class="state-time"></span></div>'
        + '<div class="state-steps"></div>'
        + '</div>'
        + '<div class="preview-wrap">'
        + '<div class="placeholder"></div>'
        + '<img class="media-thumb" alt="" loading="eager" fetchpriority="high" decoding="async" hidden>'
        + '<div class="media-fallback" hidden></div>'
        + '<img class="live-frame live-frame-a" alt="">'
        + '<img class="live-frame live-frame-b" alt="">'
        + '<div class="tile-shade"></div>'
        + '<div class="tile-info"><div class="media-name"></div><div class="row-tag"></div></div>'
        + '<div class="done-mark" hidden>Done</div>'
        + '<div class="failed-mark" hidden>Failed</div>'
        + '<div class="error-mark" hidden></div>'
        + '<div class="history-inline" hidden>'
        + '<div class="history-inline-head"><span>History</span><button class="close-inline-history" type="button" title="Close">X</button></div>'
        + '<div class="history-list"></div>'
        + '</div>'
        + '</div>';
      const refs = {
        card,
        account: card.querySelector('.account'),
        sub: card.querySelector('.card-sub'),
        historyButton: card.querySelector('.history-btn'),
        queue: card.querySelector('.queue'),
        pill: card.querySelector('.pill'),
        stateName: card.querySelector('.state-name'),
        stateTime: card.querySelector('.state-time'),
        stateSteps: card.querySelector('.state-steps'),
        thumb: card.querySelector('.media-thumb'),
        fallback: card.querySelector('.media-fallback'),
        liveA: card.querySelector('.live-frame-a'),
        liveB: card.querySelector('.live-frame-b'),
        mediaName: card.querySelector('.media-name'),
        rowTag: card.querySelector('.row-tag'),
        done: card.querySelector('.done-mark'),
        failed: card.querySelector('.failed-mark'),
        error: card.querySelector('.error-mark'),
        historyBox: card.querySelector('.history-inline'),
        historyList: card.querySelector('.history-list'),
        closeHistoryButton: card.querySelector('.close-inline-history'),
        stream: null,
        streamAccountKey: null,
        liveFrameIndex: 0,
        liveLastFrameAt: 0,
        livePendingFrame: null,
        liveRenderTimer: null,
        liveRendering: false,
        lastFrameSrc: null,
        item: null
      };
      refs.historyButton.addEventListener('click', () => toggleHistory(refs));
      refs.closeHistoryButton.addEventListener('click', event => {
        event.stopPropagation();
        refs.historyBox.hidden = true;
      });
      cards.set(key, refs);
      grid.appendChild(card);
      return refs;
    };

    const closeStream = refs => {
      if (refs.streamAccountKey) {
        const streamState = accountStreams.get(refs.streamAccountKey);
        if (streamState) {
          streamState.refs.delete(refs);
          if (!streamState.refs.size) {
            streamState.source.close();
            accountStreams.delete(refs.streamAccountKey);
          }
        }
      }
      refs.stream = null;
      refs.streamAccountKey = null;
      refs.livePendingFrame = null;
      refs.liveRendering = false;
      if (refs.liveRenderTimer) {
        clearTimeout(refs.liveRenderTimer);
      }
      refs.liveRenderTimer = null;
      refs.liveA.removeAttribute('src');
      refs.liveB.removeAttribute('src');
      refs.liveA.classList.remove('visible');
      refs.liveB.classList.remove('visible');
      refs.card.classList.remove('live');
    };

    const applyLiveFrame = (refs, frameData, onComplete = () => {}) => {
      const activeFrame = refs.liveFrameIndex % 2 === 0 ? refs.liveA : refs.liveB;
      const inactiveFrame = activeFrame === refs.liveA ? refs.liveB : refs.liveA;
      const frameToken = String(Date.now()) + '-' + refs.liveFrameIndex;
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        onComplete();
      };
      activeFrame.dataset.token = frameToken;
      const showFrame = () => {
        if (activeFrame.dataset.token !== frameToken) return;
        activeFrame.classList.add('visible');
        inactiveFrame.classList.remove('visible');
        refs.card.classList.add('live');
        refs.lastFrameSrc = activeFrame.src;
        refs.liveLastFrameAt = performance.now();
        finish();
      };
      activeFrame.onload = () => {
        if (activeFrame.decode) {
          activeFrame.decode().then(showFrame).catch(showFrame);
        } else {
          showFrame();
        }
      };
      activeFrame.onerror = () => {
        if (!refs.liveA.classList.contains('visible') && !refs.liveB.classList.contains('visible')) {
          refs.card.classList.remove('live');
        }
        finish();
      };
      activeFrame.src = 'data:image/jpeg;base64,' + frameData;
      refs.liveFrameIndex += 1;
    };

    const queueLiveFrame = (refs, frameData) => {
      const frameGap = 34;
      refs.livePendingFrame = frameData;

      if (refs.liveRendering || refs.liveRenderTimer) {
        return;
      }

      const renderNext = () => {
        refs.liveRenderTimer = null;
        if (!refs.livePendingFrame || refs.liveRendering) {
          return;
        }

        const elapsed = performance.now() - refs.liveLastFrameAt;
        if (elapsed < frameGap) {
          refs.liveRenderTimer = setTimeout(renderNext, Math.max(12, frameGap - elapsed));
          return;
        }

        const nextFrame = refs.livePendingFrame;
        refs.livePendingFrame = null;
        refs.liveRendering = true;
        applyLiveFrame(refs, nextFrame, () => {
          refs.liveRendering = false;
          if (refs.livePendingFrame && !refs.liveRenderTimer) {
            refs.liveRenderTimer = setTimeout(renderNext, frameGap);
          }
        });
      };

      renderNext();
    };

    const connectStream = (refs, item) => {
      const accountKey = item.session && item.session.accountKey;
      if (!accountKey || getItemStatus(item) !== 'running' || !item.session.browserStarted) {
        closeStream(refs);
        return;
      }
      const existingStream = accountStreams.get(accountKey);
      if (refs.streamAccountKey === accountKey && existingStream && existingStream.source.readyState !== EventSource.CLOSED) {
        return;
      }
      closeStream(refs);
      let streamState = accountStreams.get(accountKey);
      if (streamState && streamState.source.readyState === EventSource.CLOSED) {
        streamState.refs.forEach(streamRefs => {
          streamRefs.streamAccountKey = null;
        });
        streamState.source.close();
        accountStreams.delete(accountKey);
        streamState = null;
      }
      if (!streamState) {
        streamState = {
          source: new EventSource('/monitor/stream/' + encodeURIComponent(accountKey)),
          refs: new Set()
        };
        streamState.source.addEventListener('frame', event => {
          streamState.refs.forEach(streamRefs => {
            if (streamRefs.item && getItemStatus(streamRefs.item) === 'running') {
              queueLiveFrame(streamRefs, event.data);
            }
          });
        });
        streamState.source.addEventListener('status', event => {
          streamState.refs.forEach(streamRefs => {
            streamRefs.error.textContent = event.data || '';
            streamRefs.error.hidden = !event.data;
          });
        });
        streamState.source.onerror = () => {
          streamState.refs.forEach(streamRefs => {
            streamRefs.error.textContent = '';
            streamRefs.error.hidden = true;
          });
        };
        accountStreams.set(accountKey, streamState);
      }
      streamState.refs.add(refs);
      refs.streamAccountKey = accountKey;
    };

    const updateCard = item => {
      const key = getCardKey(item);
      const refs = cards.get(key) || createCard(key);
      const status = getItemStatus(item);
      const phase = getPhaseLabel(item);
      const task = item.session ? item.session.currentTask || {} : {};
      const queued = item.session ? Number(item.session.queuedOperations || 0) : 0;
      const targetText = getDisplayTarget(item);
      const mediaKind = getMediaKindLabel(item);
      const mediaUrl = getInstagramMediaUrl(item);
      const accentPair = getAccentPair(item);
      const storedThumbnailUrl = item.thumbnailUrl || null;
      const useStoredThumbnail = status !== 'running' && storedThumbnailUrl;
      const useLastFramePreview = status !== 'running' && !useStoredThumbnail && refs.lastFrameSrc;
      refs.item = item;
      const wasLive = refs.card.classList.contains('live') && status === 'running';
      refs.card.className = 'card ' + statusClass(status) + (wasLive ? ' live' : '');
      refs.card.style.setProperty('--accent', accentPair[0]);
      refs.card.style.setProperty('--accent-soft', accentPair[1]);
      refs.account.textContent = item.account || item.accountKey || 'default';
      refs.sub.textContent = '';
      refs.pill.className = 'pill ' + statusClass(phase);
      refs.pill.textContent = phase;
      refs.queue.textContent = queued ? 'Queue ' + queued : '';
      refs.queue.hidden = !queued;
      refs.stateName.textContent = getStateTitle(getActionState(item, status, phase));
      refs.stateTime.textContent = formatShortTime(task.updatedAt || item.updatedAt || item.completedAt || '');
      refs.stateSteps.innerHTML = getStateStepsHtml(item, status, phase);
      refs.done.hidden = status !== 'done';
      refs.failed.hidden = status !== 'failed';
      const visibleError = status === 'done' ? '' : (task.error || item.error || '');
      refs.error.textContent = visibleError;
      refs.error.hidden = !visibleError;
      refs.mediaName.textContent = '';
      refs.rowTag.textContent = mediaKind;
      refs.rowTag.hidden = !mediaKind;
      if (useStoredThumbnail) {
        refs.thumb.onerror = () => {
          refs.thumb.hidden = true;
          refs.fallback.innerHTML = getFallbackHtml(item, phase);
          refs.fallback.hidden = false;
        };
        const thumbnailSrc = storedThumbnailUrl + (item.completedAt || item.updatedAt ? '?v=' + encodeURIComponent(item.completedAt || item.updatedAt) : '');
        refs.thumb.src = thumbnailSrc;
        refs.thumb.dataset.src = thumbnailSrc;
        refs.thumb.hidden = false;
        refs.fallback.hidden = true;
        refs.thumb.alt = targetText;
      } else if (useLastFramePreview) {
        refs.thumb.onerror = null;
        refs.thumb.dataset.failed = '';
        refs.thumb.src = refs.lastFrameSrc;
        refs.thumb.dataset.src = 'last-frame';
        refs.thumb.hidden = false;
        refs.fallback.hidden = true;
        refs.thumb.alt = targetText;
      } else if (mediaUrl) {
        refs.thumb.onerror = () => {
          refs.thumb.dataset.failed = mediaUrl;
          refs.thumb.hidden = true;
          refs.fallback.innerHTML = getFallbackHtml(item, phase);
          refs.fallback.hidden = false;
        };
        if (refs.thumb.dataset.failed === mediaUrl) {
          refs.thumb.hidden = true;
          refs.fallback.innerHTML = getFallbackHtml(item, phase);
          refs.fallback.hidden = false;
        } else if (refs.thumb.dataset.src !== mediaUrl) {
          refs.thumb.dataset.failed = '';
          refs.thumb.src = mediaUrl;
          refs.thumb.dataset.src = mediaUrl;
          refs.thumb.hidden = false;
          refs.fallback.hidden = true;
        } else {
          refs.thumb.hidden = false;
          refs.fallback.hidden = true;
        }
        refs.thumb.alt = targetText;
      } else {
        refs.thumb.hidden = true;
        refs.thumb.removeAttribute('src');
        refs.thumb.dataset.src = '';
        refs.fallback.innerHTML = getFallbackHtml(item, phase);
        refs.fallback.hidden = false;
      }
      refs.card.title = 'Account: ' + (item.account || item.accountKey || 'default')
        + '\\nStatus: ' + phase
        + (item.actionState ? '\\nState: ' + item.actionState : '')
        + (item.rowNumber ? '\\nRow: ' + item.rowNumber : '')
        + '\\nTarget: ' + targetText
        + (item.scheduledAt ? '\\nScheduled: ' + item.scheduledAt : '')
        + (queued ? '\\nQueued operations: ' + queued : '')
        + (task.updatedAt || item.updatedAt ? '\\nUpdated: ' + formatTime(task.updatedAt || item.updatedAt) : '');

      if (status !== 'running') {
        closeStream(refs);
      } else {
        connectStream(refs, item);
      }
    };

    const removeMissingCards = seen => {
      cards.forEach((refs, key) => {
        if (!seen.has(key)) {
          closeStream(refs);
          refs.card.remove();
          cards.delete(key);
        }
      });
    };

    const updateSummary = items => {
      const counts = items.reduce((acc, item) => {
        acc[getItemStatus(item)] = (acc[getItemStatus(item)] || 0) + 1;
        return acc;
      }, {});
      const total = items.length;
      summary.innerHTML = total
        ? '<span class="stat"><strong>' + total + '</strong><span>Total</span></span>'
          + '<span class="stat active"><strong>' + (counts.running || 0) + '</strong><span>Active</span></span>'
          + '<span class="stat complete"><strong>' + (counts.done || 0) + '</strong><span>Complete</span></span>'
          + ((counts.failed || 0) ? '<span class="stat issue"><strong>' + counts.failed + '</strong><span>Issues</span></span>' : '')
        : '<span class="stat waiting"><strong>0</strong><span>Activity</span></span>';
      refreshNote.textContent = 'Updated ' + formatShortTime(new Date().toISOString());
    };

    const showEmpty = () => {
      if (!emptyState) {
        emptyState = document.createElement('div');
        emptyState.className = 'empty';
        emptyState.textContent = 'No actions running or completed yet';
        grid.appendChild(emptyState);
      }
    };

    const hideEmpty = () => {
      if (emptyState) {
        emptyState.remove();
        emptyState = null;
      }
    };

    async function refresh() {
      try {
        const response = await fetch('/health', { cache: 'no-store' });
        const data = await response.json();
        const items = mergeDashboardItems(data);
        updateSummary(items);
        if (!items.length) {
          removeMissingCards(new Set());
          showEmpty();
          return;
        }
        hideEmpty();
        const seen = new Set();
        items.forEach(item => {
          const key = getCardKey(item);
          seen.add(key);
          updateCard(item);
        });
        removeMissingCards(seen);
      } catch (error) {
        summary.innerHTML = '<span class="stat issue"><strong>Offline</strong><span>Reconnecting</span></span>';
        refreshNote.textContent = 'Connection unavailable';
      }
    }

    const renderHistory = (events, listElement) => {
      if (!events.length) {
        listElement.innerHTML = '<div class="history-event"><div class="history-message">No history recorded yet.</div></div>';
        return;
      }
      listElement.innerHTML = events.map(event => {
        const message = event.error || event.message || '';
        const target = event.contentKey || event.url || '';
        return '<div class="history-event">'
          + '<div class="history-top"><div class="history-action">' + escapeText(event.action || event.status || 'update') + '</div><div class="history-time">' + escapeText(formatTime(event.time)) + '</div></div>'
          + '<div class="history-message">' + escapeText(event.account || event.accountKey || '') + (event.status ? ' | ' + escapeText(event.status) : '') + '</div>'
          + (message ? '<div class="history-message">' + escapeText(message) + '</div>' : '')
          + (target ? '<div class="history-target">' + escapeText(target) + '</div>' : '')
          + '</div>';
      }).join('');
    };

    const loadHistory = async refs => {
      const item = refs.item || {};
      const params = new URLSearchParams();
      params.set('limit', '20');
      if (item && item.accountKey) params.set('accountKey', item.accountKey);
      if (item && item.contentKey) params.set('contentKey', item.contentKey);
      refs.historyList.innerHTML = '<div class="history-event"><div class="history-message">Loading...</div></div>';
      try {
        const response = await fetch('/history?' + params.toString(), { cache: 'no-store' });
        const data = await response.json();
        renderHistory(data.events || [], refs.historyList);
      } catch (error) {
        refs.historyList.innerHTML = '<div class="history-event"><div class="history-message">Could not load history.</div></div>';
      }
    };

    const toggleHistory = refs => {
      const shouldOpen = refs.historyBox.hidden;
      cards.forEach(otherRefs => {
        if (otherRefs !== refs) {
          otherRefs.historyBox.hidden = true;
        }
      });
      refs.historyBox.hidden = !shouldOpen;
      if (shouldOpen) {
        loadHistory(refs);
      }
    };

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        cards.forEach(refs => {
          refs.historyBox.hidden = true;
        });
      }
    });

    refresh();
    setInterval(refresh, 1800);
  </script>
</body>
</html>`;

module.exports = { getMonitorHtml };
