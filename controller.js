const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const { getMonitorHtml } = require('./dashboard');

const app = express();
app.use(express.json({ limit: '1mb' }));

const browserSessions = new Map();
const browserSessionStorage = new AsyncLocalStorage();
const rememberedDashboardPosts = new Map();
let currentAccountKey;

const createBrowserSession = (accountKey = 'default', accountName = accountKey) => ({
    accountKey,
    accountName,
    browser: null,
    context: null,
    page: null,
    currentTask: null,
    queuedActionTasks: [],
    queue: Promise.resolve(),
    pendingOperations: 0,
    activeOperation: null,
    lastQueueUpdateAt: null,
    manualVerificationAutoCheckInFlight: false,
    manualVerificationResolvedAt: null,
    accountPassword: null,
});

const getBrowserSession = (accountKey = 'default', accountName = accountKey) => {
    const normalizedKey = normalizeAccountName(accountKey) || 'default';
    if (!browserSessions.has(normalizedKey)) {
        browserSessions.set(normalizedKey, createBrowserSession(normalizedKey, accountName || normalizedKey));
    }

    const session = browserSessions.get(normalizedKey);
    session.accountName = accountName || session.accountName || normalizedKey;
    return session;
};

const getActiveBrowserSession = () => {
    const storedSession = browserSessionStorage.getStore();
    if (storedSession) {
        return storedSession;
    }

    if (currentAccountKey && browserSessions.has(currentAccountKey)) {
        return browserSessions.get(currentAccountKey);
    }

    return getBrowserSession('default', 'default');
};

const getActiveTask = () => getActiveBrowserSession().currentTask;
const setActiveTask = task => {
    getActiveBrowserSession().currentTask = task;
};

const createBrowserResourceProxy = resourceName => new Proxy({}, {
    get(_target, property) {
        if (property === 'then') {
            return undefined;
        }

        const resource = getActiveBrowserSession()[resourceName];
        if (!resource) {
            return undefined;
        }

        const value = resource[property];
        return typeof value === 'function' ? value.bind(resource) : value;
    },
    set(_target, property, value) {
        const resource = getActiveBrowserSession()[resourceName];
        if (!resource) {
            return false;
        }

        resource[property] = value;
        return true;
    },
});

const browser = createBrowserResourceProxy('browser');
const context = createBrowserResourceProxy('context');
const page = createBrowserResourceProxy('page');
const currentTask = new Proxy({}, {
    get(_target, property) {
        return getActiveTask()?.[property];
    },
    set(_target, property, value) {
        if (!getActiveTask()) {
            setActiveTask({});
        }

        getActiveTask()[property] = value;
        return true;
    },
});

const SESSION_FILE = path.join(__dirname, 'session.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const ACTION_HISTORY_FILE = process.env.ACTION_HISTORY_FILE || path.join(__dirname, 'action-history.json');
const ACTION_THUMBNAILS_DIR = path.join(__dirname, 'action-thumbnails');
const INSTAGRAM_HOME_URL = 'https://www.instagram.com/';
const INSTAGRAM_LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const PORT = process.env.PORT || 3000;
const AUTO_OPEN_MONITOR = process.env.AUTO_OPEN_MONITOR !== 'false';
const HEADLESS = process.env.HEADLESS === 'true';
const BROWSER_VIEWPORT = {
    width: Number(process.env.BROWSER_VIEWPORT_WIDTH) || 1440,
    height: Number(process.env.BROWSER_VIEWPORT_HEIGHT) || 1000,
};
const BROWSER_WINDOW_WIDTH = Number(process.env.BROWSER_WINDOW_WIDTH) || BROWSER_VIEWPORT.width;
const BROWSER_WINDOW_HEIGHT = Number(process.env.BROWSER_WINDOW_HEIGHT) || BROWSER_VIEWPORT.height + 90;
const MANUAL_BROWSER_WINDOW_WIDTH = Number(process.env.MANUAL_BROWSER_WINDOW_WIDTH) || Math.max(1280, BROWSER_WINDOW_WIDTH + 80);
const MANUAL_BROWSER_WINDOW_HEIGHT = Number(process.env.MANUAL_BROWSER_WINDOW_HEIGHT) || BROWSER_WINDOW_HEIGHT;
const HIDE_BROWSER_WINDOWS = process.env.HIDE_BROWSER_WINDOWS !== 'false' && !HEADLESS;
const AUTO_RESUME_AFTER_MANUAL_VERIFICATION = process.env.AUTO_RESUME_AFTER_MANUAL_VERIFICATION !== 'false';
const DEFAULT_REDIRECT_BROWSING_MS = 65000;
const MONITOR_STREAM_QUALITY = Number(process.env.MONITOR_STREAM_QUALITY) || 72;
const MONITOR_STREAM_MAX_WIDTH = Number(process.env.MONITOR_STREAM_MAX_WIDTH) || 960;
const MONITOR_STREAM_MAX_HEIGHT = Number(process.env.MONITOR_STREAM_MAX_HEIGHT) || 680;
const MONITOR_STREAM_TARGET_FPS = Number(process.env.MONITOR_STREAM_TARGET_FPS) || 30;
const MANUAL_VERIFICATION_CHECK_MS = Number(process.env.MANUAL_VERIFICATION_CHECK_MS) || 1500;
const MANUAL_VERIFICATION_RESUME_DELAY_MS = Number(process.env.MANUAL_VERIFICATION_RESUME_DELAY_MS) || 1500;
const MANUAL_ACTION_COMPLETION_WAIT_MS = Number(process.env.MANUAL_ACTION_COMPLETION_WAIT_MS) || 110000;
const MANUAL_ACTION_COMPLETION_POLL_MS = Number(process.env.MANUAL_ACTION_COMPLETION_POLL_MS) || 1000;
const COMMENT_COMPOSER_OPEN_WAIT_MS = Number(process.env.COMMENT_COMPOSER_OPEN_WAIT_MS) || 45000;
const INDIA_TIME_ZONE = 'Asia/Kolkata';
const INDIA_UTC_OFFSET_MINUTES = 330;
const ACTION_HISTORY_MAX_EVENTS = Number(process.env.ACTION_HISTORY_MAX_EVENTS) || 800;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const COMMENT_COMPOSER_SELECTORS = [
    'textarea[aria-label*="comment" i]',
    'textarea[placeholder*="comment" i]',
    'textarea',
    'input[aria-label*="comment" i]',
    'input[placeholder*="comment" i]',
    '[contenteditable="true"][aria-label*="comment" i]',
    '[contenteditable="true"][aria-placeholder*="comment" i]',
    'div[role="textbox"][contenteditable="true"]',
    'form [contenteditable="true"]',
    '[contenteditable="true"]',
];
const COMMENT_COMPOSER_SELECTOR = COMMENT_COMPOSER_SELECTORS.join(', ');

app.use('/action-thumbnails', express.static(ACTION_THUMBNAILS_DIR));

const openUrlInDefaultBrowser = url => {
    const command = process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
            ? `open "${url}"`
            : `xdg-open "${url}"`;

    exec(command, error => {
        if (error) {
            console.log(`Could not auto-open monitor: ${error.message}`);
        }
    });
};

const getPayload = req => req.body?.parameters || req.body || {};
const isPageOpen = () => {
    const activePage = getActiveBrowserSession().page;
    return Boolean(activePage && !activePage.isClosed());
};
const getFirstPayloadValue = (payload, names) => {
    for (const name of names) {
        const value = payload[name];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return value;
        }
    }

    return null;
};
const normalizeAccountName = value => String(value || '').trim().replace(/^@/, '').toLowerCase();
const normalizeCommentValue = value => String(value || '').replace(/\s+/g, ' ').trim();
const commentValueEquals = (value, expected) => normalizeCommentValue(value) === normalizeCommentValue(expected);
const safeAccountName = value => normalizeAccountName(value).replace(/[^a-z0-9._-]/g, '_');
const getAccountPassword = payload => {
    const password = payload.account_password || payload.instagram_password || payload.password;
    return typeof password === 'string' ? password : String(password || '');
};
const USERNAME_INPUT_SELECTORS = [
    'input[name="username"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
    'input[aria-label*="username" i]',
    'input[placeholder*="username" i]',
    'input[placeholder*="mobile number" i]',
    'input[placeholder*="email" i]',
    'input[type="text"]',
];
const PASSWORD_INPUT_SELECTORS = [
    'input[name="password"]',
    'input[name="pass"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[aria-label*="password" i]',
    'input[placeholder*="password" i]',
];

const getSavedAccounts = () => {
    if (!fs.existsSync(SESSIONS_DIR)) {
        return [];
    }

    return fs.readdirSync(SESSIONS_DIR)
        .filter(file => file.endsWith('.json'))
        .map(file => path.basename(file, '.json'));
};

const normalizeActionHistoryData = data => ({
    completed: data?.completed && typeof data.completed === 'object'
        ? data.completed
        : {},
    events: Array.isArray(data?.events)
        ? data.events.filter(event => event && typeof event === 'object')
        : [],
    posts: data?.posts && typeof data.posts === 'object'
        ? data.posts
        : {},
});

const readActionHistory = () => {
    if (!fs.existsSync(ACTION_HISTORY_FILE)) {
        return normalizeActionHistoryData({});
    }

    try {
        return normalizeActionHistoryData(JSON.parse(fs.readFileSync(ACTION_HISTORY_FILE, 'utf8')));
    } catch (error) {
        console.log(`Could not read action history, starting fresh: ${error.message}`);
        return normalizeActionHistoryData({});
    }
};

const writeActionHistory = history => {
    fs.writeFileSync(ACTION_HISTORY_FILE, JSON.stringify(normalizeActionHistoryData(history), null, 2));
};

const getInstagramContentKey = value => {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
        return null;
    }

    try {
        const url = new URL(rawValue, INSTAGRAM_HOME_URL);
        const [kind, shortcode] = url.pathname.split('/').filter(Boolean);
        const normalizedKind = kind === 'reels' ? 'reel' : kind;

        if (['p', 'reel', 'tv'].includes(normalizedKind) && shortcode) {
            return `${normalizedKind}:${shortcode}`;
        }

        return `url:${url.origin}${url.pathname}`.toLowerCase();
    } catch (_error) {
        return `url:${rawValue.split('?')[0].toLowerCase()}`;
    }
};

const getInstagramUrlForContentKey = contentKey => {
    const [kind, shortcode] = String(contentKey || '').split(':');
    if (!kind || !shortcode) {
        return null;
    }

    if (kind === 'reel') {
        return `${INSTAGRAM_HOME_URL}reel/${shortcode}/`;
    }

    if (kind === 'p') {
        return `${INSTAGRAM_HOME_URL}p/${shortcode}/`;
    }

    if (kind === 'tv') {
        return `${INSTAGRAM_HOME_URL}tv/${shortcode}/`;
    }

    return null;
};

const normalizeUrlForRedirectCheck = value => {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
        return '';
    }

    try {
        const url = new URL(rawValue, INSTAGRAM_HOME_URL);
        const pathname = url.pathname.replace(/\/+$/, '');
        return `${url.origin.toLowerCase()}${pathname}${url.search}`;
    } catch (_error) {
        return rawValue.replace(/\/+$/, '');
    }
};

const didUrlRedirect = (requestedUrl, finalUrl) => {
    return normalizeUrlForRedirectCheck(requestedUrl) !== normalizeUrlForRedirectCheck(finalUrl);
};

const getHistoryKey = (accountKey, contentKey) => `${accountKey || 'default'}::${contentKey}`;

const isTrustedCompletedAction = completedAction => Boolean(completedAction?.verification?.visible);

const getCompletedAction = (accountKey, contentKey) => {
    if (!contentKey) {
        return null;
    }

    const history = readActionHistory();
    const completedAction = history.completed[getHistoryKey(accountKey, contentKey)] || null;
    return isTrustedCompletedAction(completedAction) ? completedAction : null;
};

const normalizeDashboardStatus = value => {
    const status = String(value || '').trim().toLowerCase();
    if (['done', 'completed', 'commented', 'success', 'skipped'].includes(status)) {
        return 'done';
    }
    if (['failed', 'error', 'blocked'].includes(status)) {
        return 'failed';
    }
    if ([
        'running',
        'active',
        'working',
        'navigating',
        'loaded',
        'liking',
        'liked',
        'commenting',
        'ready',
        'login',
        'login-needed',
        'starting',
        'validating-session',
        'verification',
        'manual-verification',
        'paused',
    ].includes(status)) {
        return 'running';
    }
    return 'pending';
};

const MANUAL_ACTION_PHASES = new Set(['verification', 'manual-verification', 'login-needed', 'paused']);
const isManualActionPhase = value => MANUAL_ACTION_PHASES.has(String(value || '').trim().toLowerCase());
const isManualLoginMessage = value => /login|password|username|input\[name="?email"?\]|input\[name="?username"?\]|not logged in|full experience|tablet app|unsupported login prompt/i.test(String(value || ''));
const isManualVerificationMessage = value => /verification page opened|manual verification|security code|two[- ]factor|confirm it'?s you|suspicious login|verify (your )?(account|identity)|checkpoint|captcha|i'?m not a robot|recaptcha/i.test(String(value || ''));
const isManualActionMessage = value => isManualLoginMessage(value) || isManualVerificationMessage(value);
const getManualActionPhase = taskOrMessage => {
    if (taskOrMessage && typeof taskOrMessage === 'object') {
        const phase = taskOrMessage.phase || taskOrMessage.status;
        if (isManualActionPhase(phase)) {
            return String(phase).trim().toLowerCase();
        }
        if (taskOrMessage.verificationRequired || isManualVerificationMessage(taskOrMessage.error || taskOrMessage.message || taskOrMessage.verificationBlocker)) {
            return 'manual-verification';
        }
        if (taskOrMessage.loginRequired) {
            return 'login-needed';
        }
        if (isManualLoginMessage(taskOrMessage.error || taskOrMessage.message || taskOrMessage.verificationBlocker)) {
            return 'login-needed';
        }
        return null;
    }

    return isManualVerificationMessage(taskOrMessage)
        ? 'manual-verification'
        : isManualLoginMessage(taskOrMessage)
            ? 'login-needed'
            : null;
};

const shouldStoreDashboardStatus = value => ['running', 'done', 'failed'].includes(normalizeDashboardStatus(value));

const getInstagramUrlFromPayload = payload => getFirstPayloadValue(payload, [
    'url',
    'instagram_url',
    'instagramUrl',
    'instagram link',
    'instagram_link',
    'post_url',
    'postUrl',
    'post link',
    'post_link',
    'reel_url',
    'reelUrl',
    'reel link',
    'reel_link',
    'reels_url',
    'media_url',
    'target_url',
    'link',
]) || null;

const getDashboardScheduledValue = payload => {
    const scheduledAt = getFirstPayloadValue(payload, ['scheduled_at', 'schedule_at', 'run_at', 'start_at']);
    const scheduledDate = getFirstPayloadValue(payload, ['scheduled_date', 'schedule_date', 'run_date']);
    const scheduledTime = getFirstPayloadValue(payload, ['scheduled_time', 'schedule_time', 'run_time']);
    return scheduledAt || (scheduledDate && scheduledTime ? `${scheduledDate} ${scheduledTime}` : scheduledDate || scheduledTime || null);
};

const getDashboardPostFromPayload = (payload = {}, defaults = {}) => {
    const url = getInstagramUrlFromPayload(payload) || defaults.url || defaults.originalUrl || null;
    const contentKey = getInstagramContentKey(url) || defaults.contentKey || null;
    const accountKey = normalizeAccountName(
        payload.account_username
        || payload.username
        || payload.account
        || defaults.accountKey
        || defaults.account,
    );
    const rowNumber = getFirstPayloadValue(payload, ['row_number', 'rowNumber', 'row', 'sheet_row', 'sheetRow', '__row_number']);
    const status = normalizeDashboardStatus(getFirstPayloadValue(payload, ['action_status', 'dashboard_status', 'status', 'state']) || defaults.status);
    const comment = getFirstPayloadValue(payload, ['comment', 'comment_text', 'text', 'message']);

    if (!accountKey && !contentKey && !url && !rowNumber) {
        return null;
    }

    return {
        account: accountKey || defaults.account || defaults.accountName || 'default',
        accountKey: accountKey || normalizeAccountName(defaults.accountKey || defaults.account) || 'default',
        contentKey,
        url,
        rowNumber: rowNumber || defaults.rowNumber || null,
        comment: comment || defaults.comment || null,
        scheduledAt: getDashboardScheduledValue(payload) || defaults.scheduledAt || null,
        status,
        phase: defaults.phase || status,
        source: defaults.source || 'sheet',
        error: defaults.error || null,
        startedAt: defaults.startedAt || (status === 'running' ? new Date().toISOString() : null),
        completedAt: defaults.completedAt || (status === 'done' ? new Date().toISOString() : null),
        thumbnailUrl: defaults.thumbnailUrl || payload.thumbnailUrl || payload.thumbnail_url || null,
        updatedAt: new Date().toISOString(),
    };
};

const getDashboardPostKey = post => {
    const rowNumber = String(post?.rowNumber || '').trim();
    if (rowNumber) {
        return `${post.accountKey || 'default'}::row:${rowNumber}`;
    }
    if (post?.contentKey) {
        return getHistoryKey(post.accountKey, post.contentKey);
    }
    if (post?.url) {
        return `${post.accountKey || 'default'}::url:${normalizeUrlForRedirectCheck(post.url).toLowerCase()}`;
    }
    return null;
};

const rememberDashboardPost = post => {
    if (!post) {
        return;
    }

    const postKey = getDashboardPostKey(post);
    if (postKey) {
        rememberedDashboardPosts.set(postKey, { ...post, postKey });
    }

    if (post.accountKey && post.contentKey) {
        rememberedDashboardPosts.set(getHistoryKey(post.accountKey, post.contentKey), { ...post, postKey });
    }
};

const findRememberedDashboardPost = ({ accountKey, contentKey, rowNumber, url } = {}) => {
    const normalizedAccountKey = normalizeAccountName(accountKey) || 'default';
    const normalizedContentKey = contentKey || getInstagramContentKey(url);
    const normalizedRowNumber = String(rowNumber || '').trim();

    if (normalizedRowNumber) {
        const byRow = rememberedDashboardPosts.get(`${normalizedAccountKey}::row:${normalizedRowNumber}`);
        if (byRow) {
            return byRow;
        }
    }

    if (normalizedContentKey) {
        const byContent = rememberedDashboardPosts.get(getHistoryKey(normalizedAccountKey, normalizedContentKey));
        if (byContent) {
            return byContent;
        }
    }

    return null;
};

const upsertDashboardPost = post => {
    const postKey = getDashboardPostKey(post);
    if (!postKey) {
        return null;
    }

    const history = readActionHistory();
    const previous = history.posts[postKey] || {};
    const merged = {
        ...previous,
        ...post,
        postKey,
        createdAt: previous.createdAt || post.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    if (!shouldStoreDashboardStatus(merged.status) && !shouldStoreDashboardStatus(merged.phase)) {
        delete history.posts[postKey];
        writeActionHistory(history);
        return null;
    }

    history.posts[postKey] = merged;
    writeActionHistory(history);
    return merged;
};

const replaceDashboardPosts = (posts, options = {}) => {
    const history = readActionHistory();
    const nextPosts = {};
    const activePostKey = options.activePostKey || null;

    posts.forEach(post => {
        const postKey = getDashboardPostKey(post);
        if (!postKey) {
            return;
        }

        if (activePostKey && postKey !== activePostKey && normalizeDashboardStatus(post.status) === 'running') {
            post = {
                ...post,
                status: 'pending',
                phase: 'pending',
                startedAt: null,
            };
        }

        const previous = history.posts[postKey] || {};
        const storedCompletedAction = post.contentKey
            ? history.completed[getHistoryKey(post.accountKey, post.contentKey)]
            : null;
        const completedAction = isTrustedCompletedAction(storedCompletedAction) ? storedCompletedAction : null;
        const merged = {
            ...previous,
            ...post,
            postKey,
            createdAt: previous.createdAt || post.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        if (completedAction) {
            merged.status = 'done';
            merged.phase = 'done';
            merged.completedAt = completedAction.completedAt || merged.completedAt;
            merged.url = completedAction.finalUrl || merged.url;
            merged.thumbnailUrl = completedAction.thumbnailUrl || merged.thumbnailUrl;
        }

        if (shouldStoreDashboardStatus(merged.status) || shouldStoreDashboardStatus(merged.phase)) {
            nextPosts[postKey] = merged;
        }
    });

    history.posts = nextPosts;
    writeActionHistory(history);
    return Object.values(nextPosts);
};

const parseDashboardRowsValue = value => {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return [];
        }
        try {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (_error) {
            return [];
        }
    }
    return value && typeof value === 'object' ? [value] : [];
};

const getDashboardRowsFromPayload = payload => Array.isArray(payload)
    ? payload
    : parseDashboardRowsValue(payload?.rows).length
        ? parseDashboardRowsValue(payload.rows)
        : parseDashboardRowsValue(payload?.posts).length
            ? parseDashboardRowsValue(payload.posts)
            : parseDashboardRowsValue(payload?.items).length
                ? parseDashboardRowsValue(payload.items)
                : [payload];

const getDashboardCurrentRowFromPayload = payload => {
    const candidates = [payload?.current, payload?.currentRow, payload?.current_item, payload?.currentItem, payload?.item, payload?.input];
    for (const candidate of candidates) {
        const parsed = parseDashboardRowsValue(candidate);
        if (parsed.length) {
            return parsed[0];
        }
    }
    return null;
};

const normalizeDashboardPassthroughRow = (row, syncedCount) => ({
    ...(row && typeof row === 'object' && !Array.isArray(row) ? row : { value: row }),
    dashboard_synced: true,
    dashboard_synced_count: syncedCount,
});

const getDashboardPostsSummary = () => {
    const history = readActionHistory();
    const posts = Object.entries(history.posts).map(([postKey, post]) => {
        const completedAction = post.contentKey
            ? history.completed[getHistoryKey(post.accountKey, post.contentKey)]
            : null;
        const manualPhase = getManualActionPhase(post);
        if (manualPhase) {
            return {
                ...post,
                postKey,
                status: 'running',
                phase: manualPhase,
                completedAt: null,
            };
        }

        const isDoneStatus = normalizeDashboardStatus(post.status || post.phase) === 'done';
        const hasTrustedCompletion = isTrustedCompletedAction(completedAction);
        if (isDoneStatus && !hasTrustedCompletion) {
            return {
                ...post,
                postKey,
                status: 'failed',
                phase: 'unverified',
                error: 'Previous Done status was not verified by a visible posted comment. Rerun this item.',
                completedAt: null,
            };
        }

        return { ...post, postKey };
    });

    Object.entries(history.completed).forEach(([historyKey, completedAction]) => {
        if (!isTrustedCompletedAction(completedAction)) {
            return;
        }

        if (posts.some(post => post.accountKey === normalizeAccountName(completedAction.account) && post.contentKey === completedAction.contentKey)) {
            return;
        }

        const accountKey = normalizeAccountName(completedAction.account) || 'default';
        posts.push({
            postKey: historyKey,
            account: completedAction.account || accountKey,
            accountKey,
            contentKey: completedAction.contentKey,
            url: completedAction.finalUrl || completedAction.originalUrl || getInstagramUrlForContentKey(completedAction.contentKey),
            status: 'done',
            phase: 'done',
            source: 'history',
            completedAt: completedAction.completedAt || null,
            thumbnailUrl: completedAction.thumbnailUrl || null,
            createdAt: completedAction.completedAt || null,
            updatedAt: completedAction.completedAt || null,
        });
    });

    return posts.filter(post => ['running', 'done', 'failed'].includes(normalizeDashboardStatus(post.status || post.phase)));
};

const appendActionEvent = event => {
    const history = readActionHistory();
    const accountKey = normalizeAccountName(event.accountKey || event.account) || 'default';
    const actionEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        time: event.time || new Date().toISOString(),
        account: event.account || accountKey,
        accountKey,
        action: event.action || event.phase || 'update',
        status: event.status || event.phase || null,
        contentKey: event.contentKey || null,
        url: event.url || event.originalUrl || event.finalUrl || null,
        message: event.message || null,
        error: event.error || null,
    };

    history.events.push(actionEvent);
    if (history.events.length > ACTION_HISTORY_MAX_EVENTS) {
        history.events = history.events.slice(history.events.length - ACTION_HISTORY_MAX_EVENTS);
    }
    writeActionHistory(history);
    return actionEvent;
};

