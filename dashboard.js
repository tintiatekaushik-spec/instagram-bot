const getMonitorHtml = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Instagram Bot Monitor</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap');
    :root {
      color-scheme: dark;
      --bg: #0b0c0f;
      --panel: #17191d;
      --panel-2: #20242a;
      --text: #e6edf3;
      --muted: #a5adb6;
      --line: #333941;
      --soft: #22262c;
      --ok: #3fb950;
      --warn: #d29922;
      --bad: #f85149;
      --blue: #58a6ff;
      --accent: #58a6ff;
      --accent-soft: rgba(88, 166, 255, .18);
      font-family: Roboto, Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: Roboto, Arial, sans-serif; }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 20px;
      background: rgba(11, 12, 15, 0.94);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(12px);
    }
    h1 { margin: 0; font-size: 18px; letter-spacing: 0; font-weight: 900; }
    button { font: inherit; }
    .summary {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .stat {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 26px;
      padding: 4px 8px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: rgba(20, 26, 33, .78);
    }
    .stat strong { color: var(--text); font-size: 13px; }
    .stat.active strong { color: var(--blue); }
    .stat.complete strong { color: var(--ok); }
    .stat.waiting strong { color: var(--muted); }
    .stat.issue strong { color: var(--bad); }
    main { padding: 18px 18px 22px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(360px, 1fr));
      gap: 18px;
      align-items: start;
    }
    .card {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      min-width: 0;
      box-shadow: 0 10px 26px rgba(0, 0, 0, .22);
      transition: border-color .18s ease, box-shadow .18s ease;
    }
    .card.running { border-color: rgba(88, 166, 255, .62); box-shadow: 0 0 0 1px rgba(88, 166, 255, .12), 0 12px 26px rgba(0, 0, 0, .22); }
    .card.done { border-color: rgba(146, 155, 166, .26); box-shadow: 0 8px 22px rgba(0, 0, 0, .18); }
    .card.failed { border-color: rgba(248, 81, 73, .48); }
    .card-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 48px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-2);
    }
    .account-wrap { min-width: 0; display: grid; gap: 2px; }
    .account {
      min-width: 0;
      font-size: 14px;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-sub {
      color: var(--muted);
      font-size: 12px;
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
      min-height: 26px;
      padding: 4px 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0f151c;
      color: var(--text);
      font-size: 12px;
      cursor: pointer;
    }
    .history-btn:hover { border-color: var(--blue); color: #cfe5ff; }
    .queue {
      color: var(--warn);
      font-size: 11px;
      white-space: nowrap;
    }
    .pill {
      flex: 0 0 auto;
      max-width: 108px;
      padding: 4px 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1;
      text-transform: capitalize;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pill.running, .pill.ready, .pill.loaded, .pill.liking, .pill.liked, .pill.commenting, .pill.navigating, .pill.login, .pill.starting, .pill.validating-session {
      color: var(--blue);
      border-color: rgba(88, 166, 255, .45);
    }
    .pill.done, .pill.commented { color: #c8d0d8; border-color: rgba(146, 155, 166, .34); background: rgba(146, 155, 166, .08); }
    .pill.failed, .pill.error { color: var(--bad); border-color: rgba(248, 81, 73, .48); }
    .preview-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10;
      min-height: clamp(300px, 21vw, 430px);
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
      background: #24282e;
    }
    .card.pending .preview-wrap {
      background: #252b33;
    }
    .card.pending .placeholder {
      background: #252b33;
    }
    .card.done .preview-wrap,
    .card.done .placeholder {
      background: #1f2328;
    }
    .card.running .placeholder {
      background: #111820;
    }
    .media-thumb {
      display: block;
      object-fit: cover;
      background: #111820;
      transform: scale(1.01);
      transition: filter .18s ease, transform .24s ease;
    }
    .card.pending .media-thumb {
      filter: grayscale(.55) saturate(.72) brightness(.74);
      opacity: .82;
    }
    .card.done .media-thumb {
      filter: grayscale(1) saturate(.5) brightness(.58);
      opacity: .78;
    }
    .card.running .media-thumb {
      filter: saturate(.9) brightness(.82);
    }
    .card.pending .media-fallback {
      filter: grayscale(.18) saturate(.72) brightness(.82);
    }
    .card.done .media-fallback {
      filter: grayscale(1) saturate(.5) brightness(.66);
    }
    .card.failed .media-fallback {
      filter: grayscale(.28) brightness(.72);
    }
    .media-fallback {
      display: block;
      padding: 0;
      color: var(--muted);
      overflow: hidden;
      background:
        radial-gradient(circle at 18% 18%, var(--accent-soft), transparent 35%),
        linear-gradient(135deg, #252a30, #15181c 70%);
    }
    .media-fallback::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(120deg, rgba(255, 255, 255, .08), transparent 24%, transparent 64%, rgba(255, 255, 255, .04)),
        repeating-linear-gradient(90deg, rgba(255, 255, 255, .035) 0 1px, transparent 1px 46px);
      opacity: .5;
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
      background: rgba(11, 12, 15, .38);
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
      border-radius: 22px;
      color: var(--text);
      background: linear-gradient(145deg, var(--accent-soft), rgba(255, 255, 255, .06));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .12), 0 16px 34px rgba(0, 0, 0, .28);
      font-size: 20px;
      font-weight: 900;
    }
    .fallback-title {
      max-width: 100%;
      color: var(--text);
      font-size: clamp(20px, 2.3vw, 30px);
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
      background: linear-gradient(180deg, rgba(11, 12, 15, .04), rgba(11, 12, 15, .08) 55%, rgba(11, 12, 15, .58));
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
      background: rgba(9, 13, 18, .62);
    }
    .done-mark,
    .failed-mark,
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
      color: var(--ok);
      background: rgba(9, 13, 18, .78);
      border: 1px solid rgba(63, 185, 80, .35);
      box-shadow: 0 8px 20px rgba(0, 0, 0, .24);
    }
    .failed-mark {
      color: var(--bad);
      background: rgba(13, 17, 23, .78);
      border: 1px solid rgba(248, 81, 73, .38);
    }
    .error-mark {
      left: 10px;
      right: 10px;
      top: auto;
      bottom: 10px;
      transform: none;
      max-width: calc(100% - 20px);
      padding: 6px 8px;
      background: rgba(248, 81, 73, .92);
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
      background: rgba(63, 185, 80, .9);
      color: #07130a;
      font-size: 10px;
      font-weight: 800;
    }
    .empty {
      grid-column: 1 / -1;
      min-height: 320px;
      display: grid;
      place-items: center;
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--muted);
      background: var(--panel);
      text-align: center;
      padding: 28px;
    }
    .history-inline {
      position: absolute;
      inset: 8px;
      z-index: 4;
      display: grid;
      grid-template-rows: auto 1fr;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(16, 22, 29, .96);
      box-shadow: 0 12px 28px rgba(0, 0, 0, .28);
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
    }
    .close-inline-history {
      width: 24px;
      height: 24px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0d1117;
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
      background: var(--panel);
      padding: 7px;
      display: grid;
      gap: 4px;
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
    @media (max-width: 1250px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      header { align-items: flex-start; flex-direction: column; }
      .summary { white-space: normal; }
    }
    @media (max-width: 640px) {
      main { padding: 10px; }
      .grid { grid-template-columns: 1fr; }
      .preview-wrap { min-height: 260px; }
      .card-head { grid-template-columns: 1fr; align-items: start; }
      .card-status { justify-content: space-between; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Instagram Bot Monitor</h1>
    <div class="summary" id="summary">Connecting...</div>
  </header>
  <main>
    <div class="grid" id="grid"></div>
  </main>
  <script>
    const grid = document.getElementById('grid');
    const summary = document.getElementById('summary');
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
      if (['running', 'active', 'working', 'navigating', 'loaded', 'liking', 'liked', 'commenting', 'ready', 'login', 'login-needed', 'starting', 'validating-session', 'verification', 'manual-verification', 'paused'].includes(status)) return 'running';
      return 'pending';
    };
    const isManualPhase = value => ['login-needed', 'verification', 'manual-verification', 'paused'].includes(String(value || '').toLowerCase());
    const isManualMessage = value => /verification page opened|manual verification|security code|two[- ]factor|confirm it'?s you|suspicious login|verify (your )?(account|identity)|checkpoint|captcha|i'?m not a robot|recaptcha|not logged in|manual instagram login|full experience|tablet app|input\\[name="?email"?\\]/i.test(String(value || ''));
    const formatTime = value => {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString();
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
    const getVisibleSubtitle = item => {
      if (item.comment) return compact(item.comment, getMediaKindLabel(item));
      if (item.scheduledAt) return compact(item.scheduledAt, getMediaKindLabel(item));
      return getMediaKindLabel(item);
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
      const caption = compact(item.comment || item.scheduledAt || phase || 'Waiting', 'Waiting');
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
      if (task.error || item.error) return 'failed';
      if (task.skipped || task.phase === 'commented' || item.status === 'done' || item.phase === 'done' || item.phase === 'commented') return 'done';
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
      return Boolean(
        task.contentKey
        || task.requestedContentKey
        || task.originalUrl
        || task.finalUrl
        || task.error
        || task.phase
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
        + '<div class="preview-wrap">'
        + '<div class="placeholder"></div>'
        + '<img class="media-thumb" alt="" loading="lazy" decoding="async" hidden>'
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
      const visibleSubtitle = getVisibleSubtitle(item);
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
      refs.sub.textContent = visibleSubtitle;
      refs.pill.className = 'pill ' + statusClass(phase);
      refs.pill.textContent = phase;
      refs.queue.textContent = queued ? 'Queue ' + queued : '';
      refs.queue.hidden = !queued;
      refs.done.hidden = true;
      refs.failed.hidden = status !== 'failed';
      refs.error.textContent = task.error || item.error || '';
      refs.error.hidden = !(task.error || item.error);
      refs.mediaName.textContent = visibleSubtitle;
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
        + (item.rowNumber ? '\\nRow: ' + item.rowNumber : '')
        + '\\nTarget: ' + targetText
        + (item.comment ? '\\nComment: ' + item.comment : '')
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
    };

    const showEmpty = () => {
      if (!emptyState) {
        emptyState = document.createElement('div');
        emptyState.className = 'empty';
        emptyState.textContent = 'No actions running or completed yet.';
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