const recordTaskEvent = (task, action, extra = {}) => {
    if (!task) {
        return null;
    }

    const phase = extra.phase || action;
    const status = extra.status || normalizeDashboardStatus(phase);
    upsertDashboardPost({
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        contentKey: task.contentKey || task.requestedContentKey || null,
        url: task.originalUrl || task.finalUrl || getInstagramUrlForContentKey(task.contentKey) || null,
        comment: task.comment || null,
        status,
        phase,
        source: 'controller',
        error: extra.error || task.error || null,
        startedAt: task.startedAt || null,
        completedAt: extra.completedAt || task.completedAt || null,
        thumbnailUrl: extra.thumbnailUrl || task.thumbnailUrl || null,
    });

    return appendActionEvent({
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        action,
        status,
        contentKey: task.contentKey || task.requestedContentKey || null,
        url: task.originalUrl || task.finalUrl || getInstagramUrlForContentKey(task.contentKey) || null,
        message: extra.message || null,
        error: extra.error || null,
    });
};

const safeThumbnailPart = value => String(value || 'target').replace(/[^a-z0-9._-]/gi, '_').slice(0, 120) || 'target';

const getActionThumbnailFileName = (accountKey, contentKey) => {
    const safeAccount = safeAccountName(accountKey) || 'default';
    const safeTarget = safeThumbnailPart(contentKey);
    return `${safeAccount}--${safeTarget}.jpg`;
};

const getActionThumbnailUrl = (accountKey, contentKey) => {
    return `/action-thumbnails/${encodeURIComponent(getActionThumbnailFileName(accountKey, contentKey))}`;
};

const captureActionThumbnail = async task => {
    if (!task?.accountKey || !task?.contentKey || !isPageOpen()) {
        return null;
    }

    try {
        fs.mkdirSync(ACTION_THUMBNAILS_DIR, { recursive: true });
        const thumbnailPath = path.join(ACTION_THUMBNAILS_DIR, getActionThumbnailFileName(task.accountKey, task.contentKey));
        await page.screenshot({
            path: thumbnailPath,
            type: 'jpeg',
            quality: 72,
            fullPage: false,
            animations: 'disabled',
        });
        return getActionThumbnailUrl(task.accountKey, task.contentKey);
    } catch (error) {
        console.log(`Could not capture action thumbnail for ${task.accountKey}: ${error.message}`);
        return null;
    }
};

const markCurrentTaskCompleted = async () => {
    const task = getActiveTask();
    if (!task?.accountKey || !task?.contentKey || task.skip) {
        return null;
    }
    if (!task.commentVerification?.visible) {
        throw new Error('Comment was not visibly verified on Instagram, so this row will not be marked done.');
    }

    const history = readActionHistory();
    const historyKey = getHistoryKey(task.accountKey, task.contentKey);
    const completedAction = {
        account: task.accountName || task.accountKey,
        contentKey: task.contentKey,
        originalUrl: task.originalUrl,
        finalUrl: isPageOpen() ? page.url() : task.finalUrl,
        completedAt: new Date().toISOString(),
        comment: task.comment || null,
        verification: task.commentVerification || null,
    };
    const thumbnailUrl = await captureActionThumbnail(task);
    if (thumbnailUrl) {
        completedAction.thumbnailUrl = thumbnailUrl;
        task.thumbnailUrl = thumbnailUrl;
    }

    history.completed[historyKey] = completedAction;
    writeActionHistory(history);
    task.phase = 'commented';
    task.completedAt = completedAction.completedAt;
    task.completedAction = completedAction;
    task.updatedAt = completedAction.completedAt;
    upsertDashboardPost({
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        contentKey: task.contentKey,
        url: completedAction.finalUrl || completedAction.originalUrl,
        status: 'done',
        phase: 'commented',
        comment: task.comment || null,
        verification: completedAction.verification || null,
        startedAt: task.startedAt || null,
        completedAt: completedAction.completedAt,
        thumbnailUrl: completedAction.thumbnailUrl || null,
    });
    recordTaskEvent(task, 'commented', {
        status: 'done',
        completedAt: completedAction.completedAt,
        thumbnailUrl: completedAction.thumbnailUrl || null,
    });
    console.log(`Recorded completed action: ${historyKey}`);

    return completedAction;
};

const getRedirectBrowsingMs = () => {
    const configuredMs = Number(process.env.REDIRECT_BROWSING_MS);

    if (!Number.isFinite(configuredMs) || configuredMs <= 0) {
        return DEFAULT_REDIRECT_BROWSING_MS;
    }

    return Math.max(60000, configuredMs);
};

const startCurrentTask = (accountKey, accountName) => {
    setActiveTask({
        accountKey,
        accountName,
        skip: false,
        redirected: false,
        redirectBrowsingDone: false,
        phase: 'starting',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    recordTaskEvent(getActiveTask(), 'starting', { status: 'running' });
};

const ensureCurrentTask = () => {
    const activeSession = getActiveBrowserSession();
    if (!activeSession.currentTask) {
        const fallbackAccount = activeSession.accountKey || currentAccountKey || 'default';
        startCurrentTask(fallbackAccount, activeSession.accountName || fallbackAccount);
    }

    return activeSession.currentTask;
};

const markCurrentTaskSkipped = ({ contentKey, originalUrl, finalUrl, completedAction }) => {
    const task = ensureCurrentTask();
    task.skip = true;
    task.skipReason = 'This account already completed this post earlier.';
    task.phase = 'skipped';
    task.contentKey = contentKey || task.contentKey;
    task.originalUrl = originalUrl || task.originalUrl;
    task.finalUrl = finalUrl || task.finalUrl;
    task.completedAction = completedAction || null;
    task.skippedAt = new Date().toISOString();
    task.updatedAt = task.skippedAt;
    recordTaskEvent(task, 'skipped', {
        status: 'done',
        message: task.skipReason,
        completedAt: completedAction?.completedAt || task.skippedAt,
    });

    return task;
};

const skippedTaskResponse = action => {
    const task = getActiveTask();
    if (!task?.skip) {
        return null;
    }

    return {
        success: true,
        completed: true,
        status: 'done',
        actionStatus: 'done',
        skipped: true,
        action,
        reason: task.skipReason,
        account: task.accountName || task.accountKey,
        contentKey: task.contentKey,
        alreadyCompleted: task.completedAction,
        browserClosed: !isPageOpen(),
    };
};

const isFinalTask = task => Boolean(
    task?.completedAt
    || task?.skip
    || ['commented', 'done', 'skipped', 'failed', 'error'].includes(String(task?.phase || '').toLowerCase()),
);

const getActionTargetFromPayload = payload => {
    const url = getInstagramUrlFromPayload(payload);
    const contentKey = getInstagramContentKey(url);
    const rowNumber = getFirstPayloadValue(payload, ['row_number', 'rowNumber', 'row', 'sheet_row', 'sheetRow', '__row_number']);
    const comment = getFirstPayloadValue(payload, ['comment', 'comment_text', 'text', 'message']);

    return {
        url,
        contentKey,
        rowNumber: rowNumber ? String(rowNumber).trim() : null,
        comment: comment ? String(comment).trim() : null,
    };
};

const sameTaskTarget = (task, target = {}) => {
    if (!task || !target) {
        return false;
    }

    if (target.contentKey && (task.contentKey === target.contentKey || task.requestedContentKey === target.contentKey)) {
        return true;
    }

    if (target.rowNumber && String(task.rowNumber || '') === String(target.rowNumber)) {
        return true;
    }

    if (target.url && task.originalUrl && normalizeUrlForRedirectCheck(target.url) === normalizeUrlForRedirectCheck(task.originalUrl)) {
        return true;
    }

    return false;
};

const getQueuedTaskKey = task => {
    if (task.rowNumber) {
        return `${task.accountKey || 'default'}::row:${task.rowNumber}`;
    }
    if (task.contentKey || task.requestedContentKey) {
        return getHistoryKey(task.accountKey, task.contentKey || task.requestedContentKey);
    }
    if (task.originalUrl) {
        return `${task.accountKey || 'default'}::url:${normalizeUrlForRedirectCheck(task.originalUrl).toLowerCase()}`;
    }
    return `${task.accountKey || 'default'}::queued`;
};

const findQueuedActionTask = (session, target = {}) => {
    const queue = session.queuedActionTasks || [];

    if (target.contentKey) {
        const byContent = queue.find(task => task.contentKey === target.contentKey || task.requestedContentKey === target.contentKey);
        if (byContent) {
            return byContent;
        }
    }

    if (target.rowNumber) {
        const byRow = queue.find(task => String(task.rowNumber || '') === String(target.rowNumber));
        if (byRow) {
            return byRow;
        }
    }

    if (target.url) {
        const byUrl = queue.find(task => task.originalUrl && normalizeUrlForRedirectCheck(task.originalUrl) === normalizeUrlForRedirectCheck(target.url));
        if (byUrl) {
            return byUrl;
        }
    }

    if (target.comment) {
        const byComment = queue.find(task => task.comment && task.comment === target.comment);
        if (byComment) {
            return byComment;
        }
    }

    return queue[0] || null;
};

const queueActionTask = (session, payload, defaults = {}) => {
    const target = {
        ...getActionTargetFromPayload(payload),
        ...defaults,
    };
    const rememberedPost = findRememberedDashboardPost({
        accountKey: session.accountKey,
        contentKey: target.contentKey,
        rowNumber: target.rowNumber,
        url: target.url,
    });
    const mergedTarget = {
        ...target,
        url: target.url || rememberedPost?.url || null,
        contentKey: target.contentKey || rememberedPost?.contentKey || null,
        rowNumber: target.rowNumber || rememberedPost?.rowNumber || null,
        comment: target.comment || rememberedPost?.comment || null,
    };
    let task = findQueuedActionTask(session, mergedTarget);

    if (!task) {
        task = {
            accountKey: session.accountKey,
            accountName: session.accountName || session.accountKey,
            queuedAt: new Date().toISOString(),
            skip: false,
            redirected: false,
            redirectBrowsingDone: false,
        };
        session.queuedActionTasks.push(task);
    }

    task.accountKey = session.accountKey;
    task.accountName = session.accountName || session.accountKey;
    task.originalUrl = mergedTarget.url || task.originalUrl || null;
    task.requestedContentKey = mergedTarget.contentKey || task.requestedContentKey || null;
    task.contentKey = mergedTarget.contentKey || task.contentKey || null;
    task.rowNumber = mergedTarget.rowNumber || task.rowNumber || null;
    task.comment = mergedTarget.comment || task.comment || null;
    task.phase = 'queued';
    task.updatedAt = new Date().toISOString();
    task.queueKey = getQueuedTaskKey(task);
    return task;
};

const removeQueuedActionTask = (session, taskToRemove) => {
    session.queuedActionTasks = (session.queuedActionTasks || []).filter(task => task !== taskToRemove);
};

const completedActionResponse = (action, completedAction, account) => ({
    success: true,
    completed: true,
    skipped: true,
    alreadyCompleted: true,
    status: 'done',
    actionStatus: 'done',
    action,
    account,
    contentKey: completedAction?.contentKey || null,
    completedAction,
});

const queuedTaskResponse = (action, task, activeTask) => ({
    success: true,
    completed: false,
    queued: true,
    status: 'running',
    actionStatus: 'running',
    action,
    account: task.accountName || task.accountKey,
    contentKey: task.contentKey || task.requestedContentKey || null,
    rowNumber: task.rowNumber || null,
    waitingFor: activeTask
        ? {
            contentKey: activeTask.contentKey || activeTask.requestedContentKey || null,
            phase: activeTask.phase || null,
        }
        : null,
});

const toIndianDate = ({ year, month, day, hour = 0, minute = 0, second = 0 }) => {
    return new Date(Date.UTC(year, month - 1, day, hour, minute - INDIA_UTC_OFFSET_MINUTES, second));
};

const normalizeIndianHour = (rawHour, meridiem) => {
    let hour = Number(rawHour || 0);
    if (!meridiem) {
        return hour;
    }

    const isPm = String(meridiem).toLowerCase() === 'pm';
    if (isPm && hour < 12) {
        hour += 12;
    }
    if (!isPm && hour === 12) {
        hour = 0;
    }

    return hour;
};

const hasExplicitTimezone = value => /(?:z|[+-]\d{2}:?\d{2})$/i.test(String(value || '').trim());

const formatIndiaDateTime = date => new Intl.DateTimeFormat('en-IN', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
}).format(date);

const parseFlexibleIndianDateTime = value => {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
        return null;
    }

    if (hasExplicitTimezone(rawValue)) {
        const timestamp = Date.parse(rawValue);
        return Number.isNaN(timestamp) ? null : new Date(timestamp);
    }

    const isoLike = rawValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
    if (isoLike) {
        const [, year, month, day, rawHour = '0', minute = '0', second = '0', meridiem] = isoLike;
        return toIndianDate({
            year: Number(year),
            month: Number(month),
            day: Number(day),
            hour: normalizeIndianHour(rawHour, meridiem),
            minute: Number(minute),
            second: Number(second),
        });
    }

    const dmy = rawValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
    if (dmy) {
        const [, day, month, year, rawHour = '0', minute = '0', second = '0', meridiem] = dmy;
        return toIndianDate({
            year: Number(year),
            month: Number(month),
            day: Number(day),
            hour: normalizeIndianHour(rawHour, meridiem),
            minute: Number(minute),
            second: Number(second),
        });
    }

    const timestamp = Date.parse(rawValue);
    return Number.isNaN(timestamp) ? null : new Date(timestamp);
};

const getScheduleDelay = payload => {
    const relativeSeconds = Number(getFirstPayloadValue(payload, [
        'wait_before_seconds',
        'delay_before_seconds',
        'schedule_delay_seconds',
        'start_after_seconds',
    ]));

    if (Number.isFinite(relativeSeconds) && relativeSeconds > 0) {
        return {
            hasSchedule: true,
            source: 'wait_before_seconds',
            waitMs: Math.round(relativeSeconds * 1000),
            targetAt: null,
        };
    }

    const scheduledAt = getFirstPayloadValue(payload, [
        'scheduled_at',
        'schedule_at',
        'run_at',
        'start_at',
    ]);
    const scheduledDate = getFirstPayloadValue(payload, ['scheduled_date', 'schedule_date', 'run_date']);
    const scheduledTime = getFirstPayloadValue(payload, ['scheduled_time', 'schedule_time', 'run_time']);
    const combinedSchedule = scheduledAt || (scheduledDate && scheduledTime ? `${scheduledDate} ${scheduledTime}` : null);

    if (!combinedSchedule) {
        return {
            hasSchedule: false,
            source: null,
            waitMs: 0,
            targetAt: null,
        };
    }

    const targetDate = parseFlexibleIndianDateTime(combinedSchedule);
    if (!targetDate || Number.isNaN(targetDate.getTime())) {
        throw new Error(`Invalid schedule date/time: "${combinedSchedule}". Use DD-MM-YYYY HH:mm:ss, for example 30-05-2026 14:30:00.`);
    }

    return {
        hasSchedule: true,
        source: scheduledAt ? 'scheduled_at' : 'scheduled_date + scheduled_time',
        waitMs: Math.max(0, targetDate.getTime() - Date.now()),
        targetAt: targetDate.toISOString(),
        targetAtIndia: formatIndiaDateTime(targetDate),
    };
};

const waitForSchedule = async (payload, label = 'task') => {
    const schedule = getScheduleDelay(payload);
    if (!schedule.hasSchedule) {
        return {
            scheduled: false,
            waitedMs: 0,
        };
    }

    if (schedule.waitMs <= 0) {
        console.log(`Schedule for ${label} is due now. Source: ${schedule.source}. Target IST: ${schedule.targetAtIndia}.`);
        return {
            scheduled: true,
            waitedMs: 0,
            source: schedule.source,
            targetAt: schedule.targetAt,
            targetAtIndia: schedule.targetAtIndia,
        };
    }

    console.log(`Waiting ${Math.round(schedule.waitMs / 1000)} seconds before ${label}. Source: ${schedule.source}. Target IST: ${schedule.targetAtIndia}.`);
    const startedAt = Date.now();
    while (Date.now() - startedAt < schedule.waitMs) {
        await wait(Math.min(60000, schedule.waitMs - (Date.now() - startedAt)));
    }

    return {
        scheduled: true,
        waitedMs: schedule.waitMs,
        source: schedule.source,
        targetAt: schedule.targetAt,
        targetAtIndia: schedule.targetAtIndia,
    };
};

const getSessionForPayload = payload => {
    const requestedAccount = normalizeAccountName(payload.account_username || payload.username || payload.account);

    if (!requestedAccount) {
        return {
            accountKey: 'default',
            accountName: 'default',
            sessionFile: SESSION_FILE,
        };
    }

    return {
        accountKey: requestedAccount,
        accountName: requestedAccount,
        sessionFile: path.join(SESSIONS_DIR, `${safeAccountName(requestedAccount)}.json`),
    };
};

const getSessionForRequestPayload = payload => {
    const requestedAccount = normalizeAccountName(payload.account_username || payload.username || payload.account);
    const accountKey = requestedAccount || currentAccountKey || 'default';
    return getBrowserSession(accountKey, accountKey);
};

const rememberSessionCredentials = (session, payload = {}) => {
    const password = getAccountPassword(payload);
    if (password) {
        session.accountPassword = password;
    }
    return session.accountPassword || '';
};

const getSessionAccountPassword = (session, payload = {}) => rememberSessionCredentials(session, payload);

const isManualVerificationTask = task => Boolean(task && getManualActionPhase(task));

const ensurePausedTaskPhase = task => {
    if (!isManualVerificationTask(task)) {
        return task;
    }

    const phase = getManualActionPhase(task) || (task.loginRequired ? 'login-needed' : 'manual-verification');
    if (task.phase !== phase || normalizeDashboardStatus(task.status) === 'failed') {
        task.phase = phase;
        task.updatedAt = new Date().toISOString();
        recordTaskEvent(task, phase, {
            status: 'running',
            error: task.error || null,
            message: task.error || null,
        });
    }

    return task;
};

const manualVerificationResponse = (action, task, extra = {}) => {
    const pausedTask = ensurePausedTaskPhase(task);
    const phase = extra.phase || getManualActionPhase(pausedTask) || (pausedTask?.loginRequired ? 'login-needed' : pausedTask?.verificationRequired ? 'manual-verification' : pausedTask?.phase) || 'manual-verification';
    return {
        success: true,
        completed: false,
        status: 'running',
        actionStatus: 'running',
        paused: true,
        action,
        account: pausedTask?.accountName || pausedTask?.accountKey || extra.account || null,
        contentKey: pausedTask?.contentKey || pausedTask?.requestedContentKey || extra.contentKey || null,
        rowNumber: pausedTask?.rowNumber || extra.rowNumber || null,
        phase,
        verificationRequired: phase !== 'login-needed' || extra.verificationRequired === true,
        loginRequired: phase === 'login-needed' || extra.loginRequired === true,
        browserVisible: Boolean(extra.browserVisible),
        message: extra.message || pausedTask?.error || null,
        next: extra.next || 'Finish the Instagram verification/login in the visible browser, then call POST /browser/save-session for this account.',
    };
};

const sendManualVerificationResponse = (res, action, errorOrTask, extra = {}) => {
    const task = ensurePausedTaskPhase(errorOrTask?.manualVerification ? getActiveTask() : errorOrTask);
    const error = errorOrTask?.manualVerification ? errorOrTask : null;
    const phase = extra.phase || getManualActionPhase(task) || getManualActionPhase(error?.message) || task?.phase;
    return res.json(manualVerificationResponse(action, task, {
        ...extra,
        verificationRequired: extra.verificationRequired ?? phase !== 'login-needed',
        loginRequired: extra.loginRequired ?? phase === 'login-needed',
        browserVisible: extra.browserVisible ?? Boolean(isPageOpen()),
        message: extra.message || error?.message || task?.error,
        phase,
    }));
};

const sendManualActionStillWaitingResponse = (res, action, task, extra = {}) => {
    const response = manualVerificationResponse(action, task, {
        ...extra,
        message: extra.message || task?.error || 'Instagram verification/login is still waiting, so this action is not done yet.',
    });
    return res.status(423).json({
        ...response,
        success: false,
        completed: false,
        status: 'running',
        actionStatus: 'running',
        queued: extra.queued ?? response.queued,
        message: response.message,
    });
};

const hydrateTaskFromPayload = (session, payload = {}, defaults = {}) => {
    const task = ensureCurrentTask();
    const target = {
        ...getActionTargetFromPayload(payload),
        ...defaults,
    };
    const rememberedPost = findRememberedDashboardPost({
        accountKey: session.accountKey,
        contentKey: target.contentKey,
        rowNumber: target.rowNumber,
        url: target.url,
    });
    const url = target.url || rememberedPost?.url || task.originalUrl || null;
    const contentKey = target.contentKey || rememberedPost?.contentKey || task.contentKey || getInstagramContentKey(url) || null;

    task.accountKey = session.accountKey;
    task.accountName = session.accountName || session.accountKey;
    task.originalUrl = url || task.originalUrl || null;
    task.requestedContentKey = contentKey || task.requestedContentKey || null;
    task.contentKey = contentKey || task.contentKey || null;
    task.rowNumber = target.rowNumber || rememberedPost?.rowNumber || task.rowNumber || null;
    task.comment = target.comment || rememberedPost?.comment || task.comment || null;
    task.updatedAt = new Date().toISOString();
    return task;
};

const markCurrentTaskPaused = async ({ phase = 'manual-verification', message, blocker, stage, loginRequired = false, payload = null, session = null } = {}) => {
    const activeSession = session || getActiveBrowserSession();
    if (!getActiveTask()) {
        startCurrentTask(activeSession.accountKey || currentAccountKey || 'default', activeSession.accountName || activeSession.accountKey || currentAccountKey || 'default');
    }

    const task = payload
        ? hydrateTaskFromPayload(activeSession, payload)
        : ensureCurrentTask();
    const pausedAt = new Date().toISOString();
    task.phase = phase;
    task.error = message || blocker || 'Instagram needs manual verification.';
    task.verificationRequired = !loginRequired;
    task.loginRequired = Boolean(loginRequired);
    task.verificationStage = stage || null;
    task.verificationBlocker = blocker || null;
    task.updatedAt = pausedAt;
    activeSession.manualVerification = {
        phase,
        message: task.error,
        blocker: blocker || null,
        stage: stage || null,
        at: pausedAt,
    };
    activeSession.manualVerificationResolvedAt = null;

    if (isPageOpen()) {
        await showBrowserWindow();
    }

    recordTaskEvent(task, phase, {
        status: 'running',
        error: task.error,
        message: task.error,
    });

    return task;
};

const createManualVerificationError = ({ stage, blocker, task }) => {
    const error = new Error(`Verification required during ${stage}. ${blocker} Solve it manually in the visible Instagram browser, then call POST /browser/save-session for this account.`);
    error.manualVerification = true;
    error.stage = stage;
    error.blocker = blocker;
    error.task = task || getActiveTask();
    return error;
};

const runInBrowserSession = async (session, operation, label = 'operation') => {
    currentAccountKey = session.accountKey;
    session.pendingOperations += 1;
    session.lastQueueUpdateAt = new Date().toISOString();

    const previousQueue = session.queue.catch(() => null);
    const nextQueue = previousQueue.then(() => browserSessionStorage.run(session, async () => {
        session.activeOperation = label;
        session.lastQueueUpdateAt = new Date().toISOString();
        try {
            return await operation(session);
        } catch (error) {
            if (error?.manualVerification) {
                throw error;
            }

            const manualPhase = getManualActionPhase(error?.message);
            if (manualPhase) {
                const task = await markCurrentTaskPaused({
                    phase: manualPhase,
                    message: error?.message || String(error),
                    loginRequired: manualPhase === 'login-needed',
                    stage: label,
                    session,
                });
                throw createManualVerificationError({
                    stage: label,
                    blocker: task.error,
                    task,
                });
            }

            if (session.currentTask) {
                session.currentTask.phase = 'error';
                session.currentTask.error = error?.message || String(error);
                session.currentTask.updatedAt = new Date().toISOString();
                recordTaskEvent(session.currentTask, 'error', {
                    status: 'failed',
                    error: session.currentTask.error,
                });
            }
            throw error;
        } finally {
            session.pendingOperations = Math.max(0, session.pendingOperations - 1);
            session.activeOperation = null;
            session.lastQueueUpdateAt = new Date().toISOString();
        }
    }));
    session.queue = nextQueue.catch(() => null);

    return nextQueue;
};

const closeBrowser = async ({ preserveTask = false } = {}) => {
    const activeSession = getActiveBrowserSession();
    if (activeSession.browser) {
        await activeSession.browser.close();
        console.log(`Browser closed for ${activeSession.accountName || activeSession.accountKey}.`);
    }

    activeSession.browser = null;
    activeSession.context = null;
    activeSession.page = null;
    if (currentAccountKey === activeSession.accountKey) {
        currentAccountKey = null;
    }
    if (!preserveTask) {
        activeSession.currentTask = null;
    }
};

const hasQueuedRunnableAction = session => (session.queuedActionTasks || []).some(task => Boolean(
    task
    && !task.skip
    && (task.originalUrl || task.finalUrl || task.contentKey || task.requestedContentKey || task.rowNumber),
));

const closeBrowserAfterCompletedTask = async (session, reason = 'completed task') => {
    if (!isPageOpen()) {
        return false;
    }

    if (hasQueuedRunnableAction(session)) {
        console.log(`Keeping browser open for ${session.accountName || session.accountKey}; queued actions are still waiting after ${reason}.`);
        return false;
    }

    if ((session.pendingOperations || 0) > 1) {
        console.log(`Keeping browser open for ${session.accountName || session.accountKey}; ${session.pendingOperations - 1} pending operation(s) are still waiting after ${reason}.`);
        return false;
    }

    console.log(`Closing browser for ${session.accountName || session.accountKey} after ${reason}.`);
    await closeBrowser({ preserveTask: true });
    return true;
};

const requirePage = () => {
    if (!isPageOpen()) {
        throw new Error('Browser not started. Call POST /browser/start first.');
    }
};

const sendError = (res, error, status = 500) => {
    const message = error?.message || String(error);
    res.status(status).json({ success: false, error: message });
};

const showBrowserWindow = async () => {
    const activeSession = getActiveBrowserSession();
    if (HEADLESS || !activeSession.context || !activeSession.page || activeSession.page.isClosed()) {
        return;
    }

    let cdpSession = null;
    try {
        await activeSession.page.bringToFront().catch(() => null);
        cdpSession = await activeSession.context.newCDPSession(activeSession.page);
        const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
        const visibleManualCount = Array.from(browserSessions.values())
            .filter(session => session !== activeSession && session.browserVisibleForManualVerification)
            .length;
        const cascadeOffset = (visibleManualCount % 4) * 32;
        await cdpSession.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
                left: 32 + cascadeOffset,
                top: 32 + cascadeOffset,
                width: MANUAL_BROWSER_WINDOW_WIDTH,
                height: MANUAL_BROWSER_WINDOW_HEIGHT,
                windowState: 'normal',
            },
        });
        activeSession.browserVisibleForManualVerification = true;
    } catch (error) {
        console.log(`Could not show browser window: ${error.message}`);
    } finally {
        if (cdpSession) {
            await cdpSession.detach().catch(() => null);
        }
    }
};

const hideBrowserWindow = async () => {
    const activeSession = getActiveBrowserSession();
    if (!HIDE_BROWSER_WINDOWS || !activeSession.context || !activeSession.page || activeSession.page.isClosed()) {
        return;
    }

    let cdpSession = null;
    try {
        cdpSession = await activeSession.context.newCDPSession(activeSession.page);
        const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
        await cdpSession.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
                left: -32000,
                top: -32000,
                width: BROWSER_WINDOW_WIDTH,
                height: BROWSER_WINDOW_HEIGHT,
                windowState: 'normal',
            },
        });
        activeSession.browserVisibleForManualVerification = false;
    } catch (error) {
        console.log(`Could not hide browser window: ${error.message}`);
    } finally {
        if (cdpSession) {
            await cdpSession.detach().catch(() => null);
        }
    }
};

const launchBrowser = async storageState => {
    const activeSession = getActiveBrowserSession();
    const launchArgs = [`--window-size=${BROWSER_WINDOW_WIDTH},${BROWSER_WINDOW_HEIGHT}`];
    if (HIDE_BROWSER_WINDOWS) {
        launchArgs.push('--window-position=-32000,-32000');
    }

    activeSession.browser = await chromium.launch({
        headless: HEADLESS,
        args: launchArgs,
    });

    activeSession.context = await activeSession.browser.newContext({
        ...(storageState ? { storageState } : {}),
        viewport: BROWSER_VIEWPORT,
    });
    activeSession.page = await activeSession.context.newPage();
    await hideBrowserWindow();
};

const firstVisibleLocator = async selectors => {
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
            return locator;
        }
    }

    return null;
};

const getLoginInputs = async () => {
    const usernameInput = await firstVisibleLocator(USERNAME_INPUT_SELECTORS);
    const passwordInput = await firstVisibleLocator(PASSWORD_INPUT_SELECTORS);

    return { usernameInput, passwordInput };
};

const getInstagramBlocker = async () => {
    const url = page.url();
    if (/\/challenge\/|\/checkpoint\/|\/accounts\/two_factor|\/accounts\/suspended|\/auth_platform\/recaptcha|\/recaptcha/i.test(url)) {
        return `Instagram verification page opened: ${url}`;
    }

    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const blockerPatterns = [
        /enter (the )?security code/i,
        /two[- ]factor/i,
        /confirm (it'?s|it's) you/i,
        /suspicious login/i,
        /verify (your )?(account|identity)/i,
        /checkpoint/i,
        /captcha/i,
        /i'?m not a robot/i,
        /recaptcha/i,
    ];

    const matchedPattern = blockerPatterns.find(pattern => pattern.test(bodyText));
    return matchedPattern ? 'Instagram is asking for verification, security code, or captcha.' : null;
};

const getInstagramLoginGate = async () => {
    if (!isPageOpen()) {
        return null;
    }

    const url = page.url();
    const loginFormVisible = await isLoginFormVisible().catch(() => false);
    if (/\/accounts\/login/i.test(url) && loginFormVisible) {
        return 'Instagram login form is visible.';
    }

    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const loginPatterns = [
        /get the full experience with/i,
        /the tablet app/i,
        /log in\s*or\s*sign up/i,
        /log in to (like|comment|continue|instagram)/i,
        /log in to like or comment/i,
        /never miss a post from/i,
        /sign up for instagram/i,
        /create new account/i,
        /forgot password/i,
    ];
    const matchedPattern = loginPatterns.find(pattern => pattern.test(bodyText));
    if (matchedPattern) {
        return `Instagram is asking this account to log in: ${matchedPattern}`;
    }

    const hasLoginModal = await page.evaluate(() => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = element => {
            if (!element || !(element instanceof Element)) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };

        return Array.from(document.querySelectorAll('[role="dialog"], main, body'))
            .filter(isVisible)
            .some(element => {
                const text = normalize(element.textContent);
                return (
                    (text.includes('sign up') && text.includes('log in') && text.includes('instagram'))
                    || text.includes('log in to like or comment')
                    || text.includes('never miss a post from')
                    || text.includes('get the full experience')
                );
            });
    }).catch(() => false);

    return hasLoginModal ? 'Instagram login/sign-up prompt is blocking the action.' : null;
};

const throwIfInstagramBlocked = async stage => {
    const blocker = await getInstagramBlocker();
    if (!blocker) {
        return;
    }

    const task = await markCurrentTaskPaused({
        phase: 'manual-verification',
        blocker,
        stage,
    });
    throw createManualVerificationError({ stage, blocker, task });
};

const isLoginFormVisible = async () => {
    const { usernameInput, passwordInput } = await getLoginInputs();

    return Boolean(usernameInput && passwordInput);
};

const isLoggedIn = async () => {
    await wait(1500);

    const blocker = await getInstagramBlocker();
    if (blocker) {
        const task = await markCurrentTaskPaused({
            phase: 'manual-verification',
            blocker,
            stage: 'login/session validation',
        });
        throw createManualVerificationError({ stage: 'login/session validation', blocker, task });
    }

    if (await getInstagramLoginGate()) {
        return false;
    }

    return true;
};

const clickFirstVisibleButton = async labels => {
    for (const label of labels) {
        const button = page.getByRole('button', { name: label }).first();
        if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
            await button.click().catch(() => null);
            await wait(1000);
            return true;
        }
    }

    return page.evaluate(patternSources => {
        const isVisible = element => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const patterns = patternSources.map(source => new RegExp(source, 'i'));

        const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
            .filter(isVisible)
            .map(element => {
                const text = normalize(element.textContent);
                const rect = element.getBoundingClientRect();

                return {
                    element,
                    text,
                    area: rect.width * rect.height,
                    top: rect.top,
                    left: rect.left,
                };
            })
            .filter(candidate => candidate.text && patterns.some(pattern => pattern.test(candidate.text)))
            .filter(candidate => !candidate.element.disabled && candidate.element.getAttribute('aria-disabled') !== 'true')
            .sort((a, b) => {
                if (a.area !== b.area) {
                    return a.area - b.area;
                }

                return a.top - b.top || a.left - b.left;
            });

        const target = candidates[0]?.element;
        if (!target) {
            return false;
        }

        const clickable = target.closest('button, [role="button"], a') || target;
        clickable.click();
        return true;
    }, labels.map(label => label.source)).catch(() => false);
};

const dismissInstagramDialogs = async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const clicked = await clickFirstVisibleButton([
            /^allow all cookies$/i,
            /^only allow essential cookies$/i,
            /^not now$/i,
            /^no thanks$/i,
            /^skip$/i,
            /^maybe later$/i,
            /^cancel$/i,
        ]);

        if (!clicked) {
            return;
        }

        await wait(1000);
    }
};

const closeMessagesPanelIfOpen = async () => {
    const panel = await page.evaluate(() => {
        if (/\/direct\//i.test(window.location.pathname)) {
            return null;
        }

        const isVisible = element => {
            if (!element || !(element instanceof Element)) {
                return false;
            }

            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const rectToObject = rect => ({
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        });
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-label*="Messages" i], aside, section, div'))
            .filter(isVisible)
            .map(element => ({ element, text: normalize(element.textContent), rect: element.getBoundingClientRect() }))
            .filter(candidate => (
                (
                    /new message/i.test(candidate.text)
                    || /\bto:\s*search/i.test(candidate.text)
                    || /send message to start a chat/i.test(candidate.text)
                    || (/^messages\b/i.test(candidate.text) && /no messages found|new message|search|your messages/i.test(candidate.text))
                    || (/messages/i.test(candidate.text) && /no messages found/i.test(candidate.text))
                )
                && !/comments|add a comment|comment as/i.test(candidate.text)
                && candidate.rect.width >= 160
                && candidate.rect.width <= 560
                && candidate.rect.height >= 140
                && candidate.rect.height <= window.innerHeight
            ))
            .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

        const dialogCandidate = dialogs[0];
        if (!dialogCandidate) {
            return null;
        }

        const { element: dialog, rect: dialogRect } = dialogCandidate;
        const closeTarget = Array.from(dialog.querySelectorAll('button, [role="button"], svg, div, span'))
            .filter(isVisible)
            .map(element => {
                const rect = element.getBoundingClientRect();
                const label = normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
                return {
                    element,
                    label,
                    rect,
                    rightBias: rect.left + rect.width / 2,
                    topBias: rect.top + rect.height / 2,
                };
            })
            .filter(candidate => {
                const nearTopRight = candidate.rect.width <= 44
                    && candidate.rect.height <= 44
                    && candidate.rect.left >= dialogRect.right - 90
                    && candidate.rect.top <= dialogRect.top + 90;
                return /close|cancel/i.test(candidate.label) || nearTopRight;
            })
            .sort((a, b) => {
                const labelScore = Number(/close/i.test(b.label)) - Number(/close/i.test(a.label));
                if (labelScore) {
                    return labelScore;
                }
                return b.rightBias - a.rightBias || a.topBias - b.topBias;
            })[0]?.element;

        if (closeTarget) {
            const closeRect = closeTarget.getBoundingClientRect();
            return {
                panelRect: rectToObject(dialogRect),
                closeRect: rectToObject(closeRect),
            };
        }

        return {
            panelRect: rectToObject(dialogRect),
            closeRect: {
                left: Math.max(0, dialogRect.right - 30),
                top: Math.max(0, dialogRect.top),
                right: Math.max(0, dialogRect.right),
                bottom: Math.max(0, dialogRect.top + 30),
                width: 30,
                height: 30,
            },
        };
    }).catch(() => false);

    if (!panel?.panelRect) {
        return false;
    }

    const closeRect = panel.closeRect || panel.panelRect;
    await page.mouse.click(
        closeRect.left + Math.max(6, closeRect.width / 2),
        closeRect.top + Math.max(6, closeRect.height / 2),
    ).catch(() => null);
    await wait(450);

    const stillOpen = await page.evaluate(() => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = element => {
            if (!element || !(element instanceof Element)) {
                return false;
            }

            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };

        return Array.from(document.querySelectorAll('[role="dialog"], [aria-label*="Messages" i], aside, section, div'))
            .filter(isVisible)
            .map(element => ({ text: normalize(element.textContent), rect: element.getBoundingClientRect() }))
            .some(candidate => (
                (/messages/i.test(candidate.text) && /no messages found|new message|search|your messages/i.test(candidate.text))
                && !/comments|add a comment|comment as/i.test(candidate.text)
                && candidate.rect.width >= 160
                && candidate.rect.width <= 560
                && candidate.rect.height >= 140
                && candidate.rect.height <= window.innerHeight
            ));
    }).catch(() => false);

    if (stillOpen) {
        await page.keyboard.press('Escape').catch(() => null);
        await wait(450);
    }

    return true;
};

const clickLocatorCenter = async locator => {
    await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => null);

    const box = await locator.boundingBox().catch(() => null);
    if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
    }

    await locator.click({ timeout: 3000, force: true });
    return true;
};

const clickTabletLoginButton = async () => {
    const target = await page.evaluate(() => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const parseRgb = value => {
            const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
            return match ? match.slice(1, 4).map(Number) : null;
        };
        const isBlueText = element => {
            const rgb = parseRgb(window.getComputedStyle(element).color);
            return Boolean(rgb && rgb[2] > rgb[0] + 40 && rgb[1] > rgb[0] + 20);
        };
        const isVisible = element => {
            if (!element || !(element instanceof Element)) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const rectToObject = rect => ({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        });

        const pageText = normalize(document.body?.textContent);
        if (!pageText.includes('get the full experience with the tablet app') && !pageText.includes('log in or sign up')) {
            return null;
        }

        const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], span'))
            .filter(isVisible)
            .map(element => {
                const rect = element.getBoundingClientRect();
                const text = normalize([
                    element.getAttribute('aria-label'),
                    element.getAttribute('title'),
                    element.textContent,
                ].filter(Boolean).join(' '));
                const clickable = element.closest('button, [role="button"], a, [role="link"]') || element;
                const clickableRect = clickable.getBoundingClientRect();
                return {
                    element,
                    clickable,
                    text,
                    tag: element.tagName.toLowerCase(),
                    clickableTag: clickable.tagName.toLowerCase(),
                    blue: isBlueText(element) || isBlueText(clickable),
                    rect,
                    clickableRect,
                };
            })
            .filter(candidate => candidate.text === 'log in' || candidate.text === 'login')
            .sort((a, b) => {
                const score = candidate => (
                    (candidate.text === 'log in' ? 0 : 25)
                    + (candidate.blue ? -100 : 0)
                    + (candidate.clickableTag === 'button' ? -50 : 0)
                    + (candidate.tag === 'button' ? -30 : 0)
                    + Math.min(candidate.rect.width * candidate.rect.height, 10000) / 100
                );
                return score(a) - score(b) || a.rect.top - b.rect.top || a.rect.left - b.rect.left;
            });

        const target = candidates[0];
        if (!target) {
            return null;
        }

        target.clickable.click();
        return {
            rect: rectToObject(target.rect),
            clickableRect: rectToObject(target.clickableRect),
            tag: target.tag,
            clickableTag: target.clickableTag,
        };
    }).catch(() => null);

    if (!target) {
        return false;
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    await wait(1200);
    if (await isLoginFormVisible()) {
        return true;
    }

    const rect = target.clickableRect || target.rect;
    if (rect) {
        await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2).catch(() => null);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
        await wait(1500);
        return await isLoginFormVisible();
    }

    return false;
};

const clickVisibleLoginText = async () => {
    const rect = await page.evaluate(() => {
        const isVisible = element => {
            if (!element || !(element instanceof Element)) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const parseRgb = value => {
            const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
            return match ? match.slice(1, 4).map(Number) : null;
        };
        const isBlueText = element => {
            const rgb = parseRgb(window.getComputedStyle(element).color);
            return Boolean(rgb && rgb[2] > rgb[0] + 40 && rgb[1] > rgb[0] + 20);
        };
        const rectToObject = sourceRect => ({
            left: sourceRect.left,
            top: sourceRect.top,
            width: sourceRect.width,
            height: sourceRect.height,
        });

        const textCandidates = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const text = node.nodeValue || '';
            const match = text.match(/\blog\s*in\b/i);
            const parent = node.parentElement;
            if (!match || !parent || !isVisible(parent)) {
                continue;
            }

            const normalizedParentText = normalize(parent.textContent).toLowerCase();
            if (normalizedParentText.includes('open instagram')) {
                continue;
            }

            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const rangeRect = range.getBoundingClientRect();
            if (rangeRect.width <= 0 || rangeRect.height <= 0) {
                continue;
            }

            const clickable = parent.closest('a, button, [role="button"], [role="link"], [tabindex]') || parent;
            const clickableRect = clickable.getBoundingClientRect();
            textCandidates.push({
                rect: rectToObject(rangeRect),
                clickableRect: rectToObject(clickableRect),
                exact: normalize(match[0]).toLowerCase() === 'log in',
                blue: isBlueText(parent) || isBlueText(clickable),
                role: String(clickable.getAttribute('role') || '').toLowerCase(),
                tag: clickable.tagName.toLowerCase(),
                area: rangeRect.width * rangeRect.height,
                top: rangeRect.top,
                left: rangeRect.left,
            });
        }

        const elementCandidates = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [tabindex]'))
            .filter(isVisible)
            .map(element => {
                const text = normalize([
                    element.getAttribute('aria-label'),
                    element.getAttribute('title'),
                    element.textContent,
                ].filter(Boolean).join(' '));
                const rect = element.getBoundingClientRect();
                return {
                    rect: rectToObject(rect),
                    clickableRect: rectToObject(rect),
                    exact: /^log\s*in$/i.test(text),
                    blue: isBlueText(element),
                    role: String(element.getAttribute('role') || '').toLowerCase(),
                    tag: element.tagName.toLowerCase(),
                    area: rect.width * rect.height,
                    top: rect.top,
                    left: rect.left,
                    text: text.toLowerCase(),
                };
            })
            .filter(candidate => (
                candidate.exact
                || candidate.text === 'login'
                || /log\s*in\s*or\s*sign\s*up/i.test(candidate.text)
            ) && !candidate.text.includes('open instagram'));

        const candidates = [...textCandidates, ...elementCandidates]
            .filter(candidate => candidate.rect.width > 0 && candidate.rect.height > 0)
            .sort((a, b) => {
                const score = candidate => (
                    (candidate.exact ? 0 : 80)
                    + (candidate.blue ? -30 : 0)
                    + (candidate.tag === 'a' || candidate.role === 'link' ? -15 : 0)
                    + Math.min(candidate.area, 10000) / 100
                );
                const scoreDiff = score(a) - score(b);
                if (scoreDiff) {
                    return scoreDiff;
                }
                return a.top - b.top || a.left - b.left;
            });

        return candidates[0]?.rect || null;
    }).catch(() => null);

    if (!rect) {
        return false;
    }

    await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    await wait(1500);
    return true;
};

const clickLoginEntryPoint = async () => {
    if (await isLoginFormVisible()) {
        return false;
    }

    if (await clickTabletLoginButton()) {
        return true;
    }

    if (await clickVisibleLoginText()) {
        return true;
    }

    const candidates = [
        page.getByRole('link', { name: /^log in$/i }).first(),
        page.getByRole('link', { name: /log in/i }).first(),
        page.getByRole('button', { name: /^log in$/i }).first(),
        page.getByRole('button', { name: /log in/i }).first(),
        page.getByText(/^log in$/i).first(),
        page.getByText(/log in/i).first(),
        page.locator('button').filter({ hasText: /^log in$/i }).first(),
        page.locator('div[role="button"]').filter({ hasText: /^log in$/i }).first(),
        page.locator('[role="link"]').filter({ hasText: /log in/i }).first(),
        page.locator('[tabindex]').filter({ hasText: /^log in$/i }).first(),
        page.locator('a').filter({ hasText: /log in or sign up/i }).first(),
        page.locator('a').filter({ hasText: /^log in$/i }).first(),
        page.getByRole('link', { name: /log in or sign up/i }).first(),
        page.getByRole('button', { name: /log in or sign up/i }).first(),
        page.getByRole('link', { name: /^log in$/i }).first(),
    ];

    for (const candidate of candidates) {
        if (await isLoginFormVisible()) {
            return false;
        }

        if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) {
            if (!await candidate.isEnabled({ timeout: 1000 }).catch(() => true)) {
                continue;
            }

            const clicked = await clickLocatorCenter(candidate).catch(error => {
                console.log(`Login entry click retry needed: ${error.message}`);
                return false;
            });
            if (!clicked && !await clickVisibleLoginText()) {
                continue;
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
            await wait(1500);
            return true;
        }
    }

    if (await clickVisibleLoginText()) {
        return true;
    }

    const clickedByDom = await page.evaluate(() => {
        const isVisible = element => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };

        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const candidates = Array.from(document.querySelectorAll('button, a, span, [role="link"], [tabindex], div[role="button"]'))
            .filter(isVisible)
            .filter(element => {
                const text = normalize(element.textContent);
                return text === 'log in'
                    || text === 'login'
                    || text === 'log in or sign up';
            })
            .filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true')
            .map(element => {
                const rect = element.getBoundingClientRect();
                return {
                    element,
                    area: rect.width * rect.height,
                    top: rect.top,
                    left: rect.left,
                };
            })
            .sort((a, b) => {
                if (a.area !== b.area) {
                    return a.area - b.area;
                }

                return a.top - b.top || a.left - b.left;
            });

        const target = candidates[0]?.element;
        if (!target) {
            return false;
        }

        target.click();
        return true;
    }).catch(() => false);

    if (clickedByDom) {
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
        await wait(1500);
    }

    return clickedByDom;
};

const ensureLoginFormReady = async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        await dismissInstagramDialogs();
        await throwIfInstagramBlocked('login form');

        if (await isLoginFormVisible()) {
            return;
        }

        const clicked = await clickLoginEntryPoint();
        if (!clicked && !/\/accounts\/login/i.test(page.url())) {
            await page.goto(INSTAGRAM_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await wait(1500);
        }

        if (await isLoginFormVisible()) {
            return;
        }
    }

    throw new Error('Instagram login form did not appear. The page may be showing an unsupported login prompt.');
};

const getVisibleInputDetails = async () => {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('input'))
            .filter(input => {
                const rect = input.getBoundingClientRect();
                const style = window.getComputedStyle(input);
                return rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            })
            .map(input => ({
                type: input.getAttribute('type') || '',
                name: input.getAttribute('name') || '',
                placeholder: input.getAttribute('placeholder') || '',
                ariaLabel: input.getAttribute('aria-label') || '',
                autocomplete: input.getAttribute('autocomplete') || '',
            }));
    }).catch(() => []);
};

const clickEnabledLoginSubmit = async passwordInput => {
    const submitCandidates = [
        page.locator('button[type="submit"]').first(),
        page.getByRole('button', { name: /^log in$/i }).first(),
        page.locator('div[role="button"]').filter({ hasText: /^log in$/i }).first(),
    ];

    for (let attempt = 0; attempt < 20; attempt += 1) {
        for (const candidate of submitCandidates) {
            const visible = await candidate.isVisible({ timeout: 500 }).catch(() => false);
            const enabled = visible && await candidate.isEnabled({ timeout: 500 }).catch(() => false);

            if (enabled) {
                const clicked = await candidate.click({ timeout: 3000 }).then(() => true).catch(error => {
                    console.log(`Login submit click retry needed: ${error.message}`);
                    return false;
                });
                if (clicked) {
                    return;
                }
            }
        }

        await wait(500);
    }

    await passwordInput.press('Enter');
};


const fillAndSubmitLoginForm = async ({ accountName, password }) => {
    let lastError = null;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        const { usernameInput, passwordInput } = await getLoginInputs();

        if (!usernameInput || !passwordInput) {
            const visibleInputs = await getVisibleInputDetails();
            lastError = new Error(`Could not find visible Instagram username/password inputs. Visible inputs: ${JSON.stringify(visibleInputs)}`);
            await wait(1200);
            continue;
        }

        try {
            await usernameInput.fill(accountName, { timeout: 7000 });
            await wait(400);
            await passwordInput.fill(password, { timeout: 7000 });
            await wait(700);
            await clickEnabledLoginSubmit(passwordInput);
            return;
        } catch (error) {
            lastError = error;
            console.log(`Login form fill attempt ${attempt} failed for ${accountName}: ${error.message}`);
            await wait(1200);
        }
    }

    throw lastError || new Error('Could not fill Instagram login form.');
};

const saveSession = async sessionFile => {
    const sessionData = await context.storageState();
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
};

const getSessionFileForAccountKey = accountKey => {
    if (!accountKey || accountKey === 'default') {
        return SESSION_FILE;
    }

    return path.join(SESSIONS_DIR, `${safeAccountName(accountKey)}.json`);
};

const startWithSavedSession = async sessionFile => {
    const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    await launchBrowser(sessionData);
    await page.goto(INSTAGRAM_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissInstagramDialogs();

    if (!await isLoggedIn()) {
        return false;
    }

    return true;
};

const loginAndSaveSession = async ({ accountName, password, sessionFile }) => {
    await launchBrowser();
    await page.goto(INSTAGRAM_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    try {
        await ensureLoginFormReady();
        await fillAndSubmitLoginForm({ accountName, password });
    } catch (error) {
        if (error?.manualVerification) {
            throw error;
        }

        const task = await markCurrentTaskPaused({
            phase: 'login-needed',
            message: `Manual Instagram login required for "${accountName}". Automatic login could not finish: ${error.message}`,
            loginRequired: true,
            stage: 'login',
        });
        throw createManualVerificationError({ stage: 'login', blocker: task.error, task });
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
    await wait(8000);
    await dismissInstagramDialogs();

    const blocker = await getInstagramBlocker();
    if (blocker) {
        const task = await markCurrentTaskPaused({
            phase: 'manual-verification',
            blocker,
            stage: 'login',
        });
        throw createManualVerificationError({ stage: 'login', blocker, task });
    }

    if (!await isLoggedIn()) {
        const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        const loginError = bodyText
            .split('\n')
            .find(line => /incorrect|wrong|couldn'?t|try again|problem/i.test(line));
        const task = await markCurrentTaskPaused({
            phase: 'login-needed',
            message: loginError || 'Automatic login did not complete. Complete login manually in the visible Instagram browser, then save the session.',
            loginRequired: true,
            stage: 'login',
        });
        throw createManualVerificationError({ stage: 'login', blocker: task.error, task });
    }

    await saveSession(sessionFile);
};

const markLoginReady = async (session, stage = 'login') => {
    currentAccountKey = session.accountKey;
    session.manualVerification = null;
    session.manualVerificationResolvedAt = null;
    const task = ensureCurrentTask();
    task.phase = 'ready';
    task.error = null;
    task.verificationRequired = false;
    task.loginRequired = false;
    task.verificationStage = null;
    task.verificationBlocker = null;
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'ready', { status: 'running', message: `${stage} completed` });
};

const loginCurrentBrowserAndSaveSession = async ({ session, password, stage = 'login recovery', targetUrl = null }) => {
    if (!password) {
        const task = await markCurrentTaskPaused({
            phase: 'login-needed',
            message: 'Instagram is asking this account to log in, but no account_password is available in this request.',
            loginRequired: true,
            stage,
            session,
        });
        throw createManualVerificationError({ stage, blocker: task.error, task });
    }

    if (!isPageOpen()) {
        await launchBrowser();
    }

    console.log(`Trying automatic Instagram login for ${session.accountName || session.accountKey} during ${stage}.`);
    await page.goto(INSTAGRAM_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);

    try {
        await ensureLoginFormReady();
        await fillAndSubmitLoginForm({ accountName: session.accountName || session.accountKey, password });
    } catch (error) {
        if (error?.manualVerification) {
            throw error;
        }
        const task = await markCurrentTaskPaused({
            phase: 'login-needed',
            message: `Manual Instagram login required for "${session.accountName || session.accountKey}". Automatic login could not finish: ${error.message}`,
            loginRequired: true,
            stage,
            session,
        });
        throw createManualVerificationError({ stage, blocker: task.error, task });
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
    await wait(8000);
    await dismissInstagramDialogs();

    const blocker = await getInstagramBlocker();
    if (blocker) {
        const task = await markCurrentTaskPaused({
            phase: 'manual-verification',
            blocker,
            stage,
            session,
        });
        throw createManualVerificationError({ stage, blocker, task });
    }

    if (!await isLoggedIn()) {
        const task = await markCurrentTaskPaused({
            phase: 'login-needed',
            message: 'Instagram is still not logged in. Complete login manually in the visible browser, then the controller will continue.',
            loginRequired: true,
            stage,
            session,
        });
        throw createManualVerificationError({ stage, blocker: task.error, task });
    }

    const sessionFile = getSessionFileForAccountKey(session.accountKey);
    await saveSession(sessionFile);
    await markLoginReady(session, stage);
    await hideBrowserWindow();

    if (targetUrl) {
        console.log(`Returning ${session.accountName || session.accountKey} to target after login: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await wait(6500);
        await dismissInstagramDialogs();
        await throwIfInstagramBlocked(`${stage} target reload`);
    }

    return true;
};

const throwIfInstagramLoginRequired = async (stage, { session = null, payload = null, targetUrl = null, allowAutoLogin = true } = {}) => {
    const activeSession = session || getActiveBrowserSession();
    const loginGate = await getInstagramLoginGate();
    if (!loginGate) {
        return false;
    }

    const password = getSessionAccountPassword(activeSession, payload || {});
    const finalTargetUrl = targetUrl || getTaskTargetUrl(getActiveTask());
    if (allowAutoLogin && password) {
        await loginCurrentBrowserAndSaveSession({
            session: activeSession,
            password,
            stage,
            targetUrl: finalTargetUrl,
        });
        return true;
    }

    const task = await markCurrentTaskPaused({
        phase: 'login-needed',
        message: `${loginGate} Complete login in the visible browser, then the controller will save and continue.`,
        loginRequired: true,
        stage,
        payload,
        session: activeSession,
    });
    throw createManualVerificationError({ stage, blocker: task.error, task });
};

const findVisibleCommentComposer = async () => {
    return page.evaluate(selectors => {
        const isVisible = element => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const uniqueElements = elements => elements.filter((element, index, all) => all.indexOf(element) === index);
        const getContextText = element => {
            const pieces = [];
            let current = element;
            for (let depth = 0; current && depth < 5; depth += 1) {
                pieces.push(
                    current.getAttribute?.('placeholder'),
                    current.getAttribute?.('aria-label'),
                    current.getAttribute?.('aria-placeholder'),
                    current.getAttribute?.('role'),
                    depth <= 2 ? current.textContent : '',
                );
                current = current.parentElement;
            }
            return normalize(pieces.filter(Boolean).join(' '));
        };
        const getElementText = element => normalize([
            element.getAttribute?.('placeholder'),
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('aria-placeholder'),
            element.getAttribute?.('role'),
            element.textContent,
        ].filter(Boolean).join(' '));
        const isEditable = element => element.matches?.('input, textarea, [contenteditable="true"], div[role="textbox"]');
        const isCommentCandidate = element => {
            if (!isVisible(element) || !isEditable(element)) {
                return false;
            }

            const directText = getElementText(element);
            const contextText = getContextText(element);
            const hasCommentLabel = /comment|reply/i.test(directText);
            const hasCommentContext = /add a comment|comment as|comments|post/i.test(contextText);
            const messageOnlyContext = /new message|your messages|send message to start a chat|\bto:\s*search/i.test(contextText)
                && !/comment/i.test(contextText);

            if (/search|recipient|\bto:\s*search/i.test(directText) && !hasCommentLabel) {
                return false;
            }
            if (messageOnlyContext) {
                return false;
            }

            return hasCommentLabel
                || hasCommentContext
                || (element.matches('[contenteditable="true"], div[role="textbox"]') && Boolean(element.closest('form')));
        };
        const scoreCandidate = element => {
            const rect = element.getBoundingClientRect();
            const directText = getElementText(element);
            const contextText = getContextText(element);
            let score = 0;

            if (document.activeElement === element) {
                score -= 1000;
            }
            if (/add a comment|comment/i.test(directText)) {
                score -= 700;
            }
            if (/add a comment|comment as/i.test(contextText)) {
                score -= 450;
            }
            if (element.closest('form')) {
                score -= 250;
            }
            if (element.closest('[role="dialog"]')) {
                score -= 160;
            }
            if (element.closest('article, main')) {
                score -= 90;
            }
            if (rect.top > window.innerHeight * 0.45) {
                score -= 40;
            }
            if (/search|new message|your messages|send message/i.test(contextText) && !/comment/i.test(directText)) {
                score += 1200;
            }

            return score;
        };

        const toResult = (target, source) => {
            const rect = target.getBoundingClientRect();
            return {
                tag: target.tagName,
                source,
                placeholder: target.getAttribute('placeholder') || '',
                ariaLabel: target.getAttribute('aria-label') || '',
                role: target.getAttribute('role') || '',
                value: target.value || target.innerText || target.textContent || '',
                rect: {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                },
            };
        };

        const candidates = uniqueElements(selectors
            .flatMap(selector => Array.from(document.querySelectorAll(selector))))
            .filter(isCommentCandidate)
            .map(element => ({ element, score: scoreCandidate(element), rect: element.getBoundingClientRect() }))
            .sort((a, b) => a.score - b.score || b.rect.top - a.rect.top);

        const target = candidates[0]?.element;
        if (target) {
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
            return toResult(target, 'input');
        }

        const placeholder = Array.from(document.querySelectorAll('input, textarea, span, div'))
            .filter(isVisible)
            .map(element => ({
                element,
                text: normalize(element.getAttribute('placeholder') || element.getAttribute('aria-label') || element.textContent),
                rect: element.getBoundingClientRect(),
            }))
            .filter(candidate => /add a comment/i.test(candidate.text))
            .filter(candidate => candidate.rect.width >= 20 && candidate.rect.height <= 90)
            .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height) || b.rect.top - a.rect.top)[0]?.element;

        if (placeholder) {
            return toResult(placeholder, 'placeholder');
        }

        const dialog = Array.from(document.querySelectorAll('[role="dialog"], div'))
            .filter(isVisible)
            .map(element => ({
                element,
                text: normalize(element.textContent),
                rect: element.getBoundingClientRect(),
            }))
            .filter(candidate => /comments/i.test(candidate.text)
                && !/new message|your messages|send message/i.test(candidate.text)
                && candidate.rect.width >= 250
                && candidate.rect.height >= 250)
            .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];

        if (!dialog) {
            return null;
        }

        return {
            tag: dialog.element.tagName,
            source: 'dialog-bottom',
            placeholder: 'Add a comment',
            ariaLabel: '',
            role: dialog.element.getAttribute('role') || '',
            value: '',
            rect: {
                left: dialog.rect.left + 52,
                top: dialog.rect.bottom - 56,
                width: Math.max(80, dialog.rect.width - 110),
                height: 44,
            },
        };
    }, COMMENT_COMPOSER_SELECTORS);
};

const clickCommentComposer = async () => {
    const composer = await findVisibleCommentComposer();

    if (composer) {
        const x = composer.source === 'input'
            ? composer.rect.left + composer.rect.width / 2
            : composer.rect.left + Math.min(52, Math.max(14, composer.rect.width * 0.22));
        const y = composer.rect.top + composer.rect.height / 2;
        await page.mouse.click(x, y);
        await wait(350);
        return await findVisibleCommentComposer().catch(() => null) || composer;
    }

    const placeholder = page.getByText(/add a comment/i).last();
    const placeholderVisible = await placeholder.isVisible({ timeout: 2000 }).catch(() => false);
    if (!placeholderVisible) {
        throw new Error('No visible comment input found after opening comments.');
    }

    const box = await placeholder.boundingBox();

    if (!box) {
        throw new Error('Add a comment placeholder is visible but has no clickable box.');
    }

    await page.mouse.click(box.x + Math.min(65, Math.max(14, box.width * 0.18)), box.y + box.height / 2);
    await wait(350);

    return await findVisibleCommentComposer().catch(() => null) || {
        tag: 'TEXT',
        placeholder: 'Add a comment',
        ariaLabel: '',
        role: '',
        value: '',
        rect: {
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
        },
    };
};

const waitForCommentComposer = async (timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    let fallbackComposer = null;
    let fallbackSeenAt = null;
    const fallbackDelayMs = Math.min(12000, Math.max(3000, Math.floor(timeoutMs * 0.35)));

    while (Date.now() < deadline) {
        const composer = await findVisibleCommentComposer();
        if (composer) {
            if (composer.source !== 'dialog-bottom') {
                return composer;
            }

            fallbackComposer = composer;
            fallbackSeenAt = fallbackSeenAt || Date.now();
            if (Date.now() - fallbackSeenAt >= fallbackDelayMs) {
                return fallbackComposer;
            }
        }

        await wait(500);
    }

    return fallbackSeenAt && Date.now() - fallbackSeenAt >= fallbackDelayMs
        ? fallbackComposer
        : null;
};

const openCommentComposer = async () => {
    await closeMessagesPanelIfOpen();

    const existingComposer = await waitForCommentComposer(1500);
    if (existingComposer) {
        return { alreadyOpen: true, composer: existingComposer };
    }

    let lastCommentButton = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const activeTask = getActiveTask();
        const isReelTask = String(activeTask?.contentKey || activeTask?.requestedContentKey || activeTask?.originalUrl || '').includes('reel');
        const commentButton = await findPostActionButton('Comment') || await clickCommentActionFallback();
        if (!commentButton) {
            throw new Error('Could not find the visible Comment action button for this post/reel.');
        }

        lastCommentButton = commentButton;
        console.log(`Clicking Comment action attempt ${attempt}: ${JSON.stringify(commentButton.clickRect)}`);

        if (attempt % 2 === 1) {
            const targetRect = commentButton.svgRect || commentButton.clickRect;
            await page.mouse.click(
                targetRect.left + targetRect.width / 2,
                targetRect.top + targetRect.height / 2,
            );
        } else {
            await page.mouse.click(
                commentButton.clickRect.left + commentButton.clickRect.width / 2,
                commentButton.clickRect.top + commentButton.clickRect.height / 2,
            );
        }

        await wait(2500);
        await dismissInstagramDialogs();
        const closedMessagesPanel = await closeMessagesPanelIfOpen();
        if (closedMessagesPanel) {
            console.log(`Closed Messages panel after Comment click attempt ${attempt}; retrying Comment instead of using that panel.`);
            continue;
        }

        const waitMs = isReelTask
            ? Math.max(COMMENT_COMPOSER_OPEN_WAIT_MS, 45000)
            : Math.max(COMMENT_COMPOSER_OPEN_WAIT_MS, 35000);
        const composer = await waitForCommentComposer(waitMs);
        if (composer) {
            return { alreadyOpen: false, composer, commentButton };
        }

        console.log(`Comment panel/input still not ready for ${activeTask?.accountName || activeTask?.accountKey || 'account'} after ${waitMs}ms on attempt ${attempt}.`);
    }

    throw new Error(`Comment panel/input did not appear after clicking Comment. Last button: ${JSON.stringify(lastCommentButton)}`);
};

const getVisibleCommentComposerValue = async () => {
    return page.evaluate(selectors => {
        const isVisible = element => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const getValue = element => element?.value || element?.innerText || element?.textContent || '';
        const getContextText = element => {
            const pieces = [];
            let current = element;
            for (let depth = 0; current && depth < 5; depth += 1) {
                pieces.push(
                    current.getAttribute?.('placeholder'),
                    current.getAttribute?.('aria-label'),
                    current.getAttribute?.('aria-placeholder'),
                    depth <= 2 ? current.textContent : '',
                );
                current = current.parentElement;
            }
            return normalize(pieces.filter(Boolean).join(' '));
        };
        const getElementText = element => normalize([
            element.getAttribute?.('placeholder'),
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('aria-placeholder'),
            element.textContent,
        ].filter(Boolean).join(' '));
        const isEditable = element => element?.matches?.('input, textarea, [contenteditable="true"], div[role="textbox"]');
        const isCommentCandidate = element => {
            if (!element || !isVisible(element) || !isEditable(element)) {
                return false;
            }

            const directText = getElementText(element);
            const contextText = getContextText(element);
            if (/search|recipient|\bto:\s*search/i.test(directText) && !/comment/i.test(directText)) {
                return false;
            }
            if (/new message|your messages|send message to start a chat|\bto:\s*search/i.test(contextText) && !/comment/i.test(contextText)) {
                return false;
            }

            return /comment|reply/i.test(directText)
                || /add a comment|comment as|comments|post/i.test(contextText)
                || (element.matches('[contenteditable="true"], div[role="textbox"]') && Boolean(element.closest('form')));
        };
        const uniqueElements = elements => elements.filter((element, index, all) => all.indexOf(element) === index);
        const active = document.activeElement;
        if (isCommentCandidate(active)) {
            return getValue(active);
        }

        const [target] = uniqueElements(selectors
            .flatMap(selector => Array.from(document.querySelectorAll(selector))))
            .filter(isCommentCandidate)
            .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

        return getValue(target);
    }, COMMENT_COMPOSER_SELECTORS);
};

const clearPageTextSelection = async () => {
    if (!isPageOpen()) {
        return;
    }

    await page.evaluate(() => {
        window.getSelection?.()?.removeAllRanges?.();
    }).catch(() => null);
};

const isActiveCommentComposer = async (referenceRect = null) => {
    if (!isPageOpen()) {
        return false;
    }

    return page.evaluate(({ selectors, referenceRect }) => {
        const isVisible = element => {
            if (!element || !(element instanceof Element)) {
                return false;
            }

            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const getContextText = element => {
            const pieces = [];
            let current = element;
            for (let depth = 0; current && depth < 5; depth += 1) {
                pieces.push(
                    current.getAttribute?.('placeholder'),
                    current.getAttribute?.('aria-label'),
                    current.getAttribute?.('aria-placeholder'),
                    depth <= 2 ? current.textContent : '',
                );
                current = current.parentElement;
            }
            return normalize(pieces.filter(Boolean).join(' '));
        };
        const getElementText = element => normalize([
            element.getAttribute?.('placeholder'),
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('aria-placeholder'),
            element.textContent,
        ].filter(Boolean).join(' '));
        const isEditable = element => element?.matches?.('input, textarea, [contenteditable="true"], div[role="textbox"]');
        const isNearReference = element => {
            if (!referenceRect) {
                return false;
            }

            const rect = element.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return centerX >= referenceRect.left - 80
                && centerX <= referenceRect.left + referenceRect.width + 80
                && centerY >= referenceRect.top - 80
                && centerY <= referenceRect.top + referenceRect.height + 80;
        };
        const isMessageOrSearchOnly = element => {
            const directText = getElementText(element);
            const contextText = getContextText(element);
            return (/search|recipient|\bto:\s*search/i.test(directText) && !/comment/i.test(directText))
                || (/new message|your messages|send message to start a chat|\bto:\s*search/i.test(contextText) && !/comment/i.test(contextText));
        };
        const isCommentCandidate = element => {
            if (!element || !isVisible(element) || !isEditable(element)) {
                return false;
            }

            const directText = getElementText(element);
            const contextText = getContextText(element);
            if (isMessageOrSearchOnly(element)) {
                return false;
            }

            return /comment|reply/i.test(directText)
                || /add a comment|comment as|comments|post/i.test(contextText)
                || (element.matches('[contenteditable="true"], div[role="textbox"]') && Boolean(element.closest('form')));
        };
        const isEditableNearComposer = element => Boolean(
            element
            && isVisible(element)
            && isEditable(element)
            && !isMessageOrSearchOnly(element)
            && isNearReference(element),
        );

        const active = document.activeElement;
        if (!isCommentCandidate(active) && !isEditableNearComposer(active)) {
            return false;
        }

        return selectors.some(selector => active.matches?.(selector))
            || Boolean(active.closest?.('form, [role="dialog"], article, main'));
    }, { selectors: COMMENT_COMPOSER_SELECTORS, referenceRect }).catch(() => false);
};

const setCommentComposerValue = async comment => {
    return page.evaluate(({ text, selectors }) => {
        const isVisible = element => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const getValue = element => element?.value || element?.innerText || element?.textContent || '';
        const sameText = value => normalize(value) === normalize(text);
        const getContextText = element => {
            const pieces = [];
            let current = element;
            for (let depth = 0; current && depth < 5; depth += 1) {
                pieces.push(
                    current.getAttribute?.('placeholder'),
                    current.getAttribute?.('aria-label'),
                    current.getAttribute?.('aria-placeholder'),
                    depth <= 2 ? current.textContent : '',
                );
                current = current.parentElement;
            }
            return normalize(pieces.filter(Boolean).join(' '));
        };
        const getElementText = element => normalize([
            element.getAttribute?.('placeholder'),
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('aria-placeholder'),
            element.textContent,
        ].filter(Boolean).join(' '));
        const isEditable = element => element?.matches?.('input, textarea, [contenteditable="true"], div[role="textbox"]');
        const isCommentCandidate = element => {
            if (!element || !isVisible(element) || !isEditable(element)) {
                return false;
            }

            const directText = getElementText(element);
            const contextText = getContextText(element);
            if (/search|recipient|\bto:\s*search/i.test(directText) && !/comment/i.test(directText)) {
                return false;
            }
            if (/new message|your messages|send message to start a chat|\bto:\s*search/i.test(contextText) && !/comment/i.test(contextText)) {
                return false;
            }

            return /comment|reply/i.test(directText)
                || /add a comment|comment as|comments|post/i.test(contextText)
                || (element.matches('[contenteditable="true"], div[role="textbox"]') && Boolean(element.closest('form')));
        };
        const uniqueElements = elements => elements.filter((element, index, all) => all.indexOf(element) === index);
        const active = document.activeElement;
        const activeTarget = isCommentCandidate(active)
            ? active
            : null;
        const [target] = uniqueElements(selectors
            .flatMap(selector => Array.from(document.querySelectorAll(selector))))
            .filter(isCommentCandidate)
            .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        const finalTarget = activeTarget || target;

        if (!finalTarget) {
            return null;
        }

        const dispatchChanges = () => {
            finalTarget.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            finalTarget.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const forceTextContent = () => {
            finalTarget.innerHTML = '';
            finalTarget.textContent = text;
        };

        finalTarget.focus();

        if (finalTarget instanceof HTMLInputElement || finalTarget instanceof HTMLTextAreaElement) {
            const prototype = finalTarget instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

            if (valueSetter) {
                valueSetter.call(finalTarget, text);
            } else {
                finalTarget.value = text;
            }
        } else {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(finalTarget);
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('delete', false);
            finalTarget.textContent = '';
            range.selectNodeContents(finalTarget);
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('insertText', false, text);

            if (!sameText(getValue(finalTarget))) {
                forceTextContent();
            }
            window.getSelection?.()?.removeAllRanges?.();
        }

        dispatchChanges();

        if (!sameText(getValue(finalTarget))) {
            if (finalTarget instanceof HTMLInputElement || finalTarget instanceof HTMLTextAreaElement) {
                finalTarget.value = text;
            } else {
                forceTextContent();
            }
            dispatchChanges();
        }

        const rect = finalTarget.getBoundingClientRect();
        return {
            value: getValue(finalTarget),
            exact: sameText(getValue(finalTarget)),
            rect: {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
            },
        };
    }, { text: comment, selectors: COMMENT_COMPOSER_SELECTORS });
};

const resetCommentComposerIfNotExact = async comment => {
    const value = await getVisibleCommentComposerValue();
    if (commentValueEquals(value, comment)) {
        return { exact: true, value };
    }

    if (normalizeCommentValue(value)) {
        console.log(`Comment composer value is not exact; resetting "${value}" to "${comment}".`);
    }

    const domFillResult = await setCommentComposerValue(comment);
    await wait(700);
    const finalValue = await getVisibleCommentComposerValue();
    return {
        exact: commentValueEquals(finalValue, comment),
        value: finalValue,
        rect: domFillResult?.rect || null,
        domFillResult,
    };
};

const fillVisibleCommentInput = async comment => {
    const inputs = page.locator(COMMENT_COMPOSER_SELECTOR);
    const count = await inputs.count().catch(() => 0);

    for (let index = count - 1; index >= 0; index -= 1) {
        const input = inputs.nth(index);
        if (!await input.isVisible({ timeout: 500 }).catch(() => false)) {
            continue;
        }

        const box = await input.boundingBox();
        if (!box) {
            continue;
        }

        await page.mouse.click(
            box.x + Math.min(24, Math.max(8, box.width * 0.12)),
            box.y + box.height / 2,
        );
        await wait(400);

        const domFillResult = await setCommentComposerValue(comment);
        await wait(700);
        let value = await getVisibleCommentComposerValue();
        console.log(`Visible comment input value after direct DOM fill: "${value}". DOM result: ${JSON.stringify(domFillResult)}`);

        if (commentValueEquals(value, comment)) {
            return domFillResult?.rect || {
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
            };
        }

        const activeComposer = await isActiveCommentComposer({
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
        });
        if (!activeComposer) {
            continue;
        }

        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText(comment);
        await wait(1000);

        value = await getVisibleCommentComposerValue();
        console.log(`Visible comment input value after direct fill: "${value}"`);

        if (commentValueEquals(value, comment)) {
            return {
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
            };
        }

        await input.fill(comment, { timeout: 2500 }).catch(() => null);
        await wait(700);

        value = await getVisibleCommentComposerValue();
        console.log(`Visible comment input value after locator fill: "${value}"`);

        if (commentValueEquals(value, comment)) {
            return {
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
            };
        }
    }

    return null;
};

const fillActiveCommentBox = async comment => {
    let lastValue = '';
    let lastComposer = null;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        const composer = await clickCommentComposer();
        lastComposer = composer;
        console.log(`Clicked comment composer attempt ${attempt}: ${JSON.stringify(composer)}`);
        await wait(900);

        await clearPageTextSelection();
        const domFillResult = await setCommentComposerValue(comment);
        await wait(1000);
        await clearPageTextSelection();
        lastValue = await getVisibleCommentComposerValue();
        console.log(`Visible comment box value after DOM fill attempt ${attempt}: "${lastValue}". DOM result: ${JSON.stringify(domFillResult)}`);

        if (commentValueEquals(lastValue, comment)) {
            return domFillResult?.rect || composer.rect;
        }

        const resetResult = await resetCommentComposerIfNotExact(comment);
        lastValue = resetResult.value || lastValue;
        if (resetResult.exact) {
            return resetResult.rect || domFillResult?.rect || composer.rect;
        }

        const activeComposer = await isActiveCommentComposer(composer?.rect || domFillResult?.rect || null);
        if (!activeComposer) {
            console.log(`Skipping keyboard fill attempt ${attempt}; active element is not a verified comment composer.`);
            continue;
        }

        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText(comment);
        await wait(1200);

        lastValue = await getVisibleCommentComposerValue();
        console.log(`Visible comment box value after keyboard attempt ${attempt}: "${lastValue}"`);

        if (commentValueEquals(lastValue, comment)) {
            await clearPageTextSelection();
            return composer.rect;
        }

        const finalResetResult = await resetCommentComposerIfNotExact(comment);
        lastValue = finalResetResult.value || lastValue;
        if (finalResetResult.exact) {
            await clearPageTextSelection();
            return finalResetResult.rect || composer.rect;
        }
    }

    throw new Error(`Comment text was not inserted. Visible value: "${lastValue}". Last composer: ${JSON.stringify(lastComposer)}`);
};

const getVisibleSubmittedCommentCount = async (comment, accountName = null) => {
    const activeTask = getActiveTask();
    const expectedAccount = normalizeAccountName(accountName || activeTask?.accountName || activeTask?.accountKey);

    return page.evaluate(({ expectedComment, expectedAccount }) => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const normalizeAccount = value => normalize(value).toLowerCase();
        const expected = normalize(expectedComment);
        if (!expected) {
            return 0;
        }

        const isVisible = element => {
            if (!element || !(element instanceof Element)) {
                return false;
            }

            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || 1) > 0.05;
        };
        const isEditorOrControl = element => Boolean(element.closest(
            'input, textarea, [contenteditable="true"], button, [role="button"], a',
        ));
        const hasExpectedAccountNearby = element => {
            if (!expectedAccount) {
                return true;
            }

            let current = element;
            for (let depth = 0; current && depth < 7; depth += 1) {
                if (normalizeAccount(current.textContent).includes(expectedAccount)) {
                    return true;
                }
                current = current.parentElement;
            }

            return false;
        };
        const exactVisibleLeaf = element => {
            if (!isVisible(element) || isEditorOrControl(element)) {
                return false;
            }

            const ownText = normalize(element.textContent);
            if (ownText !== expected) {
                return false;
            }

            return hasExpectedAccountNearby(element)
                && !Array.from(element.children || []).some(child => normalize(child.textContent) === expected);
        };

        return Array.from(document.querySelectorAll('span, div, p'))
            .filter(exactVisibleLeaf)
            .length;
    }, { expectedComment: comment, expectedAccount }).catch(() => 0);
};

const waitForSubmittedCommentVisible = async (comment, previousCount = 0, timeoutMs = 15000) => {
    const startedAt = Date.now();
    let lastCount = 0;

    while (Date.now() - startedAt < timeoutMs) {
        await wait(500);
        lastCount = await getVisibleSubmittedCommentCount(comment);
        if (lastCount > previousCount) {
            return {
                visible: true,
                previousCount,
                currentCount: lastCount,
            };
        }
    }

    throw new Error(`Comment was not verified in the visible thread after posting. Before: ${previousCount}. After: ${lastCount}.`);
};

const clickNearestCommentPostButton = async comment => {
    let lastResult = null;

    for (let attempt = 1; attempt <= 30; attempt += 1) {
        const closedMessagesPanel = await closeMessagesPanelIfOpen();
        if (closedMessagesPanel) {
            await wait(700);
        }

        const result = await page.evaluate(composerSelectors => {
            const isVisible = element => {
                if (!element || !(element instanceof Element)) {
                    return false;
                }

                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0
                    && rect.height > 0
                    && rect.bottom > 0
                    && rect.right > 0
                    && rect.top < window.innerHeight
                    && rect.left < window.innerWidth
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || 1) > 0.05;
            };

            const rectToObject = rect => ({
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
            });
            const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
            const getName = element => normalize([
                element.getAttribute('aria-label'),
                element.getAttribute('title'),
                element.textContent,
            ].filter(Boolean).join(' '));
            const getContextText = element => {
                const pieces = [];
                let current = element;
                for (let depth = 0; current && depth < 5; depth += 1) {
                    pieces.push(
                        current.getAttribute?.('placeholder'),
                        current.getAttribute?.('aria-label'),
                        current.getAttribute?.('aria-placeholder'),
                        current.getAttribute?.('role'),
                        depth <= 2 ? current.textContent : '',
                    );
                    current = current.parentElement;
                }
                return normalize(pieces.filter(Boolean).join(' '));
            };
            const getElementText = element => normalize([
                element.getAttribute?.('placeholder'),
                element.getAttribute?.('aria-label'),
                element.getAttribute?.('aria-placeholder'),
                element.getAttribute?.('role'),
                element.textContent,
            ].filter(Boolean).join(' '));
            const isEditable = element => element?.matches?.('input, textarea, [contenteditable="true"], div[role="textbox"]');
            const isCommentComposerCandidate = element => {
                if (!element || !isVisible(element) || !isEditable(element)) {
                    return false;
                }

                const directText = getElementText(element);
                const contextText = getContextText(element);
                const hasCommentLabel = /comment|reply/i.test(directText);
                const hasCommentContext = /add a comment|comment as|comments|post/i.test(contextText);
                const messageOnlyContext = /new message|your messages|send message to start a chat|\bto:\s*search/i.test(contextText)
                    && !/comment/i.test(contextText);

                if (/search|recipient|\bto:\s*search/i.test(directText) && !hasCommentLabel) {
                    return false;
                }
                if (messageOnlyContext) {
                    return false;
                }

                return hasCommentLabel
                    || hasCommentContext
                    || (element.matches('[contenteditable="true"], div[role="textbox"]') && Boolean(element.closest('form')));
            };
            const active = document.activeElement;
            const visibleComposers = composerSelectors
                .flatMap(selector => Array.from(document.querySelectorAll(selector)))
                .filter(isCommentComposerCandidate)
                .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
            const activeComposer = isCommentComposerCandidate(active)
                ? active
                : null;
            const composer = activeComposer || visibleComposers[0] || null;
            const composerRect = composer?.getBoundingClientRect() || null;
            const dialog = composer?.closest('[role="dialog"]') || null;

            const clickableFor = element => {
                let current = element;
                for (let depth = 0; current && depth < 6; depth += 1) {
                    if (current.matches?.('button, [role="button"], a')) {
                        return current;
                    }
                    current = current.parentElement;
                }
                return element;
            };

            const exactPostCandidate = element => {
                const name = getName(element);
                return /^post$/i.test(name)
                    || /^post$/i.test(normalize(element.textContent))
                    || /^post$/i.test(normalize(element.getAttribute('aria-label')))
                    || /^post$/i.test(normalize(element.getAttribute('title')));
            };

            const clickableCandidates = [
                ...Array.from(document.querySelectorAll('button, [role="button"], a, div[tabindex], span[tabindex]')),
                ...Array.from(document.querySelectorAll('span, div')).filter(exactPostCandidate).map(clickableFor),
            ]
                .map(clickableFor)
                .filter((element, index, all) => all.indexOf(element) === index)
                .filter(isVisible)
                .filter(element => exactPostCandidate(element) || exactPostCandidate(element.firstElementChild || element))
                .filter(element => element.getAttribute('aria-disabled') !== 'true')
                .filter(element => !element.disabled)
                .map(element => {
                    const rect = element.getBoundingClientRect();
                    const inDialog = dialog ? dialog.contains(element) : false;
                    const sameRow = composerRect
                        ? Math.abs((rect.top + rect.height / 2) - (composerRect.top + composerRect.height / 2)) < 90
                        : false;
                    const toRight = composerRect ? rect.left >= composerRect.left - 35 : false;
                    const distance = composerRect
                        ? Math.abs(rect.top - composerRect.top) + Math.abs(rect.left - composerRect.left)
                        : 0;
                    const score = distance
                        - (inDialog ? 1200 : 0)
                        - (sameRow ? 700 : 0)
                        - (toRight ? 300 : 0);

                    return {
                        element,
                        score,
                        rect,
                        name: getName(element),
                    };
                })
                .sort((a, b) => a.score - b.score);

            if (clickableCandidates.length) {
                const target = clickableCandidates[0];
                return {
                    ready: true,
                    strategy: 'button',
                    candidates: clickableCandidates.length,
                    name: target.name,
                    rect: rectToObject(target.rect),
                };
            }

            if (composerRect) {
                const composerCenterY = composerRect.top + composerRect.height / 2;
                const scope = dialog || composer.closest('form') || composer.closest('article, main') || document.body;
                const scopeRect = scope.getBoundingClientRect?.() || {
                    left: 0,
                    top: 0,
                    right: window.innerWidth,
                    bottom: window.innerHeight,
                    width: window.innerWidth,
                    height: window.innerHeight,
                };
                const submitCandidates = Array.from(scope.querySelectorAll('button, [role="button"], a, svg, div[tabindex], span[tabindex]'))
                    .map(clickableFor)
                    .filter((element, index, all) => all.indexOf(element) === index)
                    .filter(isVisible)
                    .filter(element => !element.contains(composer))
                    .filter(element => element.getAttribute('aria-disabled') !== 'true')
                    .filter(element => !element.disabled)
                    .map(element => {
                        const rect = element.getBoundingClientRect();
                        const name = getName(element);
                        const centerY = rect.top + rect.height / 2;
                        const centerX = rect.left + rect.width / 2;
                        const sameRow = Math.abs(centerY - composerCenterY) <= Math.max(36, composerRect.height * 0.85);
                        const nearComposerBottom = rect.top >= composerRect.top - 28
                            && rect.bottom <= composerRect.bottom + 42;
                        const toRight = centerX >= composerRect.left + composerRect.width * 0.55
                            || rect.left >= composerRect.right - 96;
                        const insideScope = centerX >= scopeRect.left - 4
                            && centerX <= scopeRect.right + 4
                            && centerY >= scopeRect.top - 4
                            && centerY <= scopeRect.bottom + 4;
                        const badName = /close|cancel|emoji|emoticon|like|unlike|comment|share|save|messages|more options/i.test(name);
                        const positiveName = /post|send|submit/i.test(name);
                        const area = rect.width * rect.height;
                        const score = (positiveName ? -1200 : 0)
                            - (sameRow ? 700 : 0)
                            - (nearComposerBottom ? 450 : 0)
                            - (toRight ? 350 : 0)
                            - rect.left
                            + Math.abs(centerY - composerCenterY) * 4
                            + Math.max(0, area - 2400) / 10;

                        return {
                            element,
                            rect,
                            name,
                            sameRow,
                            nearComposerBottom,
                            toRight,
                            insideScope,
                            badName,
                            score,
                        };
                    })
                    .filter(candidate => candidate.insideScope)
                    .filter(candidate => !candidate.badName)
                    .filter(candidate => candidate.toRight && (candidate.sameRow || candidate.nearComposerBottom))
                    .filter(candidate => candidate.rect.width <= 72 && candidate.rect.height <= 72)
                    .sort((a, b) => a.score - b.score);

                if (submitCandidates.length) {
                    const target = submitCandidates[0];
                    return {
                        ready: true,
                        strategy: 'composer-submit-icon',
                        candidates: submitCandidates.length,
                        name: target.name || 'composer submit icon',
                        rect: rectToObject(target.rect),
                    };
                }

                if (dialog) {
                    const dialogRect = dialog.getBoundingClientRect();
                    return {
                        ready: true,
                        strategy: 'composer-submit-coordinate',
                        candidates: 0,
                        name: 'composer submit coordinate',
                        rect: {
                            left: Math.min(dialogRect.right - 40, Math.max(composerRect.right - 42, composerRect.left + composerRect.width * 0.82)),
                            top: composerCenterY - 18,
                            width: 36,
                            height: 36,
                        },
                    };
                }
            }

            return { ready: false, reason: composerRect ? 'No visible Post button found near the comment composer.' : 'No visible Post button or composer found.' };
        }, COMMENT_COMPOSER_SELECTORS);
        lastResult = result;

        if (result.ready && result.rect) {
            const previousCommentCount = await getVisibleSubmittedCommentCount(comment);
            await page.mouse.click(
                result.rect.left + result.rect.width / 2,
                result.rect.top + result.rect.height / 2,
            );
            try {
                const verification = await waitForSubmittedCommentVisible(comment, previousCommentCount);
                return {
                    clicked: true,
                    candidates: result.candidates,
                    strategy: result.strategy,
                    name: result.name,
                    verification,
                };
            } catch (error) {
                lastResult = {
                    ...lastResult,
                    clickVerificationFailed: error.message,
                };
                await closeMessagesPanelIfOpen();
                await wait(500);
                continue;
            }
        }

        if (attempt === 10 || attempt === 20) {
            const previousCommentCount = await getVisibleSubmittedCommentCount(comment);
            await page.keyboard.press('Enter').catch(() => null);
            try {
                const verification = await waitForSubmittedCommentVisible(comment, previousCommentCount, 5000);
                return {
                    clicked: true,
                    candidates: 0,
                    strategy: 'keyboard-enter',
                    name: 'Enter',
                    verification,
                };
            } catch (error) {
                lastResult = {
                    ...lastResult,
                    keyboardEnterFailed: error.message,
                };
            }
        }

        await wait(500);
    }

    throw new Error(`No usable Post button found after typing comment. Last result: ${JSON.stringify(lastResult)}`);
};

const findPostActionButton = async label => {
    return page.evaluate(targetLabel => {
        const isVisible = element => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };

        const getClickable = element => element.closest('button, [role="button"], a') || element;
        const getLabel = element => String([
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.textContent,
        ].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
        const minIconSize = targetLabel === 'Comment' ? 12 : 20;
        const normalizedTargetLabel = String(targetLabel).toLowerCase();

        const candidates = Array.from(document.querySelectorAll('svg, button, [role="button"], a'))
            .filter(element => {
                const label = getLabel(element).toLowerCase();
                return label === normalizedTargetLabel;
            })
            .filter(isVisible)
            .map(element => {
                const svgRect = element.getBoundingClientRect();
                const clickable = getClickable(element);
                const clickRect = clickable.getBoundingClientRect();

                return {
                    label: targetLabel,
                    sourceLabel: getLabel(element),
                    sourceTag: element.tagName,
                    svgRect: {
                        left: svgRect.left,
                        top: svgRect.top,
                        width: svgRect.width,
                        height: svgRect.height,
                    },
                    svgWidth: svgRect.width,
                    svgHeight: svgRect.height,
                    clickRect: {
                        left: clickRect.left,
                        top: clickRect.top,
                        width: clickRect.width,
                        height: clickRect.height,
                    },
                    // Comment hearts are usually small; post/reel action icons are normal toolbar size.
                    isMainActionSize: svgRect.width >= minIconSize && svgRect.height >= minIconSize,
                };
            })
            .filter(candidate => candidate.isMainActionSize)
            .sort((a, b) => {
                const aCenter = a.clickRect.top + a.clickRect.height / 2;
                const bCenter = b.clickRect.top + b.clickRect.height / 2;
                const aDistanceFromViewportCenter = Math.abs(aCenter - window.innerHeight / 2);
                const bDistanceFromViewportCenter = Math.abs(bCenter - window.innerHeight / 2);

                if (aDistanceFromViewportCenter !== bDistanceFromViewportCenter) {
                    return aDistanceFromViewportCenter - bDistanceFromViewportCenter;
                }

                const aArea = a.clickRect.width * a.clickRect.height;
                const bArea = b.clickRect.width * b.clickRect.height;
                return bArea - aArea;
            });

        return candidates[0] || null;
    }, label);
};

const clickPostActionButton = async label => {
    const button = await findPostActionButton(label);
    if (!button) {
        return null;
    }

    await page.mouse.click(
        button.clickRect.left + button.clickRect.width / 2,
        button.clickRect.top + button.clickRect.height / 2,
    );

    return button;
};

const clickCommentActionFallback = async () => {
    const activeTask = getActiveTask();
    const isReelTask = String(activeTask?.contentKey || activeTask?.requestedContentKey || activeTask?.originalUrl || '').includes('reel');
    const referenceButton = await findPostActionButton('Unlike') || await findPostActionButton('Like');
    const referenceRect = referenceButton?.clickRect || activeTask?.likeButtonRect || activeTask?.lastActionButtonRect;
    if (!referenceRect) {
        return null;
    }

    if (isReelTask) {
        const nearbyCommentButton = await page.evaluate(referenceRect => {
            const isVisible = element => {
                if (!element || !(element instanceof Element)) {
                    return false;
                }

                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0
                    && rect.height > 0
                    && rect.bottom > 0
                    && rect.right > 0
                    && rect.top < window.innerHeight
                    && rect.left < window.innerWidth
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            };
            const rectToObject = rect => ({
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
            });
            const referenceCenterX = referenceRect.left + referenceRect.width / 2;
            const referenceCenterY = referenceRect.top + referenceRect.height / 2;
            const getClickable = svg => svg.closest('button, [role="button"], a') || svg;

            const candidates = Array.from(document.querySelectorAll('svg'))
                .filter(svg => String(svg.getAttribute('aria-label') || '').trim().toLowerCase() === 'comment')
                .filter(isVisible)
                .map(svg => {
                    const svgRect = svg.getBoundingClientRect();
                    const clickable = getClickable(svg);
                    const clickRect = clickable.getBoundingClientRect();
                    const centerX = clickRect.left + clickRect.width / 2;
                    const centerY = clickRect.top + clickRect.height / 2;

                    return {
                        label: 'Comment',
                        svgRect: rectToObject(svgRect),
                        clickRect: rectToObject(clickRect),
                        distance: Math.abs(centerX - referenceCenterX) + Math.abs(centerY - referenceCenterY),
                        sameRail: Math.abs(centerX - referenceCenterX) <= 95,
                        belowLike: centerY > referenceCenterY + 18,
                    };
                })
                .filter(candidate => candidate.sameRail && candidate.belowLike)
                .sort((a, b) => a.distance - b.distance);

            return candidates[0] || null;
        }, referenceRect);

        if (nearbyCommentButton) {
            return {
                ...nearbyCommentButton,
                fallbackMode: 'reel-comment-svg-under-like',
            };
        }
    }

    console.log(`No exact Comment button found near Like for ${activeTask?.accountName || activeTask?.accountKey || 'account'}; refusing to guess a coordinate that could open Messages.`);
    return null;
};

const getTaskTargetUrl = task => {
    return task?.originalUrl
        || task?.finalUrl
        || getInstagramUrlForContentKey(task?.contentKey || task?.requestedContentKey);
};

const getTaskActionDefaults = (task, overrides = {}) => {
    const url = overrides.url || getTaskTargetUrl(task) || null;
    const contentKey = overrides.contentKey
        || task?.contentKey
        || task?.requestedContentKey
        || getInstagramContentKey(url)
        || null;

    return {
        url,
        contentKey,
        rowNumber: overrides.rowNumber || task?.rowNumber || null,
        comment: overrides.comment || task?.comment || null,
    };
};

const ensureBrowserReadyForAction = async (session, payload = {}, defaults = {}, stage = 'action browser recovery') => {
    if (isPageOpen()) {
        return 'already-open';
    }

    const existingTask = getActiveTask();
    if (!existingTask || isFinalTask(existingTask)) {
        startCurrentTask(session.accountKey || 'default', session.accountName || session.accountKey || 'default');
    }

    const task = hydrateTaskFromPayload(session, payload, defaults);
    task.phase = 'recovering-browser';
    task.error = null;
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'recovering-browser', {
        status: 'running',
        message: 'Browser was closed before the action; reopening and continuing automatically.',
    });

    const targetUrl = getTaskTargetUrl(task) || defaults.url || getInstagramUrlFromPayload(payload) || null;
    const sessionFile = getSessionFileForAccountKey(session.accountKey);

    if (fs.existsSync(sessionFile)) {
        console.log(`Browser was closed for ${session.accountName}; reopening saved session before ${stage}.`);
        try {
            if (await startWithSavedSession(sessionFile)) {
                currentAccountKey = session.accountKey;
                task.phase = 'ready';
                task.error = null;
                task.updatedAt = new Date().toISOString();
                recordTaskEvent(task, 'ready', {
                    status: 'running',
                    message: `${stage} recovered with saved session`,
                });
                return 'saved-session';
            }
            console.log(`Saved session for ${session.accountName} opened but is not logged in during ${stage}.`);
        } catch (error) {
            if (error?.manualVerification) {
                throw error;
            }
            console.log(`Saved-session recovery failed for ${session.accountName}: ${error.message}`);
            await closeBrowser({ preserveTask: true });
        }
    }

    const password = getSessionAccountPassword(session, payload);
    if (password) {
        console.log(`Browser was closed for ${session.accountName}; recovering with account password before ${stage}.`);
        await loginCurrentBrowserAndSaveSession({
            session,
            password,
            stage,
            targetUrl,
        });
        return 'password';
    }

    if (!isPageOpen()) {
        await launchBrowser();
    }
    await page.goto(INSTAGRAM_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
        console.log(`Could not open Instagram login during ${stage}: ${error.message}`);
    });

    const pausedTask = await markCurrentTaskPaused({
        phase: 'login-needed',
        message: `Browser was closed before ${stage}, and no saved session or account_password is available for "${session.accountName || session.accountKey}". Complete login in the visible browser, then the controller will save and continue.`,
        loginRequired: true,
        payload,
        session,
        stage,
    });
    throw createManualVerificationError({ stage, blocker: pausedTask.error, task: pausedTask });
};

const ensureTaskTargetPage = async (task, stage = 'action') => {
    if (!task || !isPageOpen()) {
        return false;
    }

    const targetUrl = getTaskTargetUrl(task);
    const targetContentKey = task.contentKey || task.requestedContentKey || getInstagramContentKey(targetUrl);
    const currentUrl = page.url();
    const currentContentKey = getInstagramContentKey(currentUrl);
    const isWrongInstagramSurface = /\/direct\/|\/inbox\/|\/explore\/|\/accounts\//i.test(currentUrl);

    if (targetUrl && (isWrongInstagramSurface || (targetContentKey && currentContentKey && currentContentKey !== targetContentKey))) {
        console.log(`Returning ${task.accountName || task.accountKey} to target before ${stage}: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await wait(6500);
        await dismissInstagramDialogs();
        await throwIfInstagramBlocked(stage);
        task.finalUrl = page.url();
        task.contentKey = getInstagramContentKey(task.finalUrl) || targetContentKey || task.contentKey;
        task.redirected = didUrlRedirect(targetUrl, task.finalUrl);
        task.updatedAt = new Date().toISOString();
        return true;
    }

    return false;
};

const scrollBackToTargetContent = async targetContentKey => {
    return Boolean(targetContentKey || isPageOpen());
};

const browseAfterRedirectBeforeComment = async () => {
    const task = getActiveTask();
    if (!task?.redirected || task.redirectBrowsingDone || task.skip) {
        return false;
    }

    if (!isPageOpen()) {
        return false;
    }

    console.log('Redirect detected. Skipping browsing and keeping the exact target locked before commenting.');
    task.redirectBrowsingDone = true;
    task.phase = 'commenting';
    task.updatedAt = new Date().toISOString();
    return true;
};

const reloadTaskTargetPage = async (task, stage = 'comment retry') => {
    const targetUrl = getTaskTargetUrl(task);
    if (!targetUrl) {
        return false;
    }

    console.log(`Reloading target before ${stage}: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(7000);
    await dismissInstagramDialogs();
    await throwIfInstagramBlocked(stage);
    task.finalUrl = page.url();
    task.contentKey = getInstagramContentKey(task.finalUrl) || task.contentKey || task.requestedContentKey;
    task.redirected = didUrlRedirect(targetUrl, task.finalUrl);
    task.updatedAt = new Date().toISOString();
    return true;
};

const submitCommentForActiveTask = async (session, comment, stageLabel = 'comment') => {
    const task = ensureCurrentTask();
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            await ensureTaskTargetPage(task, `${stageLabel} attempt ${attempt}`);
            await wait(attempt === 1 ? 3000 : 4500);
            await dismissInstagramDialogs();
            await throwIfInstagramBlocked(stageLabel);
            await throwIfInstagramLoginRequired(`${stageLabel} login`, {
                session,
                targetUrl: getTaskTargetUrl(task),
            });
            await browseAfterRedirectBeforeComment();
            await closeMessagesPanelIfOpen();
            await ensureTaskTargetPage(task, `${stageLabel} attempt ${attempt} after dialog cleanup`);
            await throwIfInstagramLoginRequired(`${stageLabel} composer login`, {
                session,
                targetUrl: getTaskTargetUrl(task),
            });

            const openResult = await openCommentComposer();
            await throwIfInstagramLoginRequired(`${stageLabel} opened composer login`, {
                session,
                targetUrl: getTaskTargetUrl(task),
            });
            console.log(`${stageLabel} composer ready for ${session.accountName}. Attempt: ${attempt}. Already open: ${openResult.alreadyOpen}. Composer: ${JSON.stringify(openResult.composer)}`);

            const alreadyVisibleCount = await getVisibleSubmittedCommentCount(comment, session.accountName);
            if (alreadyVisibleCount > 0) {
                const verification = {
                    visible: true,
                    preExisting: true,
                    currentCount: alreadyVisibleCount,
                };
                task.commentVerification = verification;
                task.updatedAt = new Date().toISOString();
                console.log(`${stageLabel} already visible for ${session.accountName}; marking verified without duplicate post.`);
                return {
                    clicked: false,
                    candidates: 0,
                    strategy: 'already-visible',
                    name: 'existing comment',
                    verification,
                };
            }

            await fillActiveCommentBox(comment);
            console.log(`Filled ${stageLabel} box for ${session.accountName}.`);
            await wait(1000);
            const exactCommentBeforePost = await resetCommentComposerIfNotExact(comment);
            if (!exactCommentBeforePost.exact) {
                throw new Error(`Comment composer was not exact before posting. Expected "${comment}", saw "${exactCommentBeforePost.value}".`);
            }
            await closeMessagesPanelIfOpen();

            const postResult = await clickNearestCommentPostButton(comment);
            console.log(`${stageLabel} added by clicking Post for ${session.accountName}. Candidate buttons: ${postResult.candidates}. Strategy: ${postResult.strategy || 'button'}`);
            task.commentVerification = postResult.verification || null;
            task.updatedAt = new Date().toISOString();
            return postResult;
        } catch (error) {
            lastError = error;
            console.log(`${stageLabel} attempt ${attempt} failed for ${session.accountName}: ${error.message}`);
            if (attempt < 3) {
                await reloadTaskTargetPage(task, `${stageLabel} retry ${attempt + 1}`).catch(reloadError => {
                    console.log(`Could not reload target before retry: ${reloadError.message}`);
                });
            }
        }
    }

    throw lastError;
};

const performQueuedActionTask = async (session, queuedTask, comment) => {
    removeQueuedActionTask(session, queuedTask);

    const url = queuedTask.originalUrl || getInstagramUrlForContentKey(queuedTask.contentKey || queuedTask.requestedContentKey);
    const requestedContentKey = queuedTask.contentKey || queuedTask.requestedContentKey || getInstagramContentKey(url);
    const finalComment = String(comment || queuedTask.comment || '').trim();

    if (!url) {
        throw new Error(`Queued task for ${session.accountName} has no Instagram URL.`);
    }
    if (!finalComment) {
        throw new Error(`Queued task for ${session.accountName} has no comment text.`);
    }

    const completedBefore = getCompletedAction(session.accountKey, requestedContentKey);
    if (completedBefore) {
        return completedBefore;
    }

    const now = new Date().toISOString();
    setActiveTask({
        ...queuedTask,
        accountKey: session.accountKey,
        accountName: session.accountName || session.accountKey,
        originalUrl: url,
        requestedContentKey,
        contentKey: requestedContentKey,
        comment: finalComment,
        skip: false,
        redirected: false,
        redirectBrowsingDone: false,
        phase: 'navigating',
        startedAt: queuedTask.startedAt || now,
        updatedAt: now,
    });

    const task = ensureCurrentTask();
    upsertDashboardPost({
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        contentKey: task.contentKey,
        url,
        comment: finalComment,
        status: 'running',
        phase: 'navigating',
        startedAt: task.startedAt,
    });
    recordTaskEvent(task, 'navigating', { status: 'running' });

    console.log(`Processing queued target for ${session.accountName}: ${url}`);
    await dismissInstagramDialogs();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(8000);
    await dismissInstagramDialogs();
    await throwIfInstagramBlocked('queued navigation');
    await throwIfInstagramLoginRequired('queued navigation login', {
        session,
        targetUrl: url,
    });
    await wait(1000);

    const finalUrl = page.url();
    const finalContentKey = getInstagramContentKey(finalUrl) || requestedContentKey;
    task.finalUrl = finalUrl;
    task.contentKey = finalContentKey;
    task.redirected = didUrlRedirect(url, finalUrl);
    task.phase = 'loaded';
    task.updatedAt = new Date().toISOString();
    upsertDashboardPost({
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        contentKey: task.contentKey,
        url: task.originalUrl,
        comment: finalComment,
        status: 'running',
        phase: 'loaded',
        startedAt: task.startedAt,
    });
    recordTaskEvent(task, 'loaded', { status: 'running' });

    const completedAfterNavigation = getCompletedAction(task.accountKey, finalContentKey);
    if (completedAfterNavigation) {
        markCurrentTaskSkipped({
            contentKey: finalContentKey,
            originalUrl: url,
            finalUrl,
            completedAction: completedAfterNavigation,
        });
        return completedAfterNavigation;
    }

    console.log(`Liking queued target for ${session.accountName}...`);
    task.phase = 'liking';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'liking', { status: 'running' });
    await ensureTaskTargetPage(task, 'queued like');
    await wait(3000);
    await dismissInstagramDialogs();
    await throwIfInstagramBlocked('queued like');
    await throwIfInstagramLoginRequired('queued like login', {
        session,
        targetUrl: getTaskTargetUrl(task),
    });

    const existingUnlike = await findPostActionButton('Unlike');
    if (!existingUnlike) {
        const likeButton = await clickPostActionButton('Like');
        if (likeButton) {
            task.lastActionButtonRect = likeButton.clickRect;
            console.log(`Clicked queued Like button for ${session.accountName}: ${JSON.stringify(likeButton.clickRect)}`);
        } else {
            console.log(`Queued Like button not found for ${session.accountName}; trying double-click.`);
            const mediaBox = await page.locator('article, main').first().boundingBox();

            if (mediaBox) {
                await page.mouse.dblclick(mediaBox.x + mediaBox.width / 2, mediaBox.y + mediaBox.height / 2);
            } else {
                await page.click('body', { clickCount: 2 });
            }
        }

        await wait(2000);
        await dismissInstagramDialogs();
        await throwIfInstagramBlocked('queued like verification');
        const recoveredLoginAfterQueuedLike = await throwIfInstagramLoginRequired('queued like verification login', {
            session,
            targetUrl: getTaskTargetUrl(task),
        });
        if (recoveredLoginAfterQueuedLike && !await findPostActionButton('Unlike')) {
            console.log(`Retrying queued Like for ${session.accountName} after login recovery.`);
            const retryLikeButton = await clickPostActionButton('Like');
            if (retryLikeButton) {
                task.lastActionButtonRect = retryLikeButton.clickRect;
            } else {
                const mediaBox = await page.locator('article, main').first().boundingBox();
                if (mediaBox) {
                    await page.mouse.dblclick(mediaBox.x + mediaBox.width / 2, mediaBox.y + mediaBox.height / 2);
                } else {
                    await page.click('body', { clickCount: 2 });
                }
            }
            await wait(2000);
            await dismissInstagramDialogs();
            await throwIfInstagramBlocked('queued like retry verification');
        }
        const verifiedUnlike = await findPostActionButton('Unlike');
        if (!verifiedUnlike) {
            throw new Error('Clicked Like on queued task, but Instagram did not show an Unlike button afterward.');
        }
        task.likeButtonRect = verifiedUnlike.clickRect;
    } else {
        task.likeButtonRect = existingUnlike.clickRect;
    }

    task.phase = 'liked';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'liked', { status: 'running' });

    console.log(`Commenting queued target for ${session.accountName}: "${finalComment}"`);
    task.phase = 'commenting';
    task.comment = finalComment;
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'commenting', { status: 'running' });
    await submitCommentForActiveTask(session, finalComment, 'queued comment');
    const completedAction = await markCurrentTaskCompleted();
    await closeBrowserAfterCompletedTask(session, 'queued action completion');
    return completedAction;
};

const getTaskCompletionContentKeys = task => {
    return Array.from(new Set([
        task?.contentKey,
        task?.requestedContentKey,
        getInstagramContentKey(task?.finalUrl),
        getInstagramContentKey(task?.originalUrl),
    ].filter(Boolean)));
};

const getVerifiedCompletionForTask = (session, task) => {
    if (isTrustedCompletedAction(task?.completedAction)) {
        return task.completedAction;
    }

    for (const contentKey of getTaskCompletionContentKeys(task)) {
        const completedAction = getCompletedAction(session.accountKey, contentKey);
        if (completedAction) {
            return completedAction;
        }
    }

    return null;
};

const isResumableActionTask = task => Boolean(
    task
    && !task.completedAt
    && !task.skip
    && task.comment
    && (task.originalUrl || task.finalUrl || task.contentKey || task.requestedContentKey)
);

const completeManualVerificationIfReady = async (session, source = 'manual verification check') => {
    const task = getActiveTask();
    if (!task || !isManualVerificationTask(task) || !isPageOpen()) {
        return null;
    }

    await dismissInstagramDialogs();

    const blocker = await getInstagramBlocker();
    if (blocker) {
        if (task.phase !== 'manual-verification' || task.verificationBlocker !== blocker) {
            await markCurrentTaskPaused({
                phase: 'manual-verification',
                blocker,
                stage: source,
                session,
            });
        } else {
            await showBrowserWindow();
        }
        return null;
    }

    if (!await isLoggedIn()) {
        const message = 'Instagram is not logged in yet. Complete login in the visible browser, then the controller will save and continue.';
        if (task.phase !== 'login-needed' || task.error !== message) {
            await markCurrentTaskPaused({
                phase: 'login-needed',
                message,
                loginRequired: true,
                stage: source,
                session,
            });
        } else {
            await showBrowserWindow();
        }
        return null;
    }

    if (!session.manualVerificationResolvedAt) {
        session.manualVerificationResolvedAt = Date.now();
        task.phase = 'ready';
        task.error = null;
        task.verificationRequired = false;
        task.loginRequired = false;
        task.updatedAt = new Date().toISOString();
        recordTaskEvent(task, 'ready', {
            status: 'running',
            message: 'Login/verification completed. Resuming queued actions.',
        });
        await hideBrowserWindow();
    }

    const resumeWaitMs = MANUAL_VERIFICATION_RESUME_DELAY_MS - (Date.now() - session.manualVerificationResolvedAt);
    if (resumeWaitMs > 0) {
        await wait(resumeWaitMs);
    }

    const sessionFile = getSessionFileForAccountKey(session.accountKey);
    await saveSession(sessionFile);
    currentAccountKey = session.accountKey;
    session.manualVerification = null;

    task.phase = 'ready';
    task.error = null;
    task.verificationRequired = false;
    task.loginRequired = false;
    task.verificationStage = null;
    task.verificationBlocker = null;
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'ready', { status: 'running' });
    await hideBrowserWindow();

    let resumedAction = null;
    const resumableCurrentTask = AUTO_RESUME_AFTER_MANUAL_VERIFICATION && isResumableActionTask(task)
        ? task
        : null;
    const nextReadyQueuedTask = AUTO_RESUME_AFTER_MANUAL_VERIFICATION
        ? (session.queuedActionTasks || []).find(isResumableActionTask)
        : null;
    const taskToResume = resumableCurrentTask || nextReadyQueuedTask;
    if (taskToResume) {
        console.log(`Auto-resuming queued task for ${session.accountName || session.accountKey} after manual verification.`);
        resumedAction = await performQueuedActionTask(session, taskToResume, taskToResume.comment);
    }

    return {
        sessionFile,
        resumedAction,
    };
};

const waitForManualActionCompletion = async (session, actionTask, source = 'manual action wait') => {
    const startedAt = Date.now();
    let trackedTask = actionTask || getActiveTask();

    while (Date.now() - startedAt < MANUAL_ACTION_COMPLETION_WAIT_MS) {
        const completedBefore = getVerifiedCompletionForTask(session, trackedTask)
            || getVerifiedCompletionForTask(session, getActiveTask());
        if (completedBefore) {
            return completedBefore;
        }

        const result = await completeManualVerificationIfReady(session, source).catch(error => {
            if (error?.manualVerification) {
                return null;
            }
            throw error;
        });
        if (result?.resumedAction) {
            return result.resumedAction;
        }

        trackedTask = actionTask || getActiveTask();
        const completedAfter = getVerifiedCompletionForTask(session, trackedTask)
            || getVerifiedCompletionForTask(session, getActiveTask());
        if (completedAfter) {
            return completedAfter;
        }

        await wait(MANUAL_ACTION_COMPLETION_POLL_MS);
    }

    return null;
};

const startManualVerificationAutoChecks = () => {
    setInterval(() => {
        for (const session of browserSessions.values()) {
            if (
                session.manualVerificationAutoCheckInFlight
                || session.pendingOperations > 0
                || !session.currentTask
                || !isManualVerificationTask(session.currentTask)
                || !session.page
                || session.page.isClosed()
            ) {
                continue;
            }

            session.manualVerificationAutoCheckInFlight = true;
            runInBrowserSession(session, async () => {
                await completeManualVerificationIfReady(session, 'manual verification auto-check');
            }, 'manual-verification-check').catch(error => {
                if (!error?.manualVerification) {
                    console.log(`Manual verification auto-check failed for ${session.accountName || session.accountKey}: ${error.message}`);
                }
            }).finally(() => {
                session.manualVerificationAutoCheckInFlight = false;
            });
        }
    }, MANUAL_VERIFICATION_CHECK_MS);
};

const getActiveSessionsSummary = () => {
    return Array.from(browserSessions.values())
        .filter(session => session.currentTask || (session.page && !session.page.isClosed()))
        .map(session => ({
            account: session.accountName || session.accountKey,
            accountKey: session.accountKey,
            browserStarted: Boolean(session.page && !session.page.isClosed()),
            pendingOperations: session.pendingOperations || 0,
            queuedOperations: Math.max(0, (session.pendingOperations || 0) - (session.activeOperation ? 1 : 0)),
            activeOperation: session.activeOperation || session.currentTask?.phase || null,
            lastQueueUpdateAt: session.lastQueueUpdateAt || null,
            manualVerification: session.manualVerification || null,
            browserVisibleForManualVerification: Boolean(session.browserVisibleForManualVerification),
            url: session.page && !session.page.isClosed() ? session.page.url() : null,
            currentTask: session.currentTask
                ? {
                    contentKey: session.currentTask.contentKey || null,
                    requestedContentKey: session.currentTask.requestedContentKey || null,
                    finalContentKey: session.currentTask.finalContentKey || null,
                    originalUrl: session.currentTask.originalUrl || null,
                    finalUrl: session.currentTask.finalUrl || null,
                    phase: session.currentTask.phase || null,
                    skipped: Boolean(session.currentTask.skip),
                    redirected: Boolean(session.currentTask.redirected),
                    redirectBrowsingDone: Boolean(session.currentTask.redirectBrowsingDone),
                    verificationRequired: Boolean(session.currentTask.verificationRequired),
                    loginRequired: Boolean(session.currentTask.loginRequired),
                    verificationStage: session.currentTask.verificationStage || null,
                    verificationBlocker: session.currentTask.verificationBlocker || null,
                    error: session.currentTask.error || null,
                    startedAt: session.currentTask.startedAt || null,
                    completedAt: session.currentTask.completedAt || session.currentTask.completedAction?.completedAt || null,
                    updatedAt: session.currentTask.updatedAt || null,
                }
                : null,
        }));
};

const getActionHistorySummary = ({ accountKey, contentKey, limit = 120 } = {}) => {
    const normalizedAccountKey = normalizeAccountName(accountKey);
    const history = readActionHistory();
    const completedEvents = Object.values(history.completed).map(completed => ({
        id: `completed-${getHistoryKey(normalizeAccountName(completed.account), completed.contentKey)}`,
        time: completed.completedAt,
        account: completed.account || normalizeAccountName(completed.account) || 'default',
        accountKey: normalizeAccountName(completed.account) || 'default',
        action: 'done',
        status: 'done',
        contentKey: completed.contentKey || null,
        url: completed.finalUrl || completed.originalUrl || null,
        message: 'Like and comment completed',
        error: null,
    }));

    return [...history.events, ...completedEvents]
        .filter(event => !normalizedAccountKey || event.accountKey === normalizedAccountKey)
        .filter(event => !contentKey || event.contentKey === contentKey)
        .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
        .slice(0, Math.max(1, Number(limit) || 120));
};

app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});

app.get('/', (_req, res) => {
    res.redirect('/monitor');
});

app.get('/monitor', (_req, res) => {
    res.type('html').send(getMonitorHtml());
});

app.get('/health', (_req, res) => {
    const activeSessions = getActiveSessionsSummary();
    const activeTask = getActiveTask();
    res.json({
        success: true,
        defaultSessionFileExists: fs.existsSync(SESSION_FILE),
        actionHistoryFileExists: fs.existsSync(ACTION_HISTORY_FILE),
        savedAccounts: getSavedAccounts(),
        currentAccount: currentAccountKey || null,
        activeSessions,
        dashboardPosts: getDashboardPostsSummary(),
        currentTask: activeTask
            ? {
                account: activeTask.accountName || activeTask.accountKey,
                contentKey: activeTask.contentKey || null,
                phase: activeTask.phase || null,
                skipped: Boolean(activeTask.skip),
                redirected: Boolean(activeTask.redirected),
                redirectBrowsingDone: Boolean(activeTask.redirectBrowsingDone),
            }
            : null,
        browserStarted: activeSessions.some(session => session.browserStarted),
    });
});

app.get('/history', (req, res) => {
    res.json({
        success: true,
        events: getActionHistorySummary({
            accountKey: req.query.accountKey,
            contentKey: req.query.contentKey,
            limit: req.query.limit,
        }),
    });
});

app.get('/dashboard/posts', (_req, res) => {
    res.json({
        success: true,
        posts: getDashboardPostsSummary(),
    });
});

app.post('/dashboard/posts', (req, res) => {
    try {
        const payload = getPayload(req);
        const rows = getDashboardRowsFromPayload(payload);
        const posts = rows
            .map(row => getDashboardPostFromPayload(row, { source: 'sheet' }))
            .filter(Boolean);
        posts.forEach(rememberDashboardPost);
        const currentRow = getDashboardCurrentRowFromPayload(payload);
        const currentPost = currentRow
            ? getDashboardPostFromPayload(currentRow, { source: 'sheet' })
            : null;
        const storedPosts = replaceDashboardPosts(posts, {
            activePostKey: currentPost ? getDashboardPostKey(currentPost) : null,
        });
        const responseRows = currentRow ? [currentRow] : (rows.length ? rows : [{}]);
        res.json(responseRows.map(row => normalizeDashboardPassthroughRow(row, storedPosts.length)));
    } catch (error) {
        console.error('Dashboard posts error:', error.message);
        sendError(res, error);
    }
});

app.get('/monitor/stream/:accountKey', async (req, res) => {
    const accountKey = normalizeAccountName(req.params.accountKey);
    const session = browserSessions.get(accountKey);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    if (!session || !session.context || !session.page || session.page.isClosed()) {
        res.write('event: status\n');
        res.write('data: Browser closed\n\n');
        res.end();
        return;
    }

    let cdpSession = null;
    let closed = false;
    let lastFrameSentAt = 0;
    const streamFrameGapMs = MONITOR_STREAM_TARGET_FPS > 0 ? 1000 / MONITOR_STREAM_TARGET_FPS : 0;
    const heartbeat = setInterval(() => {
        if (!closed) {
            res.write(': heartbeat\n\n');
        }
    }, 15000);

    const cleanup = async () => {
        if (closed) {
            return;
        }
        closed = true;
        clearInterval(heartbeat);
        if (cdpSession) {
            await cdpSession.send('Page.stopScreencast').catch(() => null);
            await cdpSession.detach().catch(() => null);
        }
    };

    req.on('close', cleanup);

    try {
        cdpSession = await session.context.newCDPSession(session.page);
        await cdpSession.send('Page.enable');
        cdpSession.on('Page.screencastFrame', async frame => {
            try {
                if (!closed) {
                    const now = Date.now();
                    if (!streamFrameGapMs || now - lastFrameSentAt >= streamFrameGapMs) {
                        lastFrameSentAt = now;
                        res.write('event: frame\n');
                        res.write(`data: ${frame.data}\n\n`);
                    }
                }
            } finally {
                await cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => null);
            }
        });
        await cdpSession.send('Page.startScreencast', {
            format: 'jpeg',
            quality: MONITOR_STREAM_QUALITY,
            maxWidth: MONITOR_STREAM_MAX_WIDTH,
            maxHeight: MONITOR_STREAM_MAX_HEIGHT,
            everyNthFrame: 1,
        });
    } catch (error) {
        console.log(`Monitor live stream failed: ${error.message}`);
        if (!closed) {
            res.write('event: status\n');
            res.write(`data: ${String(error.message || error).replace(/\r?\n/g, ' ')}\n\n`);
            res.end();
        }
        await cleanup();
    }
});

app.post('/schedule/wait', async (req, res) => {
    try {
        const payload = getPayload(req);
        const schedule = await waitForSchedule(payload, 'scheduled row');
        res.json({ success: true, ...schedule });
    } catch (error) {
        console.error('Schedule wait error:', error.message);
        sendError(res, error);
    }
});

app.post('/browser/start', async (req, res) => {
    try {
        const payload = getPayload(req);
        const { accountKey, accountName, sessionFile } = getSessionForPayload(payload);
        const accountPassword = getAccountPassword(payload);

        const session = getBrowserSession(accountKey, accountName);
        rememberSessionCredentials(session, payload);
        await runInBrowserSession(session, async () => {
            console.log(`Starting browser for account: ${accountName}`);
            console.log(`Requested account_username: ${payload.account_username || payload.username || payload.account || '(default)'}`);

            if (isPageOpen()) {
                const activeTask = getActiveTask();
                if (isManualVerificationTask(activeTask)) {
                    const savedPassword = getSessionAccountPassword(session, payload);
                    if ((getManualActionPhase(activeTask) === 'login-needed') && savedPassword) {
                        await loginCurrentBrowserAndSaveSession({
                            session,
                            password: savedPassword,
                            stage: 'start login recovery',
                            targetUrl: getTaskTargetUrl(activeTask),
                        });
                        return res.json({ success: true, account: accountName, loginMethod: 'password-recovery', sessionSaved: true });
                    }

                    return sendManualVerificationResponse(res, 'start', activeTask, {
                        browserVisible: Boolean(session.browserVisibleForManualVerification || isPageOpen()),
                        verificationRequired: Boolean(activeTask?.verificationRequired),
                        loginRequired: Boolean(activeTask?.loginRequired),
                    });
                }

                if (!activeTask || activeTask.completedAt || activeTask.skip || activeTask.phase === 'error') {
                    startCurrentTask(accountKey, accountName);
                }
                return res.json({ success: true, alreadyStarted: true, account: accountName });
            }

            setActiveTask(null);
            startCurrentTask(accountKey, accountName);
            hydrateTaskFromPayload(session, payload);
            let loginMethod = 'saved-session';

            if (fs.existsSync(sessionFile)) {
                console.log(`Trying saved session for ${accountName}.`);
                try {
                    const task = ensureCurrentTask();
                    task.phase = 'validating-session';
                    task.error = null;
                    task.updatedAt = new Date().toISOString();
                    recordTaskEvent(task, 'validating-session', { status: 'running' });

                    if (await startWithSavedSession(sessionFile)) {
                        currentAccountKey = accountKey;
                        const readyTask = ensureCurrentTask();
                        readyTask.phase = 'ready';
                        readyTask.error = null;
                        readyTask.updatedAt = new Date().toISOString();
                        recordTaskEvent(readyTask, 'ready', { status: 'running' });
                        console.log(`Browser ready, saved session loaded for ${accountName}.`);
                        return res.json({ success: true, account: accountName, loginMethod });
                    }
                } catch (error) {
                    if (error?.manualVerification) {
                        return sendManualVerificationResponse(res, 'start', error, {
                            browserVisible: true,
                        });
                    }

                    console.log(`Saved session for ${accountName} could not be used: ${error.message}`);
                    await closeBrowser({ preserveTask: true });
                }
            }

            if (accountKey === 'default') {
                return sendError(res, new Error('Missing account_username. Automatic login needs account_username from the sheet.'), 400);
            }

            if (!accountPassword) {
                if (!isPageOpen()) {
                    await launchBrowser();
                    await page.goto(INSTAGRAM_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
                        console.log(`Could not open Instagram login for manual login: ${error.message}`);
                    });
                    await dismissInstagramDialogs();
                }
                const task = await markCurrentTaskPaused({
                    phase: 'login-needed',
                    message: `Missing account_password for "${accountName}". Send it in the HTTP Start Browser body from n8n, or save a session manually.`,
                    loginRequired: true,
                    payload,
                    session,
                });
                return sendManualVerificationResponse(res, 'start', task, {
                    loginRequired: true,
                    browserVisible: Boolean(isPageOpen()),
                    next: 'Send account_password from n8n or run a manual login/save-session for this account.',
                });
            }

            loginMethod = 'password';
            console.log(`No valid saved session for ${accountName}. Logging in with n8n credentials and saving fresh session.`);
            if (isPageOpen()) {
                await closeBrowser({ preserveTask: true });
            }
            const loginTask = ensureCurrentTask();
            loginTask.phase = 'login';
            loginTask.error = null;
            loginTask.updatedAt = new Date().toISOString();
            recordTaskEvent(loginTask, 'login', { status: 'running' });
            await loginAndSaveSession({ accountName, password: accountPassword, sessionFile });
            currentAccountKey = accountKey;
            const readyTask = ensureCurrentTask();
            readyTask.phase = 'ready';
            readyTask.error = null;
            readyTask.verificationRequired = false;
            readyTask.loginRequired = false;
            readyTask.updatedAt = new Date().toISOString();
            recordTaskEvent(readyTask, 'ready', { status: 'running' });

            console.log(`Browser ready, fresh session saved for ${accountName}.`);
            res.json({ success: true, account: accountName, loginMethod, sessionSaved: true });
        }, 'start');
    } catch (error) {
        console.error('Start error:', error.message);
        if (error?.manualVerification) {
            return sendManualVerificationResponse(res, 'start', error, {
                browserVisible: true,
            });
        }
        if (isPageOpen()) {
            await page.screenshot({ path: 'login-error.png' }).catch(() => null);
        }
        sendError(res, error);
    }
});

app.post('/browser/save-session', async (req, res) => {
    try {
        const payload = getPayload(req);
        const accountKey = normalizeAccountName(payload.account_username || payload.username || payload.account || currentAccountKey);
        if (!accountKey) {
            return sendError(res, new Error('Missing account_username and no current account is active.'), 400);
        }

        const session = getBrowserSession(accountKey, accountKey);
        await runInBrowserSession(session, async () => {
            requirePage();

            const blocker = await getInstagramBlocker();
            if (blocker) {
                const task = await markCurrentTaskPaused({
                    phase: 'manual-verification',
                    blocker,
                    stage: 'save-session',
                    session,
                });
                return sendManualVerificationResponse(res, 'save-session', task, {
                    browserVisible: true,
                    verificationRequired: true,
                    message: `Verification is still showing. Finish it manually first, then save again. ${blocker}`,
                });
            }

            if (!await isLoggedIn()) {
                const task = await markCurrentTaskPaused({
                    phase: 'login-needed',
                    message: 'Instagram is not logged in yet. Complete login in the visible browser, then save again.',
                    loginRequired: true,
                    session,
                });
                await showBrowserWindow();
                return sendManualVerificationResponse(res, 'save-session', task, {
                    browserVisible: true,
                    loginRequired: true,
                });
            }

            const sessionFile = getSessionFileForAccountKey(accountKey);
            await saveSession(sessionFile);
            currentAccountKey = accountKey;
            session.manualVerification = null;
            const task = getActiveTask();
            if (task && isManualVerificationTask(task)) {
                task.phase = 'ready';
                task.error = null;
                task.verificationRequired = false;
                task.loginRequired = false;
                task.updatedAt = new Date().toISOString();
                recordTaskEvent(task, 'ready', { status: 'running' });
            }
            await hideBrowserWindow();

            let resumedAction = null;
            const resumableCurrentTask = AUTO_RESUME_AFTER_MANUAL_VERIFICATION && isResumableActionTask(task)
                ? task
                : null;
            const nextReadyQueuedTask = AUTO_RESUME_AFTER_MANUAL_VERIFICATION
                ? (session.queuedActionTasks || []).find(isResumableActionTask)
                : null;
            const taskToResume = resumableCurrentTask || nextReadyQueuedTask;
            if (taskToResume) {
                console.log(`Resuming queued task for ${accountKey} after manual verification.`);
                resumedAction = await performQueuedActionTask(session, taskToResume, taskToResume.comment);
            }

            console.log(`Session saved manually for ${accountKey}: ${sessionFile}`);
            res.json({ success: true, account: accountKey, sessionSaved: true, sessionFile, resumedAction });
        }, 'save-session');
    } catch (error) {
        console.error('Save session error:', error.message);
        if (error?.manualVerification) {
            return sendManualVerificationResponse(res, 'save-session', error, {
                browserVisible: true,
            });
        }
        sendError(res, error);
    }
});

app.post('/browser/navigate', async (req, res) => {
    try {
        const payload = getPayload(req);
        const session = getSessionForRequestPayload(payload);
        rememberSessionCredentials(session, payload);
        await runInBrowserSession(session, async () => {
            const url = payload.url || payload.instagram_url || payload.post_url || payload.link;
            if (!url) {
                return sendError(res, new Error('Missing url. Send JSON like { "url": "https://www.instagram.com/p/..." } or { "instagram_url": "..." }.'), 400);
            }

            const requestedContentKey = getInstagramContentKey(url);
            const payloadTarget = getActionTargetFromPayload(payload);
            const rememberedPost = findRememberedDashboardPost({
                accountKey: session.accountKey,
                contentKey: requestedContentKey,
                rowNumber: payloadTarget.rowNumber,
                url,
            });
            const activeBeforeNavigation = getActiveTask();

            if (isManualVerificationTask(activeBeforeNavigation)) {
                const queuedTask = queueActionTask(session, payload, {
                    url,
                    contentKey: requestedContentKey,
                    comment: payloadTarget.comment || rememberedPost?.comment || null,
                });
                console.log(`Queued navigation for ${session.accountName} while waiting for manual verification.`);
                return res.json({
                    ...manualVerificationResponse('navigate', activeBeforeNavigation, {
                        browserVisible: Boolean(isPageOpen()),
                        verificationRequired: Boolean(activeBeforeNavigation?.verificationRequired),
                        loginRequired: Boolean(activeBeforeNavigation?.loginRequired),
                    }),
                    queued: true,
                    queuedContentKey: queuedTask.contentKey || queuedTask.requestedContentKey || null,
                    queuedRowNumber: queuedTask.rowNumber || null,
                });
            }

            requirePage();

            const alreadyCompletedBeforeNavigation = getCompletedAction(session.accountKey, requestedContentKey);
            if (alreadyCompletedBeforeNavigation) {
                const queuedTask = findQueuedActionTask(session, { contentKey: requestedContentKey, rowNumber: payloadTarget.rowNumber, url });
                if (queuedTask) {
                    removeQueuedActionTask(session, queuedTask);
                }
                console.log(`Skipping duplicate action before navigation: ${getHistoryKey(session.accountKey, requestedContentKey)}`);
                return res.json(completedActionResponse('navigate', alreadyCompletedBeforeNavigation, session.accountName));
            }

            if (activeBeforeNavigation
                && !isFinalTask(activeBeforeNavigation)
                && (activeBeforeNavigation.contentKey || activeBeforeNavigation.requestedContentKey || activeBeforeNavigation.originalUrl)
                && !sameTaskTarget(activeBeforeNavigation, { contentKey: requestedContentKey, rowNumber: payloadTarget.rowNumber, url })) {
                const queuedTask = queueActionTask(session, payload, {
                    url,
                    contentKey: requestedContentKey,
                    comment: payloadTarget.comment || rememberedPost?.comment || null,
                });
                console.log(`Queued ${session.accountName} target ${queuedTask.contentKey || queuedTask.originalUrl || queuedTask.rowNumber}; active target is ${activeBeforeNavigation.contentKey || activeBeforeNavigation.requestedContentKey || activeBeforeNavigation.originalUrl}.`);
                return res.json(queuedTaskResponse('navigate', queuedTask, activeBeforeNavigation));
            }

            if (!activeBeforeNavigation || isFinalTask(activeBeforeNavigation)) {
                startCurrentTask(session.accountKey, session.accountName);
            }

            const task = ensureCurrentTask();
            task.originalUrl = url;
            task.requestedContentKey = requestedContentKey;
            task.contentKey = requestedContentKey;
            task.rowNumber = payloadTarget.rowNumber || rememberedPost?.rowNumber || task.rowNumber || null;
            task.comment = payloadTarget.comment || rememberedPost?.comment || task.comment || null;
            task.finalUrl = null;
            task.redirected = false;
            task.redirectBrowsingDone = false;
            task.phase = 'navigating';
            task.updatedAt = new Date().toISOString();
            upsertDashboardPost({
                account: task.accountName || task.accountKey,
                accountKey: task.accountKey,
                contentKey: task.contentKey,
                url,
                status: 'running',
                phase: 'navigating',
                startedAt: task.startedAt,
            });
            recordTaskEvent(task, 'navigating', { status: 'running' });

            console.log(`Navigating ${session.accountName} to: ${url}`);
            await dismissInstagramDialogs();
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await wait(8000);
            await dismissInstagramDialogs();
            await throwIfInstagramBlocked('navigation');
            await throwIfInstagramLoginRequired('navigation login', {
                session,
                payload,
                targetUrl: url,
            });
            await wait(1000);

            const finalUrl = page.url();
            const finalContentKey = getInstagramContentKey(finalUrl) || requestedContentKey;
            task.finalUrl = finalUrl;
            task.contentKey = finalContentKey;
            task.redirected = didUrlRedirect(url, finalUrl);
            task.phase = 'loaded';
            task.updatedAt = new Date().toISOString();
            upsertDashboardPost({
                account: task.accountName || task.accountKey,
                accountKey: task.accountKey,
                contentKey: task.contentKey,
                url: task.originalUrl,
                status: 'running',
                phase: 'loaded',
                startedAt: task.startedAt,
            });
            recordTaskEvent(task, 'loaded', { status: 'running' });

            const alreadyCompletedAfterNavigation = getCompletedAction(task.accountKey, finalContentKey);
            if (alreadyCompletedAfterNavigation) {
                markCurrentTaskSkipped({
                    contentKey: finalContentKey,
                    originalUrl: url,
                    finalUrl,
                    completedAction: alreadyCompletedAfterNavigation,
                });
                console.log(`Skipping duplicate action after navigation: ${getHistoryKey(task.accountKey, finalContentKey)}`);
                return res.json(completedActionResponse('navigate', alreadyCompletedAfterNavigation, session.accountName));
            }

            console.log(`Page loaded. Account: ${session.accountName}. Content key: ${finalContentKey || 'unknown'}. Redirected: ${task.redirected}`);
            res.json({
                success: true,
                account: session.accountName,
                contentKey: finalContentKey,
                finalUrl,
                redirected: task.redirected,
            });
        }, 'navigate');
    } catch (error) {
        console.error('Navigate error:', error.message);
        if (error?.manualVerification) {
            return sendManualVerificationResponse(res, 'navigate', error, {
                browserVisible: true,
            });
        }
        sendError(res, error);
    }
});

app.post('/browser/like', async (req, res) => {
    try {
        const payload = getPayload(req);
        const session = getSessionForRequestPayload(payload);
        rememberSessionCredentials(session, payload);
        await runInBrowserSession(session, async () => {
            const skipped = skippedTaskResponse('like');
            if (skipped) {
                return res.json(skipped);
            }

            const payloadTarget = getActionTargetFromPayload(payload);
            if (payloadTarget.contentKey) {
                const completedAction = getCompletedAction(session.accountKey, payloadTarget.contentKey);
                if (completedAction) {
                    return res.json(completedActionResponse('like', completedAction, session.accountName));
                }
            }

            const activeBeforeLike = getActiveTask();
            if (isManualVerificationTask(activeBeforeLike)) {
                const queuedTask = queueActionTask(session, payload, payloadTarget);
                queuedTask.likeRequested = true;
                console.log(`Queued Like for ${session.accountName} while waiting for manual verification.`);
                return res.json({
                    ...manualVerificationResponse('like', activeBeforeLike, {
                        browserVisible: Boolean(isPageOpen()),
                        verificationRequired: Boolean(activeBeforeLike?.verificationRequired),
                        loginRequired: Boolean(activeBeforeLike?.loginRequired),
                    }),
                    queued: true,
                    queuedContentKey: queuedTask.contentKey || queuedTask.requestedContentKey || null,
                    queuedRowNumber: queuedTask.rowNumber || null,
                });
            }

            if (activeBeforeLike && payloadTarget.contentKey && !sameTaskTarget(activeBeforeLike, payloadTarget)) {
                const queuedTask = queueActionTask(session, payload, payloadTarget);
                queuedTask.likeRequested = true;
                console.log(`Queued Like for ${session.accountName} target ${queuedTask.contentKey || queuedTask.originalUrl || queuedTask.rowNumber}.`);
                return res.json(queuedTaskResponse('like', queuedTask, activeBeforeLike));
            }

            if (activeBeforeLike && isFinalTask(activeBeforeLike) && String(activeBeforeLike.phase || '').toLowerCase() !== 'error') {
                const queuedTask = findQueuedActionTask(session, payloadTarget);
                if (queuedTask) {
                    queuedTask.likeRequested = true;
                    return res.json(queuedTaskResponse('like', queuedTask, activeBeforeLike));
                }
                return res.json(completedActionResponse('like', activeBeforeLike.completedAction || {
                    account: activeBeforeLike.accountName || activeBeforeLike.accountKey,
                    contentKey: activeBeforeLike.contentKey || activeBeforeLike.requestedContentKey,
                    originalUrl: activeBeforeLike.originalUrl,
                    finalUrl: activeBeforeLike.finalUrl,
                    completedAt: activeBeforeLike.completedAt,
                }, session.accountName));
            }

            if (!payloadTarget.contentKey && session.queuedActionTasks?.length && activeBeforeLike?.phase === 'liked') {
                const queuedTask = findQueuedActionTask(session, payloadTarget);
                if (queuedTask) {
                    queuedTask.likeRequested = true;
                    return res.json(queuedTaskResponse('like', queuedTask, activeBeforeLike));
                }
            }

            requirePage();
            console.log(`Looking for like button for ${session.accountName}...`);
            const task = getActiveTask();
            if (task) {
                task.phase = 'liking';
                task.updatedAt = new Date().toISOString();
                recordTaskEvent(task, 'liking', { status: 'running' });
                await ensureTaskTargetPage(task, 'like');
            }
            await wait(3000);
            await dismissInstagramDialogs();
            await throwIfInstagramBlocked('like');
            await throwIfInstagramLoginRequired('like login', {
                session,
                payload,
                targetUrl: getTaskTargetUrl(task),
            });

            const existingUnlike = await findPostActionButton('Unlike');
            if (existingUnlike) {
                console.log(`Post is already liked for ${session.accountName}. Unlike button: ${JSON.stringify(existingUnlike.clickRect)}`);
                if (task) {
                    task.likeButtonRect = existingUnlike.clickRect;
                    task.phase = 'liked';
                    task.updatedAt = new Date().toISOString();
                    recordTaskEvent(task, 'liked', { status: 'running' });
                }
                return res.json({ success: true, account: session.accountName, alreadyLiked: true });
            }

            let likeButton = await clickPostActionButton('Like');

            if (likeButton) {
                if (task) {
                    task.lastActionButtonRect = likeButton.clickRect;
                }
                console.log(`Clicked Like button for ${session.accountName}: ${JSON.stringify(likeButton.clickRect)}`);
            } else {
                console.log(`Like button not found for ${session.accountName}; trying double-click.`);
                const mediaBox = await page.locator('article, main').first().boundingBox();

                if (mediaBox) {
                    await page.mouse.dblclick(mediaBox.x + mediaBox.width / 2, mediaBox.y + mediaBox.height / 2);
                } else {
                    await page.click('body', { clickCount: 2 });
                }
            }

            await wait(2000);
            await dismissInstagramDialogs();
            await throwIfInstagramBlocked('like verification');
            const recoveredLoginAfterLike = await throwIfInstagramLoginRequired('like verification login', {
                session,
                payload,
                targetUrl: getTaskTargetUrl(task),
            });
            if (recoveredLoginAfterLike && !await findPostActionButton('Unlike')) {
                console.log(`Retrying Like for ${session.accountName} after login recovery.`);
                const retryLikeButton = await clickPostActionButton('Like');
                if (retryLikeButton && task) {
                    task.lastActionButtonRect = retryLikeButton.clickRect;
                } else {
                    const mediaBox = await page.locator('article, main').first().boundingBox();
                    if (mediaBox) {
                        await page.mouse.dblclick(mediaBox.x + mediaBox.width / 2, mediaBox.y + mediaBox.height / 2);
                    } else {
                        await page.click('body', { clickCount: 2 });
                    }
                }
                await wait(2000);
                await dismissInstagramDialogs();
                await throwIfInstagramBlocked('like retry verification');
            }
            const verifiedUnlike = await findPostActionButton('Unlike');
            if (!verifiedUnlike) {
                throw new Error('Clicked Like, but Instagram did not show an Unlike button afterward.');
            }

            console.log(`Liked and verified for ${session.accountName}. Unlike button: ${JSON.stringify(verifiedUnlike.clickRect)}`);
            if (task) {
                task.likeButtonRect = verifiedUnlike.clickRect;
                task.phase = 'liked';
                task.updatedAt = new Date().toISOString();
                recordTaskEvent(task, 'liked', { status: 'running' });
            }
            res.json({ success: true, account: session.accountName });
        }, 'like');
    } catch (error) {
        console.error('Like error:', error.message);
        if (error?.manualVerification) {
            return sendManualVerificationResponse(res, 'like', error, {
                browserVisible: true,
            });
        }
        sendError(res, error);
    }
});

app.post('/browser/comment', async (req, res) => {
    let requestSession = null;
    try {
        const payload = getPayload(req);
        const comment = String(payload.comment || payload.comment_text || payload.text || '').trim();
        if (!comment) {
            return sendError(res, new Error('Missing comment. Send JSON like { "comment": "Nice post!" } or { "comment_text": "..." }.'), 400);
        }
        if (String(comment).trim() === '=' || String(comment).includes('{{')) {
            return sendError(res, new Error(`Invalid comment value received: "${comment}". Fix the n8n expression so it previews the real sheet text, not "=" or "{{ ... }}".`), 400);
        }

        const session = getSessionForRequestPayload(payload);
        requestSession = session;
        rememberSessionCredentials(session, payload);
        await runInBrowserSession(session, async () => {
            const skipped = skippedTaskResponse('comment');
            if (skipped) {
                return res.json(skipped);
            }

            const payloadTarget = getActionTargetFromPayload(payload);
            if (payloadTarget.contentKey) {
                const completedAction = getCompletedAction(session.accountKey, payloadTarget.contentKey);
                if (completedAction) {
                    return res.json(completedActionResponse('comment', completedAction, session.accountName));
                }
            }

            const activeBeforeComment = getActiveTask();
            if (isManualVerificationTask(activeBeforeComment)) {
                const queuedTask = queueActionTask(session, payload, { comment });
                console.log(`Queued comment for ${session.accountName} while waiting for manual verification.`);
                const completedQueuedAction = await waitForManualActionCompletion(session, queuedTask, 'comment manual verification wait');
                if (completedQueuedAction) {
                    return res.json({
                        success: true,
                        completed: true,
                        status: 'done',
                        actionStatus: 'done',
                        account: session.accountName,
                        completedAction: completedQueuedAction,
                    });
                }
                return sendManualActionStillWaitingResponse(res, 'comment', getActiveTask() || activeBeforeComment, {
                    browserVisible: Boolean(isPageOpen()),
                    verificationRequired: Boolean(activeBeforeComment?.verificationRequired),
                    loginRequired: Boolean(activeBeforeComment?.loginRequired),
                    queued: true,
                    message: 'Comment is queued, but Instagram verification/login is not completed yet. The row is still running, not done.',
                    next: 'Finish Instagram verification/login in the visible browser. The controller will resume and only then return a done response.',
                    contentKey: queuedTask.contentKey || queuedTask.requestedContentKey || null,
                    rowNumber: queuedTask.rowNumber || null,
                });
            }

            if (activeBeforeComment && isFinalTask(activeBeforeComment)) {
                const completedAction = activeBeforeComment.completedAction || getCompletedAction(
                    activeBeforeComment.accountKey,
                    activeBeforeComment.contentKey || activeBeforeComment.requestedContentKey,
                );
                const hasSpecificTarget = Boolean(payloadTarget.contentKey || payloadTarget.rowNumber || payloadTarget.url);
                const sameCompletedTask = sameTaskTarget(activeBeforeComment, payloadTarget)
                    || (!hasSpecificTarget && activeBeforeComment.comment && activeBeforeComment.comment === comment);
                const retryFailedActiveTask = String(activeBeforeComment.phase || '').toLowerCase() === 'error'
                    && !completedAction
                    && (sameTaskTarget(activeBeforeComment, payloadTarget)
                        || (!hasSpecificTarget && activeBeforeComment.comment && activeBeforeComment.comment === comment));

                if (sameCompletedTask && completedAction) {
                    return res.json(completedActionResponse('comment', completedAction, session.accountName));
                }

                if (retryFailedActiveTask) {
                    activeBeforeComment.phase = 'commenting';
                    activeBeforeComment.error = null;
                    activeBeforeComment.comment = comment;
                    activeBeforeComment.updatedAt = new Date().toISOString();
                } else {
                    const queuedTask = findQueuedActionTask(session, payloadTarget);
                    if (queuedTask) {
                        queuedTask.comment = comment || queuedTask.comment;
                        const completedQueuedAction = await performQueuedActionTask(session, queuedTask, queuedTask.comment);
                        return res.json({
                            success: true,
                            completed: true,
                            status: 'done',
                            actionStatus: 'done',
                            account: session.accountName,
                            completedAction: completedQueuedAction,
                        });
                    }

                    if (completedAction) {
                        return res.json(completedActionResponse('comment', completedAction, session.accountName));
                    }
                }
            }

            if (activeBeforeComment && payloadTarget.contentKey && !sameTaskTarget(activeBeforeComment, payloadTarget)) {
                const queuedTask = queueActionTask(session, payload, { comment });
                return res.json(queuedTaskResponse('comment', queuedTask, activeBeforeComment));
            }

            if (activeBeforeComment
                && !payloadTarget.contentKey
                && session.queuedActionTasks?.length
                && activeBeforeComment.comment
                && activeBeforeComment.comment !== comment) {
                const queuedTask = findQueuedActionTask(session, { comment });
                if (queuedTask) {
                    queuedTask.comment = comment || queuedTask.comment;
                    if (isFinalTask(activeBeforeComment)) {
                        const completedQueuedAction = await performQueuedActionTask(session, queuedTask, queuedTask.comment);
                        return res.json({
                            success: true,
                            completed: true,
                            status: 'done',
                            actionStatus: 'done',
                            account: session.accountName,
                            completedAction: completedQueuedAction,
                        });
                    }
                    return res.json(queuedTaskResponse('comment', queuedTask, activeBeforeComment));
                }
            }

            if (!isPageOpen()) {
                const recoveryDefaults = getTaskActionDefaults(activeBeforeComment, {
                    url: payloadTarget.url || null,
                    contentKey: payloadTarget.contentKey || null,
                    rowNumber: payloadTarget.rowNumber || null,
                    comment,
                });

                if (!recoveryDefaults.url && !recoveryDefaults.contentKey) {
                    throw new Error('Browser is closed and this comment request has no Instagram URL/content key to recover. Send the row URL with /browser/comment or call /browser/start and /browser/navigate first.');
                }

                const queuedTask = queueActionTask(session, payload, recoveryDefaults);
                queuedTask.comment = comment || queuedTask.comment;
                await ensureBrowserReadyForAction(session, payload, recoveryDefaults, 'comment browser recovery');
                const completedRecoveredAction = await performQueuedActionTask(session, queuedTask, queuedTask.comment);
                return res.json({
                    success: true,
                    completed: true,
                    status: 'done',
                    actionStatus: 'done',
                    account: session.accountName,
                    completedAction: completedRecoveredAction,
                    recoveredBrowser: true,
                    browserClosed: !isPageOpen(),
                });
            }

            requirePage();

            console.log(`Adding comment for ${session.accountName}: "${comment}"`);
            const task = getActiveTask();
            if (task) {
                task.phase = 'commenting';
                task.comment = comment;
                task.updatedAt = new Date().toISOString();
                recordTaskEvent(task, 'commenting', { status: 'running' });
            }

            await submitCommentForActiveTask(session, comment, 'comment');
            const completedAction = await markCurrentTaskCompleted();
            const nextReadyQueuedTask = (session.queuedActionTasks || []).find(task => task.comment);
            let continuedQueuedAction = null;
            if (nextReadyQueuedTask) {
                console.log(`Continuing queued task for ${session.accountName} after completed comment.`);
                continuedQueuedAction = await performQueuedActionTask(session, nextReadyQueuedTask, nextReadyQueuedTask.comment);
            }
            const browserClosed = continuedQueuedAction
                ? !isPageOpen()
                : await closeBrowserAfterCompletedTask(session, 'comment completion');

            await wait(3000);
            res.json({
                success: true,
                completed: true,
                status: 'done',
                actionStatus: 'done',
                account: session.accountName,
                completedAction,
                continuedQueuedAction,
                browserClosed,
            });
        }, 'comment');
    } catch (error) {
        console.error('Comment error:', error.message);
        if (error?.manualVerification) {
            const recoverySession = requestSession || getActiveBrowserSession();
            const activeTask = getActiveTask();
            const completedAction = await waitForManualActionCompletion(
                recoverySession,
                isResumableActionTask(activeTask) ? activeTask : null,
                'comment manual verification recovery',
            ).catch(waitError => {
                if (!waitError?.manualVerification) {
                    console.log(`Comment manual recovery wait failed: ${waitError.message}`);
                }
                return null;
            });

            if (completedAction) {
                return res.json({
                    success: true,
                    completed: true,
                    status: 'done',
                    actionStatus: 'done',
                    account: recoverySession.accountName || recoverySession.accountKey,
                    completedAction,
                });
            }

            return sendManualActionStillWaitingResponse(res, 'comment', activeTask, {
                browserVisible: true,
                message: error.message,
            });
        }
        if (isPageOpen()) {
            await page.screenshot({ path: 'comment-error.png' }).catch(() => null);
        }
        sendError(res, error);
    }
});

app.post('/browser/close', async (req, res) => {
    try {
        const payload = getPayload(req);
        const requestedAccount = normalizeAccountName(payload.account_username || payload.username || payload.account);

        if (requestedAccount) {
            const session = getBrowserSession(requestedAccount, requestedAccount);
            await runInBrowserSession(session, async () => {
                const task = getActiveTask();
                const wasSkipped = Boolean(task?.skip);
                const skippedReason = task?.skipReason || null;
                await closeBrowser();
                res.json({ success: true, account: requestedAccount, skipped: wasSkipped, reason: skippedReason });
            }, 'close');
            return;
        }

        const sessionsToClose = Array.from(browserSessions.values());
        const closedAccounts = [];
        for (const session of sessionsToClose) {
            await runInBrowserSession(session, async () => {
                if (isPageOpen()) {
                    closedAccounts.push(session.accountName || session.accountKey);
                }
                await closeBrowser();
            }, 'close');
        }

        res.json({ success: true, closedAccounts });
    } catch (error) {
        console.error('Close error:', error.message);
        sendError(res, error);
    }
});

app.listen(PORT, () => {
    console.log(`Instagram Automation Controller listening on http://localhost:${PORT}`);
    console.log(`Live monitor dashboard: http://localhost:${PORT}/monitor`);
    console.log(`Using session: ${SESSION_FILE}`);
    startManualVerificationAutoChecks();
    if (AUTO_OPEN_MONITOR) {
        openUrlInDefaultBrowser(`http://localhost:${PORT}/monitor`);
    }
});
