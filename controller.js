const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
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
    platform: inferPlatformFromAccountKey(accountKey),
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
    queuedActionDrainScheduled: false,
    queuedActionDrainInFlight: false,
});

const getBrowserSession = (accountKey = 'default', accountName = accountKey, platform = null) => {
    const normalizedKey = normalizeAccountName(accountKey) || 'default';
    if (!browserSessions.has(normalizedKey)) {
        browserSessions.set(normalizedKey, createBrowserSession(normalizedKey, accountName || normalizedKey));
    }

    const session = browserSessions.get(normalizedKey);
    session.accountName = accountName || session.accountName || normalizedKey;
    session.platform = normalizePlatform(platform) || session.platform || inferPlatformFromAccountKey(normalizedKey);
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
const RUNTIME_ERROR_LOG_FILE = process.env.RUNTIME_ERROR_LOG_FILE || path.join(__dirname, 'controller-runtime-errors.log');
const INSTAGRAM_HOME_URL = 'https://www.instagram.com/';
const INSTAGRAM_LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const X_HOME_URL = 'https://x.com/';
const X_LOGIN_URL = 'https://x.com/i/flow/login';
const PORT = process.env.PORT || 3000;
const AUTO_OPEN_MONITOR = process.env.AUTO_OPEN_MONITOR !== 'false';
const HEADLESS = process.env.HEADLESS === 'true';
const LOG_ACTIONS = process.env.LOG_ACTIONS !== 'false';
const LOG_HTTP_REQUESTS = process.env.LOG_HTTP_REQUESTS === 'true';
const LOG_DEBUG_DETAILS = process.env.LOG_DEBUG_DETAILS === 'true';
const BROWSER_VIEWPORT = {
    width: Number(process.env.BROWSER_VIEWPORT_WIDTH) || 1440,
    height: Number(process.env.BROWSER_VIEWPORT_HEIGHT) || 1000,
};
const BROWSER_WINDOW_WIDTH = Number(process.env.BROWSER_WINDOW_WIDTH) || BROWSER_VIEWPORT.width;
const BROWSER_WINDOW_HEIGHT = Number(process.env.BROWSER_WINDOW_HEIGHT) || BROWSER_VIEWPORT.height + 90;
const MANUAL_BROWSER_WINDOW_WIDTH = Number(process.env.MANUAL_BROWSER_WINDOW_WIDTH) || Math.max(1280, BROWSER_WINDOW_WIDTH + 80);
const MANUAL_BROWSER_WINDOW_HEIGHT = Number(process.env.MANUAL_BROWSER_WINDOW_HEIGHT) || BROWSER_WINDOW_HEIGHT;
const HIDE_BROWSER_WINDOWS = process.env.HIDE_BROWSER_WINDOWS !== 'false' && !HEADLESS;
const DEFAULT_CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
const DEFAULT_CHROME_PROFILE_DIRECTORY = process.env.CHROME_PROFILE_DIRECTORY || 'Default';
const DEFAULT_EDGE_USER_DATA_DIR = process.env.EDGE_USER_DATA_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data');
const DEDICATED_X_EDGE_USER_DATA_DIR = process.env.DEDICATED_X_EDGE_USER_DATA_DIR || path.join(__dirname, 'x-edge-profile');
const DEFAULT_X_EDGE_USER_DATA_DIR = process.env.X_EDGE_USER_DATA_DIR || DEFAULT_EDGE_USER_DATA_DIR;
const DEFAULT_EDGE_PROFILE_DIRECTORY = process.env.EDGE_PROFILE_DIRECTORY || 'Default';
const X_SYSTEM_BROWSER_CHANNEL = String(process.env.X_SYSTEM_BROWSER_CHANNEL || process.env.X_BROWSER_CHANNEL || 'chrome').trim().toLowerCase();
const X_SYSTEM_BROWSER_NAME = X_SYSTEM_BROWSER_CHANNEL === 'chrome' ? 'Chrome' : 'Edge';
const DEFAULT_X_SYSTEM_USER_DATA_DIR = X_SYSTEM_BROWSER_CHANNEL === 'chrome' ? DEFAULT_CHROME_USER_DATA_DIR : DEFAULT_X_EDGE_USER_DATA_DIR;
const DEFAULT_X_SYSTEM_PROFILE_DIRECTORY = process.env.X_PROFILE_DIRECTORY
    || (X_SYSTEM_BROWSER_CHANNEL === 'chrome' ? DEFAULT_CHROME_PROFILE_DIRECTORY : DEFAULT_EDGE_PROFILE_DIRECTORY);
const X_USE_SYSTEM_BROWSER_PROFILE = process.env.X_USE_SYSTEM_BROWSER_PROFILE === 'true'
    || process.env.X_USE_SYSTEM_CHROME_PROFILE === 'true';
const X_AUTO_LOGIN = process.env.X_AUTO_LOGIN === 'true';
const X_MANUAL_CHROME_USER_DATA_DIR = process.env.X_MANUAL_CHROME_USER_DATA_DIR || path.join(__dirname, 'x-manual-chrome-profile');
const X_MANUAL_CHROME_DEBUG_PORT_BASE = Number(process.env.X_MANUAL_CHROME_DEBUG_PORT_BASE) || 9323;
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
const COMMENT_COMPOSER_OPEN_WAIT_MS = Number(process.env.COMMENT_COMPOSER_OPEN_WAIT_MS) || 50000;
const COMMENT_COMPOSER_HINT_RETRY_MS = Number(process.env.COMMENT_COMPOSER_HINT_RETRY_MS) || 12000;
const DASHBOARD_RUNNING_STALE_MS = Number(process.env.DASHBOARD_RUNNING_STALE_MS) || 180000;
const INDIA_TIME_ZONE = 'Asia/Kolkata';
const INDIA_UTC_OFFSET_MINUTES = 330;
const ACTION_HISTORY_MAX_EVENTS = Number(process.env.ACTION_HISTORY_MAX_EVENTS) || 800;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const logDebug = message => {
    if (LOG_DEBUG_DETAILS) {
        console.log(message);
    }
};
const appendRuntimeErrorLog = (label, error) => {
    const message = error?.stack || error?.message || String(error || '');
    const line = `[${new Date().toISOString()}] ${label}: ${message}\n`;
    console.error(line.trim());
    try {
        fs.appendFileSync(RUNTIME_ERROR_LOG_FILE, line);
    } catch (_error) {
        // Console logging above is the fallback if the runtime log cannot be written.
    }
};
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

process.on('unhandledRejection', error => {
    appendRuntimeErrorLog('Unhandled promise rejection', error);
});

process.on('uncaughtExceptionMonitor', error => {
    appendRuntimeErrorLog('Uncaught exception', error);
});

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

const getChromeExecutablePath = () => [
    process.env.CHROME_EXECUTABLE_PATH,
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean).find(candidate => fs.existsSync(candidate)) || 'chrome';

const getXManualChromeDebugPort = accountKey => {
    const hash = safeAccountName(accountKey).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return X_MANUAL_CHROME_DEBUG_PORT_BASE + (hash % 200);
};

const openXManualLoginChrome = session => {
    const accountPart = safeAccountName(session.accountKey || session.accountName || 'default');
    const userDataDir = path.join(X_MANUAL_CHROME_USER_DATA_DIR, accountPart);
    const port = getXManualChromeDebugPort(session.accountKey);
    fs.mkdirSync(userDataDir, { recursive: true });
    const chromePath = getChromeExecutablePath();
    const command = process.platform === 'win32'
        ? `start "" "${chromePath}" --remote-debugging-port=${port} --user-data-dir="${userDataDir}" --no-first-run "${X_LOGIN_URL}"`
        : `"${chromePath}" --remote-debugging-port=${port} --user-data-dir="${userDataDir}" --no-first-run "${X_LOGIN_URL}"`;
    exec(command, error => {
        if (error) {
            console.log(`Could not open dedicated Chrome login: ${error.message}`);
        }
    });
    return { port, userDataDir };
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
const normalizePlatform = value => {
    const platform = String(value || '').trim().toLowerCase();
    if (['x', 'twitter'].includes(platform)) {
        return 'x';
    }
    if (['instagram', 'ig'].includes(platform)) {
        return 'instagram';
    }
    return null;
};
const inferPlatformFromAccountKey = accountKey => String(accountKey || '').startsWith('x:') ? 'x' : 'instagram';
const getItemPlatform = item => normalizePlatform(item?.platform)
    || (String(item?.accountKey || '').startsWith('x:') || String(item?.contentKey || '').startsWith('x:') ? 'x' : 'instagram');
const stripPlatformAccountKey = accountKey => String(accountKey || '').replace(/^x:/, '');
const getPlatformAccountKey = (platform, accountName) => {
    const normalized = normalizeAccountName(accountName);
    if (!normalized) {
        return platform === 'x' ? 'x:default' : 'default';
    }
    if (platform === 'x') {
        return normalized.startsWith('x:') ? normalized : `x:${normalized}`;
    }
    return normalized.replace(/^instagram:/, '');
};
const normalizeCommentValue = value => String(value || '').replace(/\s+/g, ' ').trim();
const commentValueEquals = (value, expected) => normalizeCommentValue(value) === normalizeCommentValue(expected);
const safeAccountName = value => normalizeAccountName(value).replace(/[^a-z0-9._-]/g, '_');
const getAccountPassword = payload => {
    const password = payload.account_password || payload.instagram_password || payload.password;
    return typeof password === 'string' ? password : String(password || '');
};
const getXAccountPassword = payload => {
    const password = payload.x_password || payload.account_password || payload.password;
    return typeof password === 'string' ? password : String(password || '');
};
const getXApiAccessToken = (payload = {}, session = null) => {
    const accountName = normalizeAccountName(
        payload.x_username
        || payload.twitter_username
        || payload.account_username
        || payload.username
        || session?.accountName
        || stripPlatformAccountKey(session?.accountKey),
    );
    const accountEnvSuffix = safeAccountName(accountName).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const envToken = accountEnvSuffix ? process.env[`X_API_ACCESS_TOKEN_${accountEnvSuffix}`] : null;
    const token = payload.x_access_token
        || payload.x_api_access_token
        || payload.x_user_access_token
        || payload.user_access_token
        || payload.access_token
        || envToken
        || process.env.X_API_ACCESS_TOKEN
        || null;
    return typeof token === 'string' ? token.trim() : String(token || '').trim();
};
const getXApiUserId = (payload = {}, session = null) => {
    const accountName = normalizeAccountName(
        payload.x_username
        || payload.twitter_username
        || payload.account_username
        || payload.username
        || session?.accountName
        || stripPlatformAccountKey(session?.accountKey),
    );
    const accountEnvSuffix = safeAccountName(accountName).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const envUserId = accountEnvSuffix ? process.env[`X_API_USER_ID_${accountEnvSuffix}`] : null;
    const userId = payload.x_user_id
        || payload.twitter_user_id
        || payload.user_id
        || envUserId
        || process.env.X_API_USER_ID
        || null;
    return typeof userId === 'string' ? userId.trim() : String(userId || '').trim();
};
const X_USERNAME_INPUT_SELECTORS = [
    '[role="dialog"] input[name="text"]',
    '[role="dialog"] input[autocomplete="username"]',
    '[role="dialog"] input[data-testid="ocfEnterTextTextInput"]',
    'input[name="text"]',
    'input[autocomplete="username"]',
    'input[data-testid="ocfEnterTextTextInput"]',
    'input[aria-label*="email" i]',
    'input[placeholder*="email" i]',
    'input[aria-label*="username" i]',
    'input[placeholder*="username" i]',
];
const X_PASSWORD_INPUT_SELECTORS = [
    '[role="dialog"] input[name="password"]',
    '[role="dialog"] input[type="password"]',
    '[role="dialog"] input[autocomplete="current-password"]',
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[aria-label*="password" i]',
    'input[placeholder*="password" i]',
];
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

const getXUrlFromPayload = payload => getFirstPayloadValue(payload, [
    'x_url',
    'xUrl',
    'tweet_url',
    'tweetUrl',
    'status_url',
    'statusUrl',
    'x post url',
    'x_post_url',
    'xPostUrl',
    'target_url',
    'link',
    'url',
]) || null;

const getXContentKey = value => {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
        return null;
    }

    try {
        const url = new URL(rawValue, X_HOME_URL);
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        const parts = url.pathname.split('/').filter(Boolean);
        const statusIndex = parts.findIndex(part => ['status', 'statuses'].includes(part.toLowerCase()));
        const statusId = statusIndex >= 0 ? parts[statusIndex + 1] : (parts[0] === 'i' && parts[1] === 'status' ? parts[2] : null);

        if ((host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') && statusId) {
            return `x:${statusId}`;
        }

        return `x:url:${url.origin}${url.pathname}`.toLowerCase();
    } catch (_error) {
        return `x:url:${rawValue.split('?')[0].toLowerCase()}`;
    }
};

const getXUrlForContentKey = contentKey => {
    const match = String(contentKey || '').match(/^x:(?:status:)?([^:]+)$/i);
    return match ? `${X_HOME_URL}i/status/${encodeURIComponent(match[1])}` : null;
};

const isXStatusContentKey = contentKey => /^x:[0-9]{1,19}$/i.test(String(contentKey || ''));

const getPayloadPlatform = (payload = {}, fallback = null) => {
    const explicitPlatform = normalizePlatform(payload.platform || payload.source_platform || payload.sourcePlatform);
    if (explicitPlatform) {
        return explicitPlatform;
    }
    if (getXUrlFromPayload(payload)) {
        return 'x';
    }
    if (getInstagramUrlFromPayload(payload)) {
        return 'instagram';
    }
    return normalizePlatform(fallback) || null;
};

const getUrlFromPayloadForPlatform = (payload = {}, platform = null) => {
    const normalizedPlatform = normalizePlatform(platform) || getPayloadPlatform(payload) || 'instagram';
    return normalizedPlatform === 'x' ? getXUrlFromPayload(payload) : getInstagramUrlFromPayload(payload);
};

const getContentKeyForPlatform = (platform, url) => {
    return platform === 'x' ? getXContentKey(url) : getInstagramContentKey(url);
};

const getUrlForContentKeyForPlatform = (platform, contentKey) => {
    return platform === 'x' ? getXUrlForContentKey(contentKey) : getInstagramUrlForContentKey(contentKey);
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
        'queued',
        'navigating',
        'loaded',
        'reposting',
        'reposted',
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

const ACTION_STATE_SEQUENCE = [
    'queued',
    'starting',
    'logged_in',
    'navigating',
    'loaded',
    'reposting',
    'reposted',
    'liking',
    'liked',
    'commenting',
    'verified',
    'done',
];
const ACTION_STATE_RANKS = new Map(ACTION_STATE_SEQUENCE.map((state, index) => [state, index]));
const ACTION_STATE_ALIASES = {
    active: 'starting',
    working: 'starting',
    'validating-session': 'starting',
    login: 'starting',
    reposting: 'reposting',
    reposted: 'reposted',
    'login-needed': 'starting',
    verification: 'starting',
    'manual-verification': 'starting',
    paused: 'starting',
    ready: 'logged_in',
    commented: 'verified',
    completed: 'done',
    success: 'done',
    skipped: 'done',
    blocked: 'failed',
    error: 'failed',
    stalled: 'failed',
    unverified: 'failed',
};

const normalizeActionState = value => {
    const state = String(value || '').trim().toLowerCase();
    if (!state) {
        return null;
    }
    if (ACTION_STATE_RANKS.has(state) || state === 'failed') {
        return state;
    }
    return ACTION_STATE_ALIASES[state] || null;
};

const getActionStateRank = state => state === 'failed'
    ? -1
    : ACTION_STATE_RANKS.get(state) ?? -1;

const deriveActionState = item => {
    const status = normalizeDashboardStatus(item?.status || item?.phase);
    if (status === 'done') {
        return 'done';
    }
    if (status === 'failed') {
        return 'failed';
    }
    if (item?.verification?.visible) {
        return 'verified';
    }

    return normalizeActionState(item?.actionState)
        || normalizeActionState(item?.phase)
        || normalizeActionState(item?.status)
        || (status === 'running' ? 'starting' : null);
};

const withActionState = item => {
    const actionState = deriveActionState(item);
    if (!actionState) {
        return item;
    }

    return {
        ...item,
        actionState,
        actionStateRank: getActionStateRank(actionState),
    };
};

const isVerifiedCompletedDashboardRecord = item => Boolean(item?.verification?.visible)
    && (
        deriveActionState(item) === 'done'
        || normalizeDashboardStatus(item?.status || item?.phase) === 'done'
    );

const shouldProtectCompletedDashboardRecord = (previous, next, completedAction) => {
    if (isTrustedCompletedAction(completedAction)) {
        return true;
    }

    return isVerifiedCompletedDashboardRecord(previous) && normalizeDashboardStatus(next?.status || next?.phase) !== 'done';
};

const isSameActionRun = (previous, next) => {
    const previousStartedAt = previous?.startedAt || null;
    const nextStartedAt = next?.startedAt || null;
    if (!previousStartedAt || !nextStartedAt) {
        return true;
    }

    return previousStartedAt === nextStartedAt;
};

const shouldProtectForwardProgress = (previous, next) => {
    const previousState = deriveActionState(previous);
    const nextState = deriveActionState(next);
    if (!previousState || !nextState || previousState === 'failed' || nextState === 'failed' || previousState === 'done') {
        return false;
    }
    if (!isSameActionRun(previous, next)) {
        return false;
    }

    return getActionStateRank(previousState) > getActionStateRank(nextState);
};

const applyActionStateMachine = (previous, next, completedAction = null) => {
    const normalizedNext = withActionState(next);
    if (!shouldProtectCompletedDashboardRecord(previous, normalizedNext, completedAction)) {
        if (shouldProtectForwardProgress(previous, normalizedNext)) {
            return withActionState({
                ...normalizedNext,
                status: previous.status || normalizedNext.status,
                phase: previous.phase || normalizedNext.phase,
                actionState: previous.actionState || deriveActionState(previous),
                actionStateRank: previous.actionStateRank ?? getActionStateRank(deriveActionState(previous)),
                error: previous.error || normalizedNext.error || null,
                completedAt: previous.completedAt || normalizedNext.completedAt || null,
                thumbnailUrl: previous.thumbnailUrl || normalizedNext.thumbnailUrl || null,
            });
        }

        return normalizedNext;
    }

    const completedAt = completedAction?.completedAt || previous?.completedAt || normalizedNext.completedAt || new Date().toISOString();
    return withActionState({
        ...normalizedNext,
        ...previous,
        status: 'done',
        phase: 'done',
        error: null,
        completedAt,
        url: completedAction?.finalUrl || previous?.url || normalizedNext.url || completedAction?.originalUrl || null,
        comment: completedAction?.comment || previous?.comment || normalizedNext.comment || null,
        thumbnailUrl: completedAction?.thumbnailUrl || previous?.thumbnailUrl || normalizedNext.thumbnailUrl || null,
        verification: completedAction?.verification || previous?.verification || normalizedNext.verification || null,
        updatedAt: completedAt,
    });
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
    const platform = getPayloadPlatform(payload, defaults.platform || defaults.sourcePlatform || getItemPlatform(defaults)) || 'instagram';
    const url = getUrlFromPayloadForPlatform(payload, platform) || defaults.url || defaults.originalUrl || null;
    const contentKey = getContentKeyForPlatform(platform, url) || defaults.contentKey || null;
    const accountName = normalizeAccountName(
        payload.account_username
        || payload.x_username
        || payload.twitter_username
        || payload.username
        || payload.account
        || stripPlatformAccountKey(defaults.accountKey)
        || defaults.accountKey
        || defaults.account,
    );
    const rowNumber = getFirstPayloadValue(payload, ['row_number', 'rowNumber', 'row', 'sheet_row', 'sheetRow', '__row_number']);
    const status = normalizeDashboardStatus(getFirstPayloadValue(payload, ['action_status', 'dashboard_status', 'status', 'state']) || defaults.status);
    const phase = defaults.phase || (status === 'running' && defaults.source === 'sheet' ? 'queued' : status);
    const comment = getFirstPayloadValue(payload, ['comment', 'comment_text', 'text', 'message']);

    if (!accountName && !contentKey && !url && !rowNumber) {
        return null;
    }

    const accountKey = getPlatformAccountKey(platform, accountName);
    return withActionState({
        platform,
        account: accountName || defaults.account || defaults.accountName || stripPlatformAccountKey(accountKey) || 'default',
        accountKey,
        contentKey,
        url,
        rowNumber: rowNumber || defaults.rowNumber || null,
        comment: comment || defaults.comment || null,
        scheduledAt: getDashboardScheduledValue(payload) || defaults.scheduledAt || null,
        status,
        phase,
        source: defaults.source || 'sheet',
        error: defaults.error || null,
        startedAt: defaults.startedAt || null,
        completedAt: defaults.completedAt || (status === 'done' ? new Date().toISOString() : null),
        thumbnailUrl: defaults.thumbnailUrl || payload.thumbnailUrl || payload.thumbnail_url || null,
        updatedAt: new Date().toISOString(),
    });
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

    const history = readActionHistory();
    const storedPosts = Object.values(history.posts || {});
    if (normalizedRowNumber) {
        const byStoredRow = storedPosts.find(post => post.accountKey === normalizedAccountKey && String(post.rowNumber || '') === normalizedRowNumber);
        if (byStoredRow) {
            return byStoredRow;
        }
    }
    if (normalizedContentKey) {
        const byStoredContent = storedPosts.find(post => post.accountKey === normalizedAccountKey && post.contentKey === normalizedContentKey && post.rowNumber);
        if (byStoredContent) {
            return byStoredContent;
        }
    }

    return null;
};

const upsertDashboardPost = post => {
    const rememberedPost = !post?.rowNumber
        ? findRememberedDashboardPost({
            accountKey: post?.accountKey || post?.account,
            contentKey: post?.contentKey,
            url: post?.url,
        })
        : null;
    const resolvedPost = rememberedPost
        ? {
            ...rememberedPost,
            ...post,
            rowNumber: post.rowNumber || rememberedPost.rowNumber || null,
        }
        : post;
    const postKey = getDashboardPostKey(resolvedPost);
    if (!postKey) {
        return null;
    }

    const history = readActionHistory();
    const previous = history.posts[postKey] || {};
    const storedCompletedAction = resolvedPost.contentKey
        ? history.completed[getHistoryKey(resolvedPost.accountKey, resolvedPost.contentKey)]
        : null;
    const completedAction = isTrustedCompletedAction(storedCompletedAction) ? storedCompletedAction : null;
    const merged = applyActionStateMachine(previous, {
        ...previous,
        ...resolvedPost,
        postKey,
        createdAt: previous.createdAt || post.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }, completedAction);
    const duplicateKeys = [
        merged.rowNumber ? null : rememberedPost?.postKey,
        merged.contentKey ? getHistoryKey(merged.accountKey, merged.contentKey) : null,
        merged.url ? `${merged.accountKey || 'default'}::url:${normalizeUrlForRedirectCheck(merged.url).toLowerCase()}` : null,
    ].filter(key => key && key !== postKey);

    if (!shouldStoreDashboardStatus(merged.status) && !shouldStoreDashboardStatus(merged.phase)) {
        delete history.posts[postKey];
        duplicateKeys.forEach(key => delete history.posts[key]);
        writeActionHistory(history);
        return null;
    }

    duplicateKeys.forEach(key => delete history.posts[key]);
    history.posts[postKey] = merged;
    rememberDashboardPost(merged);
    writeActionHistory(history);
    return merged;
};

const replaceDashboardPosts = (posts, options = {}) => {
    const history = readActionHistory();
    const nextPosts = {};
    const activePostKey = options.activePostKey || null;
    const replacePlatform = normalizePlatform(options.platform) || null;

    Object.entries(history.posts || {}).forEach(([postKey, post]) => {
        if (replacePlatform && getItemPlatform(post) !== replacePlatform) {
            nextPosts[postKey] = post;
        }
    });

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
        let merged = applyActionStateMachine(previous, {
            ...previous,
            ...post,
            postKey,
            createdAt: previous.createdAt || post.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }, completedAction);

        if (completedAction) {
            merged = withActionState({
                ...merged,
                status: 'done',
                phase: 'done',
                completedAt: completedAction.completedAt || merged.completedAt,
                url: completedAction.finalUrl || merged.url,
                thumbnailUrl: completedAction.thumbnailUrl || merged.thumbnailUrl,
                verification: completedAction.verification || merged.verification || null,
            });
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

const getDashboardRowsPlatform = (payload, rows, currentRow = null) => {
    const payloadPlatform = getPayloadPlatform(payload);
    if (payloadPlatform) {
        return payloadPlatform;
    }

    const rowPlatform = [currentRow, ...rows]
        .filter(Boolean)
        .map(row => getPayloadPlatform(row))
        .find(Boolean);
    return rowPlatform || 'instagram';
};

const normalizeDashboardPassthroughRow = (row, syncedCount) => ({
    ...(row && typeof row === 'object' && !Array.isArray(row) ? row : { value: row }),
    dashboard_synced: true,
    dashboard_synced_count: syncedCount,
});

const getDashboardRowSheetStatusFields = (row, history) => {
    const post = getDashboardPostFromPayload(row, { source: 'sheet' });
    if (!post) {
        return {};
    }

    const completedAction = findTrustedCompletionForDashboardPost(history, post);
    return completedAction ? completedActionSheetFields(completedAction) : {};
};

const normalizeDashboardSheetSyncRow = (row, syncedCount, history) => ({
    ...normalizeDashboardPassthroughRow(row, syncedCount),
    ...getDashboardRowSheetStatusFields(row, history),
});

const getDashboardSummaryRank = post => {
    const status = normalizeDashboardStatus(post?.status || post?.phase);
    const phase = String(post?.phase || '').toLowerCase();
    const updatedAt = Date.parse(post?.updatedAt || post?.completedAt || post?.startedAt || post?.createdAt || '') || 0;
    let rank = 0;

    if (status === 'done') {
        rank += 600;
    } else if (status === 'running') {
        rank += 500;
    } else if (status === 'failed') {
        rank += 100;
    }

    if (phase === 'unverified' && post?.source === 'sheet') {
        rank -= 80;
    }
    if (post?.source === 'controller') {
        rank += 30;
    }
    if (post?.thumbnailUrl) {
        rank += 10;
    }

    return rank + updatedAt / 100000000000000;
};

const mergeDashboardSummaryDuplicates = posts => {
    const byTarget = new Map();

    posts.forEach(post => {
        const targetKey = post?.accountKey && post?.contentKey
            ? getHistoryKey(post.accountKey, post.contentKey)
            : post?.postKey || getDashboardPostKey(post);
        if (!targetKey) {
            return;
        }

        const previous = byTarget.get(targetKey);
        if (!previous) {
            byTarget.set(targetKey, post);
            return;
        }

        const winner = getDashboardSummaryRank(post) >= getDashboardSummaryRank(previous)
            ? post
            : previous;
        const fallback = winner === post ? previous : post;
        byTarget.set(targetKey, {
            ...fallback,
            ...winner,
            rowNumber: winner.rowNumber || fallback.rowNumber || null,
            scheduledAt: winner.scheduledAt || fallback.scheduledAt || null,
            createdAt: fallback.createdAt && winner.createdAt
                ? (Date.parse(fallback.createdAt) <= Date.parse(winner.createdAt) ? fallback.createdAt : winner.createdAt)
                : winner.createdAt || fallback.createdAt || null,
            postKey: winner.rowNumber || fallback.rowNumber
                ? `${winner.accountKey || fallback.accountKey || 'default'}::row:${winner.rowNumber || fallback.rowNumber}`
                : winner.postKey || fallback.postKey || getDashboardPostKey(winner),
        });
    });

    return Array.from(byTarget.values());
};

const findTrustedCompletionForDashboardPost = (history, post) => {
    const platform = getItemPlatform(post);
    const accountKey = post?.accountKey
        ? normalizeAccountName(post.accountKey)
        : getPlatformAccountKey(platform, post?.account);
    if (post?.contentKey) {
        const byContent = history.completed[getHistoryKey(accountKey, post.contentKey)] || null;
        if (isTrustedCompletedAction(byContent) && getItemPlatform(byContent) === platform) {
            return byContent;
        }
    }

    const rowNumber = String(post?.rowNumber || '').trim();
    if (rowNumber) {
        return Object.values(history.completed || {}).find(completedAction => {
            if (!isTrustedCompletedAction(completedAction)) {
                return false;
            }

            const completedAccountKey = normalizeAccountName(completedAction.account) || 'default';
            const resolvedCompletedAccountKey = completedAction.accountKey
                ? normalizeAccountName(completedAction.accountKey)
                : getPlatformAccountKey(getItemPlatform(completedAction), completedAction.account);
            return getItemPlatform(completedAction) === platform
                && (resolvedCompletedAccountKey === accountKey || completedAccountKey === accountKey)
                && String(completedAction.rowNumber || '').trim() === rowNumber;
        }) || null;
    }

    return null;
};

const mergeCompletedActionIntoDashboardPost = (post, completedAction, postKey) => {
    const platform = getItemPlatform(completedAction) || getItemPlatform(post);
    const accountKey = completedAction.accountKey
        ? normalizeAccountName(completedAction.accountKey)
        : getPlatformAccountKey(platform, completedAction.account || post?.accountKey || post?.account);
    return withActionState({
        ...post,
        platform,
        postKey,
        account: post?.account || completedAction.account || stripPlatformAccountKey(accountKey),
        accountKey,
        contentKey: completedAction.contentKey || post?.contentKey || null,
        url: completedAction.finalUrl
            || completedAction.originalUrl
            || post?.url
            || getUrlForContentKeyForPlatform(platform, completedAction.contentKey),
        rowNumber: completedAction.rowNumber || post?.rowNumber || null,
        comment: completedAction.comment || post?.comment || null,
        status: 'done',
        phase: 'done',
        source: 'controller',
        error: null,
        completedAt: completedAction.completedAt || post?.completedAt || null,
        thumbnailUrl: completedAction.thumbnailUrl || post?.thumbnailUrl || null,
        updatedAt: completedAction.completedAt || post?.updatedAt || null,
    });
};

const isDashboardPostLive = post => {
    const session = browserSessions.get(normalizeAccountName(post?.accountKey || post?.account));
    if (!session) {
        return false;
    }

    const target = {
        contentKey: post.contentKey || null,
        rowNumber: post.rowNumber || null,
        url: post.url || null,
    };

    if (session.currentTask && session.page && !session.page.isClosed() && sameTaskTarget(session.currentTask, target)) {
        return true;
    }

    return (session.queuedActionTasks || []).some(task => sameTaskTarget(task, target));
};

const isQueuedDashboardPost = post => {
    const phase = String(post?.phase || '').trim().toLowerCase();
    return phase === 'queued'
        || Boolean(post?.queued)
        || Boolean(post?.queuedAt)
        || (normalizeDashboardStatus(post?.status) === 'running' && !post?.startedAt && post?.source === 'sheet');
};

const markStaleRunningDashboardPost = post => {
    if (normalizeDashboardStatus(post?.status || post?.phase) !== 'running') {
        return post;
    }
    if (isQueuedDashboardPost(post)) {
        return withActionState({
            ...post,
            status: 'running',
            phase: 'queued',
            error: null,
            completedAt: null,
        });
    }
    if (isDashboardPostLive(post)) {
        return post;
    }

    const updatedAt = Date.parse(post?.updatedAt || post?.startedAt || post?.createdAt || '') || 0;
    const ageMs = updatedAt ? Date.now() - updatedAt : DASHBOARD_RUNNING_STALE_MS + 1;
    if (ageMs < DASHBOARD_RUNNING_STALE_MS) {
        return post;
    }

    return withActionState({
        ...post,
        status: 'failed',
        phase: 'stalled',
        error: post.error || 'This action was left running, but no live browser session is active now. Rerun this row.',
        completedAt: null,
    });
};

const getDashboardPostsSummary = ({ platform = null } = {}) => {
    const requestedPlatform = normalizePlatform(platform);
    const history = readActionHistory();
    const posts = Object.entries(history.posts)
        .filter(([_postKey, post]) => !requestedPlatform || getItemPlatform(post) === requestedPlatform)
        .map(([postKey, post]) => {
            const completedAction = findTrustedCompletionForDashboardPost(history, post);
            if (completedAction) {
                return mergeCompletedActionIntoDashboardPost(post, completedAction, postKey);
            }

            const manualPhase = getManualActionPhase(post);
            if (manualPhase) {
                return withActionState({
                    ...post,
                    postKey,
                    status: 'running',
                    phase: manualPhase,
                    completedAt: null,
                });
            }

            const isDoneStatus = normalizeDashboardStatus(post.status || post.phase) === 'done';
            if (isDoneStatus) {
                return withActionState({
                    ...post,
                    postKey,
                    status: 'failed',
                    phase: 'unverified',
                    error: 'Previous Done status was not verified by a visible posted comment. Rerun this item.',
                    completedAt: null,
                });
            }

            return markStaleRunningDashboardPost({ ...post, postKey });
        });

    Object.entries(history.completed).forEach(([historyKey, completedAction]) => {
        if (!isTrustedCompletedAction(completedAction)) {
            return;
        }
        const completedPlatform = getItemPlatform(completedAction);
        if (requestedPlatform && completedPlatform !== requestedPlatform) {
            return;
        }

        const accountKey = completedAction.accountKey
            ? normalizeAccountName(completedAction.accountKey)
            : getPlatformAccountKey(completedPlatform, completedAction.account);
        if (posts.some(post => post.accountKey === accountKey && post.contentKey === completedAction.contentKey)) {
            return;
        }

        posts.push(withActionState({
            postKey: historyKey,
            platform: completedPlatform,
            account: completedAction.account || stripPlatformAccountKey(accountKey),
            accountKey,
            contentKey: completedAction.contentKey,
            url: completedAction.finalUrl
                || completedAction.originalUrl
                || getUrlForContentKeyForPlatform(completedPlatform, completedAction.contentKey),
            rowNumber: completedAction.rowNumber || null,
            comment: completedAction.comment || null,
            status: 'done',
            phase: 'done',
            source: 'history',
            completedAt: completedAction.completedAt || null,
            thumbnailUrl: completedAction.thumbnailUrl || null,
            createdAt: completedAction.completedAt || null,
            updatedAt: completedAction.completedAt || null,
        }));
    });

    return mergeDashboardSummaryDuplicates(posts)
        .map(withActionState)
        .filter(post => ['running', 'done', 'failed'].includes(normalizeDashboardStatus(post.status || post.phase)));
};

const appendActionEvent = event => {
    const history = readActionHistory();
    const platform = getItemPlatform(event);
    const accountKey = event.accountKey
        ? normalizeAccountName(event.accountKey)
        : getPlatformAccountKey(platform, event.account);
    const eventPhase = event.phase || event.action || event.status || null;
    const eventActionState = deriveActionState({ ...event, phase: eventPhase }) || null;
    const actionEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        time: event.time || new Date().toISOString(),
        platform,
        account: event.account || accountKey,
        accountKey,
        action: event.action || event.phase || 'update',
        status: event.status || event.phase || null,
        actionState: eventActionState,
        actionStateRank: getActionStateRank(eventActionState),
        contentKey: event.contentKey || null,
        rowNumber: event.rowNumber || null,
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

const formatConsoleTime = value => {
    try {
        return new Intl.DateTimeFormat('en-IN', {
            timeZone: INDIA_TIME_ZONE,
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).format(value ? new Date(value) : new Date());
    } catch (_error) {
        return new Date().toLocaleTimeString();
    }
};

const getActionConsoleMessage = event => {
    const pieces = [
        event.accountKey || event.account || 'account',
        event.rowNumber ? `row ${event.rowNumber}` : null,
        event.contentKey || null,
        `-> ${event.action || event.status || 'update'}`,
    ].filter(Boolean);
    const tail = event.error || event.message;
    return tail ? `${pieces.join(' ')} | ${tail}` : pieces.join(' ');
};

const logActionStatus = event => {
    if (!LOG_ACTIONS || !event) {
        return;
    }

    console.log(`[${formatConsoleTime(event.time)}] ${getActionConsoleMessage(event)}`);
};

const recordTaskEvent = (task, action, extra = {}) => {
    if (!task) {
        return null;
    }

    const platform = getItemPlatform(task);
    const taskUrl = task.originalUrl
        || task.finalUrl
        || getUrlForContentKeyForPlatform(platform, task.contentKey || task.requestedContentKey)
        || null;
    const phase = extra.phase || action;
    const status = extra.status || normalizeDashboardStatus(phase);
    const actionStateItem = withActionState({ ...task, status, phase });
    if (actionStateItem.actionState) {
        task.actionState = actionStateItem.actionState;
        task.actionStateRank = actionStateItem.actionStateRank;
    }
    upsertDashboardPost({
        platform,
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        contentKey: task.contentKey || task.requestedContentKey || null,
        rowNumber: task.rowNumber || null,
        url: taskUrl,
        comment: task.comment || null,
        status,
        phase,
        source: 'controller',
        error: extra.error || task.error || null,
        startedAt: task.startedAt || null,
        completedAt: extra.completedAt || task.completedAt || null,
        thumbnailUrl: extra.thumbnailUrl || task.thumbnailUrl || null,
        actionState: task.actionState || null,
    });

    const actionEvent = appendActionEvent({
        platform,
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        action,
        status,
        contentKey: task.contentKey || task.requestedContentKey || null,
        rowNumber: task.rowNumber || null,
        url: taskUrl,
        message: extra.message || null,
        error: extra.error || null,
    });
    logActionStatus(actionEvent);
    return actionEvent;
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

    const historyKey = getHistoryKey(task.accountKey, task.contentKey);
    const completedAction = {
        account: task.accountName || task.accountKey,
        contentKey: task.contentKey,
        rowNumber: task.rowNumber || null,
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

    const history = readActionHistory();
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
        rowNumber: task.rowNumber || null,
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
        ...completedActionSheetFields(task.completedAction),
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
    const isNewTask = !task;

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
    upsertDashboardPost({
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        contentKey: task.contentKey || task.requestedContentKey || null,
        rowNumber: task.rowNumber || null,
        url: task.originalUrl || getInstagramUrlForContentKey(task.contentKey || task.requestedContentKey),
        comment: task.comment || null,
        status: 'running',
        phase: 'queued',
        source: 'controller',
        queued: true,
        queuedAt: task.queuedAt,
        startedAt: null,
        completedAt: null,
        error: null,
    });
    if (isNewTask) {
        recordTaskEvent(task, 'queued', {
            status: 'running',
            message: 'Waiting for this account to finish its active action.',
        });
    }
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
    ...completedActionSheetFields(completedAction),
});

const getSheetStatusFields = ({ status, rowNumber = null, completedAction = null, error = null } = {}) => {
    const normalizedStatus = normalizeDashboardStatus(status);
    const finalRowNumber = rowNumber || completedAction?.rowNumber || null;
    const verifiedDone = normalizedStatus === 'done' && Boolean(completedAction?.verification?.visible);
    const sheetActionStatus = verifiedDone
        ? 'done'
        : normalizedStatus === 'failed'
            ? 'failed'
            : 'running';
    const sheetRun = verifiedDone ? 'no' : 'yes';
    const sheetErrorMessage = sheetActionStatus === 'failed' ? String(error || 'Action failed') : '';

    return {
        action_status: sheetActionStatus,
        run: sheetRun,
        error_message: sheetErrorMessage,
        completed_verified: verifiedDone,
        sheetShouldUpdate: Boolean(finalRowNumber),
        sheetRowNumber: finalRowNumber ? String(finalRowNumber) : null,
        sheetActionStatus,
        sheetRun,
        sheetErrorMessage,
        sheetCompletedVerified: verifiedDone,
        sheetCanMarkDone: verifiedDone,
        sheetCanMarkFailed: sheetActionStatus === 'failed',
        sheet: {
            shouldUpdate: Boolean(finalRowNumber),
            rowNumber: finalRowNumber ? String(finalRowNumber) : null,
            action_status: sheetActionStatus,
            run: sheetRun,
            error_message: sheetErrorMessage,
            completed_verified: verifiedDone,
        },
    };
};

const completedActionSheetFields = completedAction => getSheetStatusFields({
    status: 'done',
    rowNumber: completedAction?.rowNumber || null,
    completedAction,
});

const runningSheetFields = rowNumber => getSheetStatusFields({
    status: 'running',
    rowNumber,
});

const failedSheetFields = (rowNumber, error) => getSheetStatusFields({
    status: 'failed',
    rowNumber,
    error,
});

const queuedTaskResponse = (action, task, activeTask) => ({
    success: true,
    completed: false,
    queued: true,
    status: 'running',
    actionStatus: 'running',
    phase: 'queued',
    action,
    account: task.accountName || task.accountKey,
    contentKey: task.contentKey || task.requestedContentKey || null,
    rowNumber: task.rowNumber || null,
    queuedAt: task.queuedAt || null,
    ...runningSheetFields(task.rowNumber || null),
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
        ...runningSheetFields(pausedTask?.rowNumber || extra.rowNumber || null),
        phase,
        verificationRequired: phase !== 'login-needed' || extra.verificationRequired === true,
        loginRequired: phase === 'login-needed' || extra.loginRequired === true,
        browserVisible: Boolean(extra.browserVisible),
        message: extra.message || pausedTask?.error || null,
        next: extra.next || 'Finish the Instagram verification/login in the visible browser, then call POST /browser/save-session for this account.',
    };
};

const sendManualVerificationResponse = (res, action, errorOrTask, extra = {}) => {
    const task = ensurePausedTaskPhase(errorOrTask?.manualVerification ? (errorOrTask.task || getActiveTask()) : errorOrTask);
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

const createAutomaticLoginFailureError = message => {
    const error = new Error(message);
    error.disableManualFallback = true;
    error.automaticLoginFailure = true;
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

            const manualPhase = error?.disableManualFallback ? null : getManualActionPhase(error?.message);
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
    activeSession.intentionalBrowserClose = true;
    try {
        if (activeSession.browser) {
            await activeSession.browser.close().catch(error => {
                console.log(`Browser close failed for ${activeSession.accountName || activeSession.accountKey}: ${error.message}`);
            });
            console.log(`Browser closed for ${activeSession.accountName || activeSession.accountKey}.`);
        } else if (activeSession.context) {
            await activeSession.context.close().catch(error => {
                console.log(`Browser context close failed for ${activeSession.accountName || activeSession.accountKey}: ${error.message}`);
            });
            console.log(`Browser context closed for ${activeSession.accountName || activeSession.accountKey}.`);
        }
    } finally {
        activeSession.intentionalBrowserClose = false;
    }

    clearBrowserResources(activeSession);
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

const clearBrowserResources = session => {
    session.browser = null;
    session.context = null;
    session.page = null;
    session.browserVisibleForManualVerification = false;
};

const recordUnexpectedBrowserClose = (session, reason) => {
    clearBrowserResources(session);
    const task = session.currentTask;
    if (!task || isFinalTask(task)) {
        return;
    }

    const message = reason || 'Browser closed before the active action completed.';
    if (getItemPlatform(task) === 'x' && isManualVerificationTask(task)) {
        const pausedMessage = task.error || session.manualVerification?.message || message;
        task.error = pausedMessage;
        task.updatedAt = new Date().toISOString();
        session.manualVerification = session.manualVerification || {
            phase: task.phase || 'manual-verification',
            message: pausedMessage,
            blocker: task.verificationBlocker || null,
            stage: task.verificationStage || null,
            at: task.updatedAt,
        };
        recordTaskEvent(task, 'browser-closed', {
            status: 'running',
            error: pausedMessage,
            message: pausedMessage,
        });
        return;
    }

    task.phase = 'error';
    task.error = message;
    task.updatedAt = new Date().toISOString();
    task.verificationRequired = false;
    task.loginRequired = false;
    task.verificationStage = null;
    task.verificationBlocker = null;
    session.manualVerification = null;
    recordTaskEvent(task, 'browser-closed', {
        status: 'failed',
        error: message,
        message,
    });

    if (task.contentKey || task.requestedContentKey || task.rowNumber || task.originalUrl || task.finalUrl) {
        const platform = getItemPlatform(task);
        upsertDashboardPost({
            platform,
            account: task.accountName || task.accountKey || session.accountName || session.accountKey,
            accountKey: task.accountKey || session.accountKey,
            contentKey: task.contentKey || task.requestedContentKey || null,
            rowNumber: task.rowNumber || null,
            url: getTaskTargetUrl(task),
            status: 'failed',
            phase: 'error',
            error: message,
            startedAt: task.startedAt || null,
            completedAt: null,
        });
    }
};

const installBrowserLifecycleHandlers = session => {
    const browserRef = session.browser;
    const pageRef = session.page;
    if (browserRef?.on) {
        browserRef.on('disconnected', () => {
            if (session.browser !== browserRef) {
                return;
            }
            const intentionalClose = Boolean(session.intentionalBrowserClose);
            clearBrowserResources(session);
            if (!intentionalClose) {
                recordUnexpectedBrowserClose(session, 'Browser disconnected before the active action completed.');
            }
        });
    }

    if (pageRef?.on) {
        pageRef.on('close', () => {
            if (session.page !== pageRef) {
                return;
            }
            session.page = null;
            session.browserVisibleForManualVerification = false;
            if (!session.intentionalBrowserClose) {
                recordUnexpectedBrowserClose(session, 'Page closed before the active action completed.');
            }
        });
    }
};

const launchBrowser = async (storageState, options = {}) => {
    const activeSession = getActiveBrowserSession();
    const launchArgs = [`--window-size=${BROWSER_WINDOW_WIDTH},${BROWSER_WINDOW_HEIGHT}`];
    if (HIDE_BROWSER_WINDOWS) {
        launchArgs.push('--window-position=-32000,-32000');
    }

    if (options.systemBrowserProfile || options.systemChromeProfile) {
        const browserChannel = String(options.browserChannel || X_SYSTEM_BROWSER_CHANNEL).trim().toLowerCase();
        const browserName = browserChannel === 'chrome' ? 'Chrome' : 'Edge';
        const defaultUserDataDir = browserChannel === 'chrome' ? DEFAULT_CHROME_USER_DATA_DIR : DEFAULT_X_EDGE_USER_DATA_DIR;
        const defaultProfileDirectory = browserChannel === 'chrome' ? DEFAULT_CHROME_PROFILE_DIRECTORY : DEFAULT_EDGE_PROFILE_DIRECTORY;
        const userDataDir = path.resolve(options.userDataDir || options.chromeUserDataDir || defaultUserDataDir);
        const profileDirectory = String(options.profileDirectory || options.chromeProfileDirectory || defaultProfileDirectory).trim() || defaultProfileDirectory;
        const canCreateProfile = Boolean(options.allowCreateProfile)
            || (browserChannel !== 'chrome' && path.resolve(userDataDir) === path.resolve(DEDICATED_X_EDGE_USER_DATA_DIR));
        if (!fs.existsSync(userDataDir)) {
            if (!canCreateProfile) {
                throw new Error(`${browserName} user data directory not found: ${userDataDir}`);
            }
            fs.mkdirSync(userDataDir, { recursive: true });
        }
        if (!fs.existsSync(path.join(userDataDir, profileDirectory))) {
            if (!canCreateProfile) {
                throw new Error(`${browserName} profile "${profileDirectory}" not found inside ${userDataDir}`);
            }
            fs.mkdirSync(path.join(userDataDir, profileDirectory), { recursive: true });
        }
        activeSession.context = await chromium.launchPersistentContext(userDataDir, {
            channel: browserChannel,
            headless: false,
            viewport: BROWSER_VIEWPORT,
            args: [
                `--profile-directory=${profileDirectory}`,
                `--window-size=${BROWSER_WINDOW_WIDTH},${BROWSER_WINDOW_HEIGHT}`,
                ...(HIDE_BROWSER_WINDOWS ? ['--window-position=-32000,-32000'] : []),
            ],
        }).catch(error => {
            if (/ProcessSingleton|profile.*in use|user data directory is already in use|cannot create default profile/i.test(error.message || '')) {
                throw new Error(`${browserName} profile "${profileDirectory}" is already open. Close all ${browserName} windows first, then rerun X.`);
            }
            throw error;
        });
        activeSession.browser = activeSession.context.browser();
        activeSession.usesSystemBrowserProfile = true;
        activeSession.systemBrowserChannel = browserChannel;
        activeSession.systemBrowserName = browserName;
        activeSession.systemUserDataDir = userDataDir;
        activeSession.systemProfileDirectory = profileDirectory;
    } else {
        activeSession.browser = await chromium.launch({
            headless: HEADLESS,
            args: launchArgs,
        });

        activeSession.context = await activeSession.browser.newContext({
            ...(storageState ? { storageState } : {}),
            viewport: BROWSER_VIEWPORT,
        });
        activeSession.usesSystemBrowserProfile = false;
        activeSession.systemBrowserChannel = null;
        activeSession.systemBrowserName = null;
        activeSession.systemUserDataDir = null;
        activeSession.systemProfileDirectory = null;
    }
    activeSession.page = await activeSession.context.newPage();
    installBrowserLifecycleHandlers(activeSession);
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
    if (!isPageOpen()) {
        return false;
    }

    for (const label of labels) {
        const getByRole = page.getByRole;
        if (typeof getByRole === 'function') {
            const button = getByRole('button', { name: label }).first();
            if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
                await button.click().catch(() => null);
                await wait(1000);
                return true;
            }
        }
    }

    const evaluate = page.evaluate;
    if (typeof evaluate !== 'function') {
        return false;
    }

    return evaluate(patternSources => {
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

const firstPageRoleLocator = (role, options) => (
    typeof page.getByRole === 'function' ? page.getByRole(role, options).first() : null
);

const firstPageTextLocator = (text, options) => (
    typeof page.getByText === 'function' ? page.getByText(text, options).first() : null
);

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

const closeCommentPanelIfOpen = async () => {
    const panel = await page.evaluate(() => {
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
        const rectToObject = rect => ({
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        });

        const panels = Array.from(document.querySelectorAll('[role="dialog"], aside, section'))
            .filter(isVisible)
            .map(element => ({ element, text: normalize(element.textContent), rect: element.getBoundingClientRect() }))
            .filter(candidate => (
                /comments|add a comment|comment as|post/i.test(candidate.text)
                && !/new message|your messages|send message to start a chat|\bto:\s*search/i.test(candidate.text)
                && candidate.rect.width >= 180
                && candidate.rect.height >= 180
            ))
            .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

        const commentPanel = panels[0];
        if (!commentPanel) {
            return null;
        }

        const { element, rect } = commentPanel;
        const closeTarget = Array.from(element.querySelectorAll('button, [role="button"], svg, div, span'))
            .filter(isVisible)
            .map(candidate => {
                const candidateRect = candidate.getBoundingClientRect();
                const label = normalize([
                    candidate.getAttribute('aria-label'),
                    candidate.getAttribute('title'),
                    candidate.textContent,
                ].filter(Boolean).join(' '));
                const nearTopRight = candidateRect.width <= 48
                    && candidateRect.height <= 48
                    && candidateRect.left >= rect.right - 96
                    && candidateRect.top <= rect.top + 96;
                return {
                    element: candidate.closest('button, [role="button"]') || candidate,
                    rect: candidateRect,
                    label,
                    nearTopRight,
                };
            })
            .filter(candidate => /close|cancel|back/i.test(candidate.label) || candidate.nearTopRight)
            .sort((a, b) => {
                const labelScore = Number(/close/i.test(b.label)) - Number(/close/i.test(a.label));
                if (labelScore) {
                    return labelScore;
                }
                return b.rect.left - a.rect.left || a.rect.top - b.rect.top;
            })[0];

        if (closeTarget) {
            const closeRect = closeTarget.rect;
            return {
                panelRect: rectToObject(rect),
                closeRect: rectToObject(closeRect),
            };
        }

        return {
            panelRect: rectToObject(rect),
            closeRect: {
                left: Math.max(0, rect.right - 36),
                top: Math.max(0, rect.top + 8),
                right: Math.max(0, rect.right),
                bottom: Math.max(0, rect.top + 44),
                width: 36,
                height: 36,
            },
        };
    }).catch(() => null);

    if (!panel?.panelRect) {
        await page.keyboard.press('Escape').catch(() => null);
        await wait(500);
        return false;
    }

    const closeRect = panel.closeRect || panel.panelRect;
    await page.mouse.click(
        closeRect.left + Math.max(6, closeRect.width / 2),
        closeRect.top + Math.max(6, closeRect.height / 2),
    ).catch(() => null);
    await wait(800);
    await page.keyboard.press('Escape').catch(() => null);
    await wait(700);
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
        firstPageRoleLocator('link', { name: /^log in$/i }),
        firstPageRoleLocator('link', { name: /log in/i }),
        firstPageRoleLocator('button', { name: /^log in$/i }),
        firstPageRoleLocator('button', { name: /log in/i }),
        firstPageTextLocator(/^log in$/i),
        firstPageTextLocator(/log in/i),
        page.locator('button').filter({ hasText: /^log in$/i }).first(),
        page.locator('div[role="button"]').filter({ hasText: /^log in$/i }).first(),
        page.locator('[role="link"]').filter({ hasText: /log in/i }).first(),
        page.locator('[tabindex]').filter({ hasText: /^log in$/i }).first(),
        page.locator('a').filter({ hasText: /log in or sign up/i }).first(),
        page.locator('a').filter({ hasText: /^log in$/i }).first(),
        firstPageRoleLocator('link', { name: /log in or sign up/i }),
        firstPageRoleLocator('button', { name: /log in or sign up/i }),
        firstPageRoleLocator('link', { name: /^log in$/i }),
    ].filter(Boolean);

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
        firstPageRoleLocator('button', { name: /^log in$/i }),
        page.locator('div[role="button"]').filter({ hasText: /^log in$/i }).first(),
    ].filter(Boolean);

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

const clickLoginSubmitFallback = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const clicked = await page.evaluate(() => {
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

            const candidates = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex]'))
                .filter(isVisible)
                .filter(element => element.getAttribute('aria-disabled') !== 'true' && !element.disabled)
                .map(element => ({
                    element,
                    text: normalize([
                        element.getAttribute('aria-label'),
                        element.getAttribute('title'),
                        element.textContent,
                    ].filter(Boolean).join(' ')),
                    rect: element.getBoundingClientRect(),
                    type: normalize(element.getAttribute('type')),
                }))
                .filter(candidate => candidate.type === 'submit' || candidate.text === 'log in' || candidate.text === 'login')
                .sort((a, b) => {
                    const score = candidate => (
                        (candidate.type === 'submit' ? -200 : 0)
                        + (candidate.text === 'log in' ? -100 : 0)
                        + Math.min(candidate.rect.width * candidate.rect.height, 10000) / 100
                    );
                    return score(a) - score(b) || a.rect.top - b.rect.top || a.rect.left - b.rect.left;
                });

            const target = candidates[0]?.element;
            if (!target) {
                return false;
            }
            target.click();
            return true;
        }).catch(() => false);

        if (clicked) {
            return true;
        }
        await wait(500);
    }

    return false;
};

const getLoginFieldStateByDom = async ({ accountName = '', password = '' } = {}) => {
    return page.evaluate(({ accountName, password }) => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const normalizeAccount = value => normalize(value).replace(/^@/, '');
        const isVisible = element => {
            if (!element || !(element instanceof HTMLInputElement)) {
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
        const getInputText = input => normalize([
            input.name,
            input.id,
            input.type,
            input.placeholder,
            input.getAttribute('aria-label'),
            input.autocomplete,
        ].filter(Boolean).join(' '));
        const getFieldSummary = field => ({
            index: field.index,
            type: field.type || '',
            name: field.name || '',
            placeholder: field.placeholder || '',
            autocomplete: field.autocomplete || '',
            ariaLabel: field.ariaLabel || '',
            top: field.rect.top,
            left: field.rect.left,
            width: field.rect.width,
            height: field.rect.height,
        });

        const fields = Array.from(document.querySelectorAll('input'))
            .filter(isVisible)
            .map((input, index) => {
                const rect = input.getBoundingClientRect();
                return {
                    input,
                    index,
                    type: normalize(input.getAttribute('type') || 'text'),
                    name: input.getAttribute('name') || '',
                    placeholder: input.getAttribute('placeholder') || '',
                    ariaLabel: input.getAttribute('aria-label') || '',
                    autocomplete: normalize(input.getAttribute('autocomplete') || ''),
                    text: getInputText(input),
                    value: input.value || '',
                    disabled: Boolean(input.disabled),
                    readOnly: Boolean(input.readOnly),
                    rect: rectToObject(rect),
                };
            });

        const inputSummaries = fields.map(getFieldSummary);
        const isTextLike = field => ['', 'text', 'email', 'tel'].includes(field.type);
        const passwordCandidates = fields
            .map(field => {
                let score = 0;
                if (field.disabled || field.readOnly) {
                    score -= 1000;
                }
                if (field.type === 'password') {
                    score += 300;
                }
                if (/password|\bpass\b|current-password/.test(field.text)) {
                    score += 140;
                }
                if (field.autocomplete === 'current-password') {
                    score += 90;
                }
                if (/webauthn|one-time-code|otp|search|verification/.test(field.text)) {
                    score -= 250;
                }
                return { field, score };
            })
            .filter(candidate => candidate.score > 0)
            .sort((a, b) => b.score - a.score || a.field.rect.top - b.field.rect.top || a.field.index - b.field.index);

        const passwordField = passwordCandidates[0]?.field || null;
        const usernameCandidates = fields
            .filter(field => field.input !== passwordField?.input && field.type !== 'password')
            .map(field => {
                let score = 0;
                if (field.disabled || field.readOnly) {
                    score -= 1000;
                }
                if (isTextLike(field)) {
                    score += 45;
                } else {
                    score -= 100;
                }
                if (/username|email|e-mail|mobile|phone/.test(field.text)) {
                    score += 170;
                }
                if (/\blogin\b|\buser\b/.test(field.text)) {
                    score += 70;
                }
                if (field.autocomplete === 'username') {
                    score += 170;
                }
                if (['email', 'tel'].includes(field.autocomplete)) {
                    score += 90;
                }
                if (/webauthn|one-time-code|otp|search|verification|captcha/.test(field.text)) {
                    score -= 250;
                }
                if (accountName && normalizeAccount(field.value) === normalizeAccount(accountName)) {
                    score += 100;
                }
                if (passwordField) {
                    const distanceFromPassword = Math.abs(field.rect.top - passwordField.rect.top);
                    if (field.rect.top <= passwordField.rect.top + 4) {
                        score += 70;
                    } else {
                        score -= 120;
                    }
                    score -= Math.min(distanceFromPassword, 320) / 8;
                }
                return { field, score };
            })
            .filter(candidate => candidate.score > 20)
            .sort((a, b) => {
                if (b.score !== a.score) {
                    return b.score - a.score;
                }
                if (passwordField) {
                    return Math.abs(a.field.rect.top - passwordField.rect.top)
                        - Math.abs(b.field.rect.top - passwordField.rect.top);
                }
                return a.field.index - b.field.index;
            });

        const usernameField = usernameCandidates[0]?.field || null;
        const usernameValue = usernameField?.value || '';
        const passwordValue = passwordField?.value || '';
        const expectedAccount = normalizeAccount(accountName);
        const success = Boolean(usernameField && passwordField && usernameField.input !== passwordField.input);

        return {
            success,
            usernameIndex: usernameField?.index ?? null,
            passwordIndex: passwordField?.index ?? null,
            usernameRect: usernameField ? usernameField.rect : null,
            passwordRect: passwordField ? passwordField.rect : null,
            usernameValueLength: usernameValue.length,
            passwordValueLength: passwordValue.length,
            usernameMatchesExpected: Boolean(success && expectedAccount && normalizeAccount(usernameValue) === expectedAccount),
            passwordMatchesExpected: Boolean(success && password && passwordValue === password),
            usernameContainsPassword: Boolean(success && password && usernameValue.includes(password)),
            inputs: inputSummaries,
        };
    }, { accountName, password }).catch(error => ({ success: false, error: error.message }));
};

const setLoginFieldsByDomIndex = async ({ usernameIndex, passwordIndex, accountName, password }) => {
    return page.evaluate(({ usernameIndex, passwordIndex, accountName, password }) => {
        const isVisible = element => {
            if (!element || !(element instanceof HTMLInputElement)) {
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
        const setNativeValue = (input, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            input.focus();
            if (setter) {
                setter.call(input, value);
            } else {
                input.value = value;
            }
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
        const usernameInput = inputs[usernameIndex];
        const passwordInput = inputs[passwordIndex];

        if (!usernameInput || !passwordInput || usernameInput === passwordInput) {
            return {
                success: false,
                inputs: inputs.map(input => ({
                    type: input.type || '',
                    name: input.name || '',
                    placeholder: input.placeholder || '',
                    autocomplete: input.autocomplete || '',
                })),
            };
        }

        setNativeValue(usernameInput, accountName);
        setNativeValue(passwordInput, password);
        return {
            success: true,
        };
    }, { usernameIndex, passwordIndex, accountName, password }).catch(error => ({ success: false, error: error.message }));
};

const clearLoginFieldsByDom = async () => {
    return page.evaluate(() => {
        const isVisible = element => {
            if (!element || !(element instanceof HTMLInputElement)) {
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
        const setNativeValue = input => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            input.focus();
            if (setter) {
                setter.call(input, '');
            } else {
                input.value = '';
            }
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        const loginFieldPattern = /username|email|e-mail|mobile|phone|login|password|\bpass\b/i;
        Array.from(document.querySelectorAll('input'))
            .filter(isVisible)
            .filter(input => {
                const type = (input.getAttribute('type') || 'text').toLowerCase();
                const text = [
                    input.name,
                    input.id,
                    input.placeholder,
                    input.getAttribute('aria-label'),
                    input.autocomplete,
                ].filter(Boolean).join(' ');
                return ['text', 'email', 'tel', 'password', ''].includes(type) || loginFieldPattern.test(text);
            })
            .forEach(setNativeValue);

        return true;
    }).catch(() => false);
};

const verifyLoginFieldsBeforeSubmit = async ({ accountName, password, strategy }) => {
    let state = null;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        state = await getLoginFieldStateByDom({ accountName, password });
        if (state.success && state.usernameMatchesExpected && state.passwordMatchesExpected && !state.usernameContainsPassword) {
            return { success: true, state };
        }
        await wait(250);
    }

    const issues = [];
    if (!state?.success) {
        issues.push('login fields not identified');
    }
    if (!state?.usernameMatchesExpected) {
        issues.push(`username mismatch (length ${state?.usernameValueLength ?? 0})`);
    }
    if (!state?.passwordMatchesExpected) {
        issues.push(`password mismatch (length ${state?.passwordValueLength ?? 0})`);
    }
    if (state?.usernameContainsPassword) {
        issues.push('password text appeared in username field');
    }

    const error = `${strategy} did not place credentials into the expected login fields: ${issues.join(', ') || 'unknown issue'}`;
    console.log(`Blocked Instagram login submit for ${accountName}: ${error}.`);
    return { success: false, state, error };
};

const fillLoginInputsByDom = async ({ accountName, password }) => {
    const state = await getLoginFieldStateByDom({ accountName, password });
    if (!state.success) {
        return state;
    }

    const result = await setLoginFieldsByDomIndex({
        usernameIndex: state.usernameIndex,
        passwordIndex: state.passwordIndex,
        accountName,
        password,
    });

    if (!result.success) {
        return result;
    }

    await wait(500);
    const verification = await verifyLoginFieldsBeforeSubmit({ accountName, password, strategy: 'DOM login fill' });
    if (!verification.success) {
        await clearLoginFieldsByDom();
        return {
            success: false,
            error: verification.error,
            inputs: verification.state?.inputs || state.inputs,
        };
    }

    await wait(300);
    const clickedSubmit = await clickLoginSubmitFallback();
    if (!clickedSubmit) {
        await page.keyboard.press('Enter').catch(() => null);
    }
    return { ...result, clickedSubmit, strategy: 'dom' };
};

const getLoginInputRectsByDom = async () => {
    const state = await getLoginFieldStateByDom();
    if (!state.success) {
        return state;
    }

    return {
        success: true,
        usernameRect: state.usernameRect,
        passwordRect: state.passwordRect,
        usernameIndex: state.usernameIndex,
        passwordIndex: state.passwordIndex,
        inputs: state.inputs,
    };
};

const fillLoginInputsByKeyboardFallback = async ({ accountName, password }) => {
    const result = await getLoginInputRectsByDom();
    if (!result.success) {
        return result;
    }

    await clearLoginFieldsByDom();

    const typeIntoRect = async (rect, value, expectedIndex, label) => {
        await page.mouse.click(rect.left + Math.min(Math.max(rect.width * 0.08, 18), rect.width / 2), rect.top + rect.height / 2);
        await wait(250);
        const focusedExpectedInput = await page.evaluate(({ expectedIndex }) => {
            const isVisible = element => {
                if (!element || !(element instanceof HTMLInputElement)) {
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
            const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
            return inputs[expectedIndex] === document.activeElement;
        }, { expectedIndex }).catch(() => false);

        if (!focusedExpectedInput) {
            throw new Error(`Keyboard fallback could not focus the ${label} input safely.`);
        }

        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
        await page.keyboard.type(String(value), { delay: 25 });
        await wait(250);
    };

    try {
        await typeIntoRect(result.usernameRect, accountName, result.usernameIndex, 'username');
        const usernameCheck = await getLoginFieldStateByDom({ accountName, password: '' });
        if (!usernameCheck.success || !usernameCheck.usernameMatchesExpected) {
            await clearLoginFieldsByDom();
            return {
                success: false,
                error: 'Keyboard fallback typed into the wrong username field.',
                inputs: usernameCheck.inputs || result.inputs,
            };
        }

        await typeIntoRect(result.passwordRect, password, result.passwordIndex, 'password');
    } catch (error) {
        await clearLoginFieldsByDom();
        return {
            success: false,
            error: error.message,
            inputs: result.inputs,
        };
    }

    await wait(500);
    const verification = await verifyLoginFieldsBeforeSubmit({ accountName, password, strategy: 'Keyboard login fill' });
    if (!verification.success) {
        await clearLoginFieldsByDom();
        return {
            success: false,
            error: verification.error,
            inputs: verification.state?.inputs || result.inputs,
        };
    }

    await wait(300);
    const clickedSubmit = await clickLoginSubmitFallback();
    if (!clickedSubmit) {
        await page.keyboard.press('Enter').catch(() => null);
    }

    return {
        success: true,
        strategy: 'keyboard',
        clickedSubmit,
    };
};


const fillAndSubmitLoginForm = async ({ accountName, password }) => {
    let lastError = null;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        const { usernameInput, passwordInput } = await getLoginInputs();

        if (!usernameInput || !passwordInput) {
            const visibleInputs = await getVisibleInputDetails();
            const domFillResult = await fillLoginInputsByDom({ accountName, password });
            if (domFillResult.success) {
                console.log(`Filled Instagram login form through DOM fallback for ${accountName}. Submit clicked: ${Boolean(domFillResult.clickedSubmit)}.`);
                return;
            }
            const keyboardFillResult = await fillLoginInputsByKeyboardFallback({ accountName, password });
            if (keyboardFillResult.success) {
                console.log(`Filled Instagram login form through keyboard fallback for ${accountName}. Submit clicked: ${Boolean(keyboardFillResult.clickedSubmit)}.`);
                return;
            }
            lastError = new Error(`Could not find visible Instagram username/password inputs. Visible inputs: ${JSON.stringify(visibleInputs)}`);
            await wait(1200);
            continue;
        }

        try {
            await usernameInput.fill(accountName, { timeout: 7000 });
            await wait(400);
            await passwordInput.fill(password, { timeout: 7000 });
            await wait(500);
            const verification = await verifyLoginFieldsBeforeSubmit({ accountName, password, strategy: 'Locator login fill' });
            if (!verification.success) {
                await clearLoginFieldsByDom();
                const domFillResult = await fillLoginInputsByDom({ accountName, password });
                if (domFillResult.success) {
                    console.log(`Filled Instagram login form through verified DOM fallback for ${accountName}. Submit clicked: ${Boolean(domFillResult.clickedSubmit)}.`);
                    return;
                }
                const keyboardFillResult = await fillLoginInputsByKeyboardFallback({ accountName, password });
                if (keyboardFillResult.success) {
                    console.log(`Filled Instagram login form through verified keyboard fallback for ${accountName}. Submit clicked: ${Boolean(keyboardFillResult.clickedSubmit)}.`);
                    return;
                }
                throw new Error(verification.error);
            }

            await wait(300);
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

const getVisibleInstagramLoginError = async () => {
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    return bodyText
        .split('\n')
        .map(line => line.trim())
        .find(line => /incorrect|wrong|couldn'?t|try again|problem|challenge|suspicious|disabled|locked/i.test(line))
        || null;
};

const submitCredentialsOnAnyLoginSurface = async ({ accountName, password, stage = 'login' }) => {
    let lastError = null;

    for (let attempt = 1; attempt <= 8; attempt += 1) {
        await dismissInstagramDialogs();
        await throwIfInstagramBlocked(stage);

        if (!await isLoginFormVisible()) {
            const clicked = await clickLoginEntryPoint();
            if (!clicked || attempt % 2 === 0) {
                await page.goto(INSTAGRAM_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
                    lastError = error;
                    console.log(`Could not reopen Instagram login on attempt ${attempt}: ${error.message}`);
                });
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
            await wait(1600);
            await dismissInstagramDialogs();
        }

        try {
            await fillAndSubmitLoginForm({ accountName, password });
            return;
        } catch (error) {
            lastError = error;
            console.log(`Credential login attempt ${attempt} failed for ${accountName}: ${error.message}`);
            const visibleError = await getVisibleInstagramLoginError();
            if (visibleError) {
                throw createAutomaticLoginFailureError(`Instagram rejected automatic login for "${accountName}": ${visibleError}`);
            }
            await wait(1200);
        }
    }

    throw createAutomaticLoginFailureError(
        `Automatic login could not find a usable Instagram username/password form for "${accountName}" after retrying. Last error: ${lastError?.message || 'none'}`,
    );
};

const confirmCredentialLoginCompleted = async ({ accountName, stage = 'login' }) => {
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => null);
    await wait(8000);
    await dismissInstagramDialogs();

    const blocker = await getInstagramBlocker();
    if (blocker) {
        const task = await markCurrentTaskPaused({
            phase: 'manual-verification',
            blocker,
            stage,
        });
        throw createManualVerificationError({ stage, blocker, task });
    }

    if (await isLoggedIn()) {
        return;
    }

    const loginError = await getVisibleInstagramLoginError();
    throw createAutomaticLoginFailureError(
        loginError
            ? `Instagram rejected automatic login for "${accountName}": ${loginError}`
            : `Automatic login submitted credentials for "${accountName}", but Instagram did not create a logged-in session.`,
    );
};

const submitCredentialsAndConfirmLogin = async ({ accountName, password, stage = 'login', maxAttempts = 3 }) => {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await submitCredentialsOnAnyLoginSurface({ accountName, password, stage });
            await confirmCredentialLoginCompleted({ accountName, stage });
            return true;
        } catch (error) {
            lastError = error;
            if (error?.manualVerification) {
                throw error;
            }

            const visibleError = await getVisibleInstagramLoginError();
            const loginFormVisible = await isLoginFormVisible().catch(() => false);
            const retryableBlankLoginForm = error?.automaticLoginFailure
                && /did not create a logged-in session/i.test(error.message)
                && loginFormVisible
                && !visibleError;

            if (!retryableBlankLoginForm || attempt >= maxAttempts) {
                throw error;
            }

            console.log(`Instagram returned ${accountName} to a blank login form after submit; retrying credential entry (${attempt + 1}/${maxAttempts}).`);
            await wait(1800);
        }
    }

    throw lastError || createAutomaticLoginFailureError(`Automatic login did not complete for "${accountName}".`);
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
        await submitCredentialsAndConfirmLogin({ accountName, password, stage: 'login' });
    } catch (error) {
        if (error?.manualVerification) {
            throw error;
        }
        throw error.disableManualFallback
            ? error
            : createAutomaticLoginFailureError(`Automatic login could not submit credentials for "${accountName}": ${error.message}`);
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
        await submitCredentialsAndConfirmLogin({
            accountName: session.accountName || session.accountKey,
            password,
            stage,
        });
    } catch (error) {
        if (error?.manualVerification) {
            throw error;
        }
        throw error.disableManualFallback
            ? error
            : createAutomaticLoginFailureError(`Automatic login could not submit credentials for "${session.accountName || session.accountKey}": ${error.message}`);
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

const isRealCommentComposerResult = composer => Boolean(composer && composer.source === 'input');
const isCommentComposerHint = composer => Boolean(composer && ['placeholder', 'dialog-bottom'].includes(composer.source));

const clickCommentComposer = async () => {
    const composer = await findVisibleCommentComposer();

    if (composer) {
        const x = composer.source === 'input'
            ? composer.rect.left + composer.rect.width / 2
            : composer.rect.left + Math.min(52, Math.max(14, composer.rect.width * 0.22));
        const y = composer.rect.top + composer.rect.height / 2;
        await page.mouse.click(x, y);
        await wait(isCommentComposerHint(composer) ? 900 : 350);
        const clickedComposer = await findVisibleCommentComposer().catch(() => null);
        if (isRealCommentComposerResult(clickedComposer)) {
            return clickedComposer;
        }
        if (isRealCommentComposerResult(composer)) {
            return composer;
        }
        throw new Error(`Comment composer is only a non-editable ${composer.source} hint, not a real input yet.`);
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
    await wait(900);

    const clickedComposer = await findVisibleCommentComposer().catch(() => null);
    if (isRealCommentComposerResult(clickedComposer)) {
        return clickedComposer;
    }

    throw new Error('Add a comment placeholder is visible, but Instagram has not opened a real editable comment input yet.');
};

const waitForCommentComposer = async (timeoutMs = 12000, options = {}) => {
    const deadline = Date.now() + timeoutMs;
    const returnHintAfterMs = Number(options.returnHintAfterMs) || 0;
    let fallbackComposer = null;
    let fallbackSeenAt = null;
    const fallbackDelayMs = Math.min(5000, Math.max(1500, Math.floor(timeoutMs * 0.18)));

    while (Date.now() < deadline) {
        const composer = await findVisibleCommentComposer();
        if (composer) {
            if (isRealCommentComposerResult(composer)) {
                return composer;
            }

            if (isCommentComposerHint(composer)) {
                fallbackComposer = composer;
                fallbackSeenAt = fallbackSeenAt || Date.now();
                if (returnHintAfterMs && Date.now() - fallbackSeenAt >= returnHintAfterMs) {
                    return {
                        ...composer,
                        staleHint: true,
                    };
                }
                if (Date.now() - fallbackSeenAt >= fallbackDelayMs) {
                    await page.mouse.click(
                        composer.rect.left + Math.min(52, Math.max(14, composer.rect.width * 0.22)),
                        composer.rect.top + composer.rect.height / 2,
                    ).catch(() => null);
                    fallbackSeenAt = Date.now();
                }
            }
        }

        await wait(500);
    }

    return null;
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

        const waitMs = Math.max(COMMENT_COMPOSER_OPEN_WAIT_MS, 50000);
        const hintRetryMs = Math.min(COMMENT_COMPOSER_HINT_RETRY_MS, waitMs);
        const waitStartedAt = Date.now();
        const composer = await waitForCommentComposer(waitMs, { returnHintAfterMs: hintRetryMs });
        const waitedMs = Date.now() - waitStartedAt;
        if (isRealCommentComposerResult(composer)) {
            return { alreadyOpen: false, composer, commentButton };
        }

        if (composer?.staleHint) {
            console.log(`Comment composer stayed as non-editable ${composer.source} hint for ${hintRetryMs}ms; closing and retrying.`);
        }
        console.log(`Comment panel/input still not ready for ${activeTask?.accountName || activeTask?.accountKey || 'account'} after ${waitedMs}ms on attempt ${attempt}.`);
        await closeCommentPanelIfOpen();
        await wait(1800);
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
        logDebug(`Visible comment input value after direct DOM fill: "${value}". DOM result: ${JSON.stringify(domFillResult)}`);

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
        logDebug(`Visible comment input value after direct fill: "${value}"`);

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
        logDebug(`Visible comment input value after locator fill: "${value}"`);

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
        logDebug(`Clicked comment composer attempt ${attempt}: ${JSON.stringify(composer)}`);
        await wait(900);

        await clearPageTextSelection();
        const domFillResult = await setCommentComposerValue(comment);
        await wait(1000);
        await clearPageTextSelection();
        lastValue = await getVisibleCommentComposerValue();
        logDebug(`Visible comment box value after DOM fill attempt ${attempt}: "${lastValue}". DOM result: ${JSON.stringify(domFillResult)}`);

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
            if (composer?.source === 'dialog-bottom' && !normalizeCommentValue(lastValue)) {
                await page.mouse.click(
                    composer.rect.left + Math.min(52, Math.max(14, composer.rect.width * 0.22)),
                    composer.rect.top + composer.rect.height / 2,
                );
                await wait(350);
                await page.keyboard.insertText(comment);
                await wait(900);
                lastValue = await getVisibleCommentComposerValue();
                logDebug(`Visible comment box value after dialog-bottom keyboard attempt ${attempt}: "${lastValue}"`);

                if (commentValueEquals(lastValue, comment)) {
                    await clearPageTextSelection();
                    return composer.rect;
                }
            }

            console.log(`Skipping keyboard fill attempt ${attempt}; active element is not a verified comment composer.`);
            continue;
        }

        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText(comment);
        await wait(1200);

        lastValue = await getVisibleCommentComposerValue();
        logDebug(`Visible comment box value after keyboard attempt ${attempt}: "${lastValue}"`);

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

const waitForPostActionButton = async (label, timeoutMs = 12000) => {
    const startedAt = Date.now();
    let lastButton = null;

    while (Date.now() - startedAt < timeoutMs) {
        lastButton = await findPostActionButton(label);
        if (lastButton) {
            return lastButton;
        }

        await wait(600);
    }

    return lastButton;
};

const verifyLikedOrContinue = async (session, task, stage = 'like') => {
    const verifiedUnlike = await waitForPostActionButton('Unlike', 14000);
    if (verifiedUnlike) {
        if (task) {
            task.likeButtonRect = verifiedUnlike.clickRect;
            task.likeVerification = {
                verified: true,
                stage,
                at: new Date().toISOString(),
            };
        }
        return verifiedUnlike;
    }

    const visibleLike = await findPostActionButton('Like');
    const message = visibleLike
        ? `${stage}: Instagram still shows Like after click; continuing to comment and using comment visibility as final proof.`
        : `${stage}: Instagram did not expose Like/Unlike after click; continuing to comment and using comment visibility as final proof.`;
    console.log(`${message} Account: ${session.accountName || session.accountKey}.`);
    if (task) {
        task.likeVerification = {
            verified: false,
            warning: message,
            stage,
            at: new Date().toISOString(),
        };
        task.warning = message;
        task.updatedAt = new Date().toISOString();
    }

    return null;
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
    const platform = getItemPlatform(task);
    return task?.originalUrl
        || task?.finalUrl
        || getUrlForContentKeyForPlatform(platform, task?.contentKey || task?.requestedContentKey);
};

const getTaskActionDefaults = (task, overrides = {}) => {
    const platform = getItemPlatform({ ...task, ...overrides });
    const url = overrides.url || getTaskTargetUrl(task) || null;
    const contentKey = overrides.contentKey
        || task?.contentKey
        || task?.requestedContentKey
        || getContentKeyForPlatform(platform, url)
        || null;

    return {
        platform,
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

const isClosedBrowserError = error => /target page.*closed|target .*closed|context.*closed|browser.*closed|page.*closed|has been closed|browser not started/i.test(String(error?.message || error || ''));

const gotoWithBrowserRecovery = async (session, payload, url, stage = 'navigation', defaults = {}) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        await ensureBrowserReadyForAction(session, payload, {
            ...defaults,
            url,
            contentKey: defaults.contentKey || getInstagramContentKey(url),
        }, `${stage} browser recovery`);

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            return attempt > 1 ? 'recovered' : 'ok';
        } catch (error) {
            lastError = error;
            if (attempt >= 2 || !isClosedBrowserError(error)) {
                throw error;
            }

            appendRuntimeErrorLog(`${stage} retry after closed browser`, error);
            await closeBrowser({ preserveTask: true }).catch(closeError => {
                console.log(`Could not clear closed browser before ${stage} retry: ${closeError.message}`);
            });
        }
    }

    throw lastError || new Error(`${stage} failed before navigation could complete.`);
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
                if (/Comment text was not inserted|Comment composer was not exact before posting|non-editable .*hint|not opened a real editable comment input/i.test(error.message)) {
                    await closeCommentPanelIfOpen();
                    await closeMessagesPanelIfOpen();
                    await clearPageTextSelection();
                    await wait(1800);
                    continue;
                }

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
        rowNumber: task.rowNumber || null,
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
        rowNumber: task.rowNumber || null,
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
        await verifyLikedOrContinue(session, task, 'queued like verification');
    } else {
        task.likeButtonRect = existingUnlike.clickRect;
        task.likeVerification = {
            verified: true,
            alreadyLiked: true,
            stage: 'queued like',
            at: new Date().toISOString(),
        };
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

const isQueuedActionReadyToRun = task => Boolean(
    task
    && !task.skip
    && (task.originalUrl || task.finalUrl || task.contentKey || task.requestedContentKey || task.rowNumber)
    && task.comment,
);

const markQueuedActionFailed = (session, queuedTask, error) => {
    const task = getActiveTask() || queuedTask || {};
    const message = error?.message || String(error);
    task.accountKey = task.accountKey || queuedTask?.accountKey || session.accountKey;
    task.accountName = task.accountName || queuedTask?.accountName || session.accountName || session.accountKey;
    task.phase = 'error';
    task.error = message;
    task.updatedAt = new Date().toISOString();
    removeQueuedActionTask(session, queuedTask);
    upsertDashboardPost({
        account: task.accountName || task.accountKey,
        accountKey: task.accountKey,
        contentKey: task.contentKey || task.requestedContentKey || queuedTask?.contentKey || queuedTask?.requestedContentKey || null,
        rowNumber: task.rowNumber || queuedTask?.rowNumber || null,
        url: getTaskTargetUrl(task) || queuedTask?.originalUrl || getInstagramUrlForContentKey(queuedTask?.contentKey || queuedTask?.requestedContentKey),
        comment: task.comment || queuedTask?.comment || null,
        status: 'failed',
        phase: 'error',
        error: message,
        startedAt: task.startedAt || queuedTask?.startedAt || null,
        completedAt: null,
    });
    recordTaskEvent(task, 'error', {
        status: 'failed',
        error: message,
    });
};

const drainQueuedActionTasks = async (session, reason = 'queued action drain') => {
    if (session.queuedActionDrainInFlight) {
        return [];
    }

    session.queuedActionDrainInFlight = true;
    const completedActions = [];
    try {
        while (true) {
            const nextTask = (session.queuedActionTasks || []).find(isQueuedActionReadyToRun);
            if (!nextTask) {
                break;
            }

            try {
                console.log(`Draining queued action for ${session.accountName || session.accountKey} after ${reason}.`);
                const completedAction = await performQueuedActionTask(session, nextTask, nextTask.comment);
                if (completedAction) {
                    completedActions.push(completedAction);
                }
            } catch (error) {
                console.log(`Queued action failed for ${session.accountName || session.accountKey}: ${error.message}`);
                markQueuedActionFailed(session, nextTask, error);
                break;
            }
        }
    } finally {
        session.queuedActionDrainInFlight = false;
    }

    return completedActions;
};

const scheduleQueuedActionDrain = (session, reason = 'completed action') => {
    if (session.queuedActionDrainScheduled || session.queuedActionDrainInFlight) {
        return false;
    }
    if (!(session.queuedActionTasks || []).some(isQueuedActionReadyToRun)) {
        return false;
    }

    session.queuedActionDrainScheduled = true;
    setTimeout(() => {
        runInBrowserSession(session, async () => {
            session.queuedActionDrainScheduled = false;
            await drainQueuedActionTasks(session, reason);
        }, 'queued-drain').catch(error => {
            session.queuedActionDrainScheduled = false;
            appendRuntimeErrorLog(`Queued action drain failed for ${session.accountName || session.accountKey}`, error);
        });
    }, 0);

    return true;
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

const getXActionTargetFromPayload = payload => {
    const url = getXUrlFromPayload(payload);
    const contentKey = getXContentKey(url);
    const rowNumber = getFirstPayloadValue(payload, ['row_number', 'rowNumber', 'row', 'sheet_row', 'sheetRow', '__row_number']);
    const comment = getFirstPayloadValue(payload, ['comment', 'comment_text', 'text', 'message']);

    return {
        platform: 'x',
        url,
        contentKey,
        rowNumber: rowNumber ? String(rowNumber).trim() : null,
        comment: comment ? String(comment).trim() : null,
    };
};

const getCompletedXActionForTarget = (session, target) => {
    if (!target?.contentKey && !target?.rowNumber) {
        return null;
    }
    const exact = getCompletedAction(session.accountKey, target.contentKey);
    if (exact) {
        return exact;
    }
    const history = readActionHistory();
    return Object.values(history.completed || {}).find(action => {
        if (!isTrustedCompletedAction(action) || getItemPlatform(action) !== 'x') {
            return false;
        }
        const actionAccountKey = normalizeAccountName(action.accountKey || getPlatformAccountKey('x', action.account));
        return actionAccountKey === session.accountKey
            && target.rowNumber
            && String(action.rowNumber || '').trim() === String(target.rowNumber).trim();
    }) || null;
};

const returnCompletedXActionWithoutBrowser = async (session, target) => {
    const completed = getCompletedXActionForTarget(session, target);
    if (!completed) {
        return null;
    }
    if (isPageOpen()) {
        await closeBrowser({ preserveTask: false }).catch(() => null);
    }
    console.log(`Skipping duplicate X action already completed: ${getHistoryKey(session.accountKey, completed.contentKey || target.contentKey)}`);
    return completed;
};

const getStoredXResumePayloadForSession = (session, fallbackPayload = {}) => {
    const history = readActionHistory();
    const post = Object.values(history.posts || {}).find(item => (
        getItemPlatform(item) === 'x'
        && item.accountKey === session.accountKey
        && normalizeDashboardStatus(item.status || item.phase) === 'running'
        && item.url
        && item.comment
    ));
    if (!post) {
        return null;
    }
    return {
        ...fallbackPayload,
        platform: 'x',
        x_username: stripPlatformAccountKey(session.accountKey),
        account_username: stripPlatformAccountKey(session.accountKey),
        x_url: post.url,
        row_number: post.rowNumber || null,
        comment_text: post.comment,
    };
};

const getXPostIdFromTarget = target => {
    const contentMatch = String(target?.contentKey || '').match(/^x:(?:status:)?([0-9]{1,19})$/i);
    if (contentMatch) {
        return contentMatch[1];
    }
    const urlMatch = String(target?.url || '').match(/\/status(?:es)?\/([0-9]{1,19})/i)
        || String(target?.url || '').match(/\/i\/status\/([0-9]{1,19})/i);
    return urlMatch ? urlMatch[1] : null;
};

const xApiRequest = async ({ method = 'GET', path: apiPath, token, body = null }) => {
    if (typeof fetch !== 'function') {
        throw new Error('This Node.js version does not provide fetch; upgrade Node.js or use browser X mode.');
    }
    const response = await fetch(`https://api.x.com${apiPath}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const responseText = await response.text();
    let data = null;
    try {
        data = responseText ? JSON.parse(responseText) : null;
    } catch (_error) {
        data = { raw: responseText };
    }

    if (!response.ok) {
        const errorDetails = data?.detail
            || data?.title
            || data?.errors?.map(error => error.detail || error.title || JSON.stringify(error)).join('; ')
            || responseText
            || response.statusText;
        throw new Error(`X API ${method} ${apiPath} failed (${response.status}): ${errorDetails}`);
    }
    return data || {};
};

const getXApiUserIdForAction = async ({ payload, session, token }) => {
    const userId = getXApiUserId(payload, session);
    if (userId) {
        return userId;
    }

    const me = await xApiRequest({
        method: 'GET',
        path: '/2/users/me',
        token,
    });
    const resolvedId = String(me?.data?.id || '').trim();
    if (!resolvedId) {
        throw new Error('X API token worked, but /2/users/me did not return a user id.');
    }
    return resolvedId;
};

const canUseXApiForPayload = (payload, session) => Boolean(getXApiAccessToken(payload, session));

const performXApiAction = async ({ session, payload, target, task }) => {
    const token = getXApiAccessToken(payload, session);
    if (!token) {
        throw new Error('Missing x_access_token for X API mode.');
    }
    const tweetId = getXPostIdFromTarget(target);
    if (!tweetId) {
        throw new Error('X API mode needs a normal X status URL with a numeric post id.');
    }

    currentAccountKey = session.accountKey;
    const userId = await getXApiUserIdForAction({ payload, session, token });

    task.phase = 'api-reposting';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'api-reposting', { status: 'running', message: 'Reposting through X API.' });
    const repostResult = await xApiRequest({
        method: 'POST',
        path: `/2/users/${encodeURIComponent(userId)}/retweets`,
        token,
        body: { tweet_id: tweetId },
    });
    task.repostVerification = {
        verified: Boolean(repostResult?.data?.retweeted ?? true),
        method: 'x-api-repost',
        userId,
        tweetId,
        response: repostResult?.data || null,
        at: new Date().toISOString(),
    };

    task.phase = 'api-liking';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'api-liking', { status: 'running', message: 'Liking through X API.' });
    const likeResult = await xApiRequest({
        method: 'POST',
        path: `/2/users/${encodeURIComponent(userId)}/likes`,
        token,
        body: { tweet_id: tweetId },
    });
    task.likeVerification = {
        verified: Boolean(likeResult?.data?.liked ?? true),
        method: 'x-api-like',
        userId,
        tweetId,
        response: likeResult?.data || null,
        at: new Date().toISOString(),
    };

    task.phase = 'api-replying';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'api-replying', { status: 'running', message: 'Replying through X API.' });
    const replyResult = await xApiRequest({
        method: 'POST',
        path: '/2/tweets',
        token,
        body: {
            text: target.comment,
            reply: {
                in_reply_to_tweet_id: tweetId,
            },
        },
    });
    task.commentVerification = {
        visible: Boolean(replyResult?.data?.id),
        method: 'x-api-reply',
        replyId: replyResult?.data?.id || null,
        tweetId,
        userId,
        response: replyResult?.data || null,
    };
    task.finalUrl = target.url;

    if (!task.commentVerification.visible) {
        throw new Error('X API reply did not return a created reply id.');
    }

    return markXTaskCompleted(task);
};

const getXSessionForRequestPayload = payload => {
    const loginIdentifier = String(
        payload.x_username
        || payload.twitter_username
        || payload.account_username
        || payload.username
        || payload.account
        || '',
    ).trim();
    const accountName = normalizeAccountName(
        loginIdentifier
        || 'default',
    );
    const accountKey = getPlatformAccountKey('x', accountName);
    const session = getBrowserSession(accountKey, accountName || stripPlatformAccountKey(accountKey), 'x');
    session.xLoginIdentifier = loginIdentifier || accountName || stripPlatformAccountKey(accountKey);
    session.systemBrowserChannel = payload.browserChannel
        || payload.browser_channel
        || payload.x_browser_channel
        || session.systemBrowserChannel
        || X_SYSTEM_BROWSER_CHANNEL;
    session.systemUserDataDir = payload.edgeUserDataDir
        || payload.edge_user_data_dir
        || payload.chromeUserDataDir
        || payload.chrome_user_data_dir
        || payload.userDataDir
        || payload.user_data_dir
        || session.systemUserDataDir
        || null;
    session.systemProfileDirectory = payload.edgeProfileDirectory
        || payload.edge_profile_directory
        || payload.chromeProfileDirectory
        || payload.chrome_profile_directory
        || payload.profileDirectory
        || payload.profile
        || session.systemProfileDirectory
        || null;
    return session;
};

const getXSessionFileForAccountKey = accountKey => getSessionFileForAccountKey(getPlatformAccountKey('x', accountKey));

const importXSessionFromBrowserProfile = async ({
    session,
    browserChannel = 'chrome',
    browserName = 'Chrome',
    userDataDir,
    profileDirectory,
}) => {
    const finalUserDataDir = path.resolve(userDataDir);
    const finalProfileDirectory = String(profileDirectory || 'Default').trim() || 'Default';
    if (!fs.existsSync(finalUserDataDir)) {
        throw new Error(`${browserName} user data directory not found: ${finalUserDataDir}`);
    }
    if (!fs.existsSync(path.join(finalUserDataDir, finalProfileDirectory))) {
        throw new Error(`${browserName} profile "${finalProfileDirectory}" not found inside ${finalUserDataDir}`);
    }

    let browserContext = null;
    try {
        browserContext = await chromium.launchPersistentContext(finalUserDataDir, {
            channel: browserChannel,
            headless: false,
            viewport: BROWSER_VIEWPORT,
            args: [
                `--profile-directory=${finalProfileDirectory}`,
                `--window-size=${MANUAL_BROWSER_WINDOW_WIDTH},${MANUAL_BROWSER_WINDOW_HEIGHT}`,
            ],
        });
        const browserPage = browserContext.pages()[0] || await browserContext.newPage();
        await browserPage.goto(X_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        await browserPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null);
        await wait(5000);

        const loggedIn = await browserPage.locator([
            '[data-testid="SideNav_AccountSwitcher_Button"]',
            '[data-testid="AppTabBar_Home_Link"]',
            'a[href="/home"]',
            '[data-testid="primaryColumn"] [data-testid="tweet"]',
        ].join(', ')).first().isVisible({ timeout: 5000 }).catch(() => false);
        const loginText = await browserPage.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        if (!loggedIn || /log in|sign up|temporarily limited your login/i.test(loginText)) {
            throw new Error(`${browserName} profile "${finalProfileDirectory}" is not currently logged into X, or X is still showing a login/limit page.`);
        }

        const sessionFile = getXSessionFileForAccountKey(session.accountKey);
        const storageState = await browserContext.storageState();
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, JSON.stringify(storageState, null, 2));
        return { sessionFile, userDataDir: finalUserDataDir, profileDirectory: finalProfileDirectory };
    } catch (error) {
        if (/process.*singleton|user data directory is already in use|Failed to create a ProcessSingleton|cannot create default profile directory/i.test(error.message || '')) {
            throw new Error(`${browserName} profile "${finalProfileDirectory}" is already open. Close all normal ${browserName} windows first, then run the import again.`);
        }
        throw error;
    } finally {
        if (browserContext) {
            await browserContext.close().catch(() => null);
        }
    }
};

const importXSessionFromChromeProfile = async ({ session, chromeUserDataDir, chromeProfileDirectory }) => {
    return importXSessionFromBrowserProfile({
        session,
        browserChannel: 'chrome',
        browserName: 'Chrome',
        userDataDir: chromeUserDataDir || DEFAULT_CHROME_USER_DATA_DIR,
        profileDirectory: chromeProfileDirectory || DEFAULT_CHROME_PROFILE_DIRECTORY,
    });
};

const importXSessionFromEdgeProfile = async ({ session, edgeUserDataDir, edgeProfileDirectory }) => {
    return importXSessionFromBrowserProfile({
        session,
        browserChannel: 'msedge',
        browserName: 'Edge',
        userDataDir: edgeUserDataDir || DEFAULT_EDGE_USER_DATA_DIR,
        profileDirectory: edgeProfileDirectory || DEFAULT_EDGE_PROFILE_DIRECTORY,
    });
};

const isXLoginFormVisible = async () => Boolean(await firstVisibleLocator([
    'input[name="text"]',
    'input[name="password"]',
    'input[autocomplete="username"]',
    'input[data-testid="ocfEnterTextTextInput"]',
]));

const getXBlocker = async () => {
    if (!isPageOpen()) {
        return null;
    }

    const url = page.url();
    if (/\/account\/access|\/account\/begin_password_reset|\/i\/flow\/two-factor|\/i\/flow\/challenge|signup_phone/i.test(url)) {
        return `X verification page opened: ${url}`;
    }

    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const blockerPatterns = [
        {
            pattern: /temporarily limited your login|try again later/i,
            message: 'X has temporarily limited login attempts for this account. Stop retrying for now; keep the visible Edge window open and finish login there when X allows it.',
        },
        {
            pattern: /enter your phone number|send an sms|text message/i,
            message: 'X is asking for phone/SMS verification.',
        },
        {
            pattern: /verification code|two[- ]factor|authenticate your account|confirm your identity|unusual login|suspicious|captcha|arkose|enter the code/i,
            message: 'X is asking for verification, security code, or captcha.',
        },
    ];
    const matched = blockerPatterns.find(({ pattern }) => pattern.test(bodyText));
    return matched?.message || null;
};

const getXLoginGate = async () => {
    if (!isPageOpen()) {
        return null;
    }

    const url = page.url();
    if (/\/i\/flow\/login|\/login/i.test(url) && await isXLoginFormVisible()) {
        return 'X login form is visible.';
    }

    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const loginPatterns = [
        /log in to x/i,
        /log in to twitter/i,
        /sign up.*log in/i,
        /don'?t miss what'?s happening/i,
        /new to x/i,
        /create your account/i,
    ];
    const matchedPattern = loginPatterns.find(pattern => pattern.test(bodyText));
    return matchedPattern ? `X is asking this account to log in: ${matchedPattern}` : null;
};

const throwIfXBlocked = async stage => {
    const blocker = await getXBlocker();
    if (!blocker) {
        return;
    }

    const task = await markXTaskPaused({
        phase: 'manual-verification',
        message: blocker,
        blocker,
        stage,
    });
    throw createXManualVerificationError({ stage, blocker, task });
};

const clickXModalActionButton = async () => {
    if (!isPageOpen()) {
        return false;
    }

    return page.evaluate(() => {
        const isVisible = element => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0
                && rect.bottom > 0 && rect.right > 0
                && rect.top < window.innerHeight && rect.left < window.innerWidth
                && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(isVisible);
        const roots = dialogs.length ? dialogs : [];
        const wanted = /^(got it|done|ok|okay|continue|not now|maybe later|skip|close|more)$/i;
        const buttons = roots
            .flatMap(root => Array.from(root.querySelectorAll('button, [role="button"], a')))
            .filter(isVisible)
            .filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true')
            .filter(element => wanted.test(normalize(element.getAttribute('aria-label') || element.textContent)));
        const target = buttons.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
        })[0];
        if (!target) return false;
        target.click();
        return true;
    }).catch(() => false);
};

const dismissXDialogs = async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const clicked = await clickXModalActionButton() || await clickFirstVisibleButton([
            /^not now$/i,
            /^maybe later$/i,
            /^skip$/i,
            /^got it$/i,
            /^continue$/i,
            /^ok$/i,
            /^done$/i,
            /^confirm$/i,
            /^accept all cookies$/i,
            /^refuse non-essential cookies$/i,
            /^allow all cookies$/i,
            /^close$/i,
        ]);

        if (!clicked) {
            return;
        }
        await wait(900);
    }
};

const isAnyXLocatorVisible = async (selector, timeout = 2500) => {
    const locator = page.locator(selector);
    const firstVisible = await locator.first().isVisible({ timeout }).catch(() => false);
    if (firstVisible) {
        return true;
    }

    const count = await locator.count().catch(() => 0);
    for (let index = 1; index < Math.min(count, 12); index += 1) {
        if (await locator.nth(index).isVisible({ timeout: 300 }).catch(() => false)) {
            return true;
        }
    }
    return false;
};

const isXLoggedIn = async () => {
    await wait(1000);
    await throwIfXBlocked('x session validation');
    if (await getXLoginGate()) {
        return false;
    }

    const loggedInSelectors = [
        '[data-testid="SideNav_AccountSwitcher_Button"]',
        '[data-testid="AppTabBar_Home_Link"]',
        'a[aria-label*="Home" i][href="/home"]',
        'a[href="/home"]',
        '[data-testid="primaryColumn"] [data-testid="tweet"]',
        '[data-testid="tweetTextarea_0"]',
        '[data-testid^="tweetTextarea_"]',
        '[aria-label="Post text"]',
        '[aria-label="Timeline: Your Home Timeline"]',
        '[aria-label*="Home timeline" i]',
    ];
    for (const selector of loggedInSelectors) {
        if (await isAnyXLocatorVisible(selector)) {
            return true;
        }
    }

    const url = page.url();
    const bodyText = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    return /\/home(?:$|[?#])/i.test(url)
        && /Home Timeline|For you\s+Following|What.?s happening\?|Post Your Home Timeline/i.test(bodyText);
};

const fillXInput = async (selectors, value, label) => {
    const input = await firstVisibleLocator(selectors);
    if (!input) {
        throw new Error(`Could not find visible X ${label} input.`);
    }
    await input.click({ timeout: 5000 }).catch(() => null);
    await input.fill(String(value), { timeout: 7000 }).catch(async () => {
        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
        await page.keyboard.type(String(value), { delay: 25 });
    });
    await wait(400);
    return input;
};

const clickXFlowButton = async labels => {
    const clicked = await clickFirstVisibleButton(labels);
    if (clicked) {
        return true;
    }

    return page.keyboard.press('Enter').then(() => true).catch(() => false);
};

const getVisibleXInputDetails = async () => page.evaluate(() => {
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
    const isFrontmost = element => {
        const rect = element.getBoundingClientRect();
        const points = [
            [rect.left + rect.width / 2, rect.top + rect.height / 2],
            [rect.left + Math.min(36, rect.width / 3), rect.top + rect.height * 0.65],
        ];
        const container = element.closest('label, [role="group"], [role="dialog"], form, div') || element;
        return points.some(([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return hit && (element === hit || element.contains(hit) || hit.contains(element) || container.contains(hit));
        });
    };
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"][role="textbox"], div[role="textbox"]'))
        .filter(isVisible)
        .map((element, index) => {
            const rect = element.getBoundingClientRect();
            const labelledBy = element.getAttribute('aria-labelledby');
            const labelledText = labelledBy
                ? labelledBy.split(/\s+/)
                    .map(id => document.getElementById(id)?.textContent || '')
                    .join(' ')
                : '';
            return {
                index,
                type: normalize(element.getAttribute('type')),
                name: normalize(element.getAttribute('name')),
                placeholder: normalize(element.getAttribute('placeholder')),
                ariaLabel: normalize(element.getAttribute('aria-label')),
                label: normalize(labelledText || element.closest('label')?.textContent),
                text: normalize(element.textContent),
                frontmost: isFrontmost(element),
                rect: {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                },
            };
        });
});

const fillXInputByDetails = async ({ matcher, value, label }) => {
    const details = await getVisibleXInputDetails();
    const matches = details.filter(matcher);
    const target = matches.find(input => input.frontmost) || matches[matches.length - 1] || null;
    if (!target) {
        throw new Error(`Could not find visible X ${label} input. Visible inputs: ${JSON.stringify(details)}`);
    }
    console.log(`X ${label} input target: frontmost=${Boolean(target.frontmost)} rect=${Math.round(target.rect.left)},${Math.round(target.rect.top)},${Math.round(target.rect.width)}x${Math.round(target.rect.height)} matches=${matches.length}`);

    await page.mouse.click(target.rect.left + target.rect.width / 2, target.rect.top + target.rect.height / 2);
    await wait(250);
    await page.keyboard.press('Control+A').catch(() => null);
    await page.keyboard.press('Backspace').catch(() => null);
    await page.keyboard.type(String(value), { delay: 25 });
    const currentValue = await setFocusedXFieldValue(value);
    await wait(500);
    const snapshot = await getFocusedTextSnapshot();
    const expected = normalizeCommentValue(value);
    const actual = normalizeCommentValue(`${currentValue}\n${snapshot}`);
    if (!actual.includes(expected)) {
        throw new Error(`Could not type the full X ${label} value into the visible input.`);
    }
    return {
        ...target.rect,
        right: target.rect.left + target.rect.width,
        bottom: target.rect.top + target.rect.height,
    };
};

const getVisibleTextRect = async patternSource => page.evaluate(source => {
    const pattern = new RegExp(source, 'i');
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
    const rectToObject = rect => ({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
    });
    const candidates = Array.from(document.querySelectorAll('input, textarea, label, span, div'))
        .filter(isVisible)
        .map(element => {
            const text = normalize([
                element.getAttribute('placeholder'),
                element.getAttribute('aria-label'),
                element.textContent,
            ].filter(Boolean).join(' '));
            const rect = element.getBoundingClientRect();
            const container = element.closest('label, [role="group"], [role="dialog"], form, div') || element;
            const containerRect = container.getBoundingClientRect();
            return {
                text,
                rect: rectToObject(rect),
                containerRect: rectToObject(containerRect),
                score: (rect.width * rect.height) + (pattern.test(text) ? 100000 : 0),
            };
        })
        .filter(candidate => pattern.test(candidate.text))
        .sort((a, b) => b.score - a.score);

    return candidates[0] || null;
}, patternSource).catch(() => null);

const getXFieldRectByText = async patternSource => page.evaluate(source => {
    const pattern = new RegExp(source, 'i');
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
    const rectToObject = rect => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
    });
    const getText = element => normalize([
        element.getAttribute('placeholder'),
        element.getAttribute('aria-label'),
        element.textContent,
    ].filter(Boolean).join(' '));
    const isFrontmost = (element, rect) => {
        const points = [
            [rect.left + rect.width / 2, rect.top + rect.height / 2],
            [rect.left + Math.min(42, rect.width / 3), rect.top + rect.height * 0.65],
        ];
        const container = element.closest('label, [role="group"], [role="dialog"], form, div') || element;
        return points.some(([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return hit && (element === hit || element.contains(hit) || hit.contains(element) || container.contains(hit));
        });
    };
    const getFieldTarget = element => {
        let current = element;
        for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
            const rect = current.getBoundingClientRect();
            if (
                rect.width >= 220
                && rect.width <= 620
                && rect.height >= 42
                && rect.height <= 110
                && rect.top >= 0
                && rect.bottom <= window.innerHeight
            ) {
                return { element: current, rect: rectToObject(rect) };
            }
        }
        return { element, rect: rectToObject(element.getBoundingClientRect()) };
    };
    const candidates = Array.from(document.querySelectorAll('input, textarea, label, span, div'))
        .filter(isVisible)
        .map(element => {
            const text = getText(element);
            const elementRect = element.getBoundingClientRect();
            const fieldTarget = getFieldTarget(element);
            const fieldRect = fieldTarget.rect;
            const fieldLike = fieldRect.width >= 220 && fieldRect.height >= 42 && fieldRect.height <= 110;
            const exact = pattern.test(text);
            const frontmost = isFrontmost(fieldTarget.element, fieldRect);
            return {
                text,
                rect: fieldRect,
                fieldLike,
                frontmost,
                score: (exact ? 100000 : 0)
                    + (fieldLike ? 25000 : 0)
                    + (frontmost ? 50000 : 0)
                    - Math.abs(fieldRect.height - 58) * 180
                    - Math.max(0, fieldRect.width - 520) * 20
                    - (elementRect.width * elementRect.height > 120000 ? 90000 : 0),
            };
        })
        .filter(candidate => (
            candidate.frontmost
            && pattern.test(candidate.text)
            && (candidate.fieldLike || candidate.rect.height <= 130)
        ))
        .sort((a, b) => b.score - a.score);

    return candidates[0]?.rect || null;
}, patternSource).catch(() => null);

const getFocusedTextSnapshot = async () => page.evaluate(() => {
    const active = document.activeElement;
    const bodyText = String(document.body?.innerText || '').trim();
    if (!active) {
        return bodyText;
    }
    return `${String(active.value ?? active.textContent ?? '').trim()}\n${bodyText}`;
}).catch(() => '');

const setFocusedXFieldValue = async value => page.evaluate(rawValue => {
    const value = String(rawValue ?? '');
    const active = document.activeElement;
    if (!active) {
        return '';
    }

    const dispatch = element => {
        element.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            data: value,
            inputType: 'insertText',
        }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const setInputValue = (element, nextValue) => {
        const proto = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (descriptor?.set) {
            descriptor.set.call(element, nextValue);
        } else {
            element.value = nextValue;
        }
        dispatch(element);
    };

    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.focus();
        setInputValue(active, '');
        setInputValue(active, value);
        return active.value;
    }

    if (active.isContentEditable || active.getAttribute('contenteditable') === 'true') {
        active.focus();
        active.textContent = '';
        dispatch(active);
        document.execCommand?.('insertText', false, value);
        if (String(active.textContent || '').trim() !== value) {
            active.textContent = value;
        }
        dispatch(active);
        return active.textContent || '';
    }

    const nested = active.querySelector?.('input, textarea, [contenteditable="true"]');
    if (nested instanceof HTMLInputElement || nested instanceof HTMLTextAreaElement) {
        nested.focus();
        setInputValue(nested, '');
        setInputValue(nested, value);
        return nested.value;
    }
    if (nested) {
        nested.focus();
        nested.textContent = value;
        dispatch(nested);
        return nested.textContent || '';
    }

    return String(active.textContent || active.value || '');
}, value).catch(() => '');

const typeIntoXVisibleTextField = async ({ pattern, value, label }) => {
    const rect = await getXFieldRectByText(pattern.source);
    if (!rect) {
        throw new Error(`Could not find visible X ${label} text field.`);
    }

    const clickPoints = [
        { x: rect.left + Math.min(42, rect.width / 3), y: rect.top + rect.height * 0.62 },
        { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.62 },
        { x: rect.left + Math.min(42, rect.width / 3), y: rect.top + rect.height / 2 },
    ];
    let typed = false;
    const expected = normalizeCommentValue(value);
    for (const point of clickPoints) {
        await page.mouse.click(point.x, point.y);
        await wait(250);
        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
        await page.keyboard.type(String(value), { delay: 35 }).catch(async () => {
            await page.keyboard.insertText(String(value));
        });
        await wait(500);
        let snapshot = await getFocusedTextSnapshot();
        let actual = normalizeCommentValue(snapshot);
        if (actual.includes(expected)) {
            typed = true;
            break;
        }
        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
        const currentValue = await setFocusedXFieldValue(value);
        await wait(500);
        snapshot = await getFocusedTextSnapshot();
        actual = normalizeCommentValue(`${currentValue}\n${snapshot}`);
        if (actual.includes(expected)) {
            typed = true;
            break;
        }
    }

    if (!typed) {
        throw new Error(`Could not type into visible X ${label} text field.`);
    }

    await wait(700);
    return rect;
};

const clickXManualButtonBelow = async ({ fieldRect, labels, label }) => {
    const clicked = await page.waitForFunction(({ fieldRect: rawFieldRect, labelSources }) => {
        const patterns = labelSources.map(source => new RegExp(source, 'i'));
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
        const isFrontmost = element => {
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            return hit && (element === hit || element.contains(hit) || hit.contains(element));
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(isVisible)
            .filter(isFrontmost)
            .map(element => {
                const rect = element.getBoundingClientRect();
                const text = normalize(element.getAttribute('aria-label') || element.textContent);
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const belowField = centerY > rawFieldRect.bottom + 8;
                const horizontallyAligned = centerX >= rawFieldRect.left - 30 && centerX <= rawFieldRect.right + 30;
                const nearField = centerY <= rawFieldRect.bottom + 460;
                const style = window.getComputedStyle(element);
                const greyDisabled = /rgb\(\s*(204|207|239)\s*,\s*(214|217|243)\s*,\s*(221|222|244)\s*\)/i.test(style.backgroundColor || '');
                const disabled = element.disabled
                    || element.hasAttribute('disabled')
                    || element.getAttribute('aria-disabled') === 'true'
                    || /disabled/i.test(element.getAttribute('class') || '')
                    || Number(style.opacity || 1) < 0.65
                    || greyDisabled;
                return {
                    element,
                    text,
                    centerY,
                    area: rect.width * rect.height,
                    belowField,
                    horizontallyAligned,
                    nearField,
                    disabled,
                };
            })
            .filter(candidate => (
                !candidate.disabled
                && candidate.belowField
                && candidate.horizontallyAligned
                && candidate.nearField
                && candidate.area >= 900
                && patterns.some(pattern => pattern.test(candidate.text))
            ))
            .sort((a, b) => a.centerY - b.centerY || b.area - a.area);

        const target = candidates[0]?.element?.closest('button, [role="button"]') || candidates[0]?.element;
        if (!target) {
            return false;
        }
        return true;
    }, {
        fieldRect,
        labelSources: labels.map(pattern => pattern.source),
    }, { timeout: 8000, polling: 250 }).then(() => true).catch(() => false);

    if (!clicked) {
        throw new Error(`The X ${label} button below the manual field did not become enabled.`);
    }
    const clickResult = await page.evaluate(({ fieldRect: rawFieldRect, labelSources }) => {
        const patterns = labelSources.map(source => new RegExp(source, 'i'));
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
        const isFrontmost = element => {
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            return hit && (element === hit || element.contains(hit) || hit.contains(element));
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(isVisible)
            .filter(isFrontmost)
            .map(element => {
                const rect = element.getBoundingClientRect();
                const text = normalize(element.getAttribute('aria-label') || element.textContent);
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const style = window.getComputedStyle(element);
                const greyDisabled = /rgb\(\s*(204|207|239)\s*,\s*(214|217|243)\s*,\s*(221|222|244)\s*\)/i.test(style.backgroundColor || '');
                const disabled = element.disabled
                    || element.hasAttribute('disabled')
                    || element.getAttribute('aria-disabled') === 'true'
                    || /disabled/i.test(element.getAttribute('class') || '')
                    || Number(style.opacity || 1) < 0.65
                    || greyDisabled;
                return { element, text, centerX, centerY, area: rect.width * rect.height, disabled };
            })
            .filter(candidate => (
                !candidate.disabled
                && candidate.centerY > rawFieldRect.bottom + 8
                && candidate.centerY <= rawFieldRect.bottom + 460
                && candidate.centerX >= rawFieldRect.left - 30
                && candidate.centerX <= rawFieldRect.right + 30
                && candidate.area >= 900
                && patterns.some(pattern => pattern.test(candidate.text))
            ))
            .sort((a, b) => a.centerY - b.centerY || b.area - a.area);
        const target = candidates[0]?.element?.closest('button, [role="button"]') || candidates[0]?.element;
        if (!target) {
            return false;
        }
        target.click();
        return true;
    }, {
        fieldRect,
        labelSources: labels.map(pattern => pattern.source),
    }).catch(() => false);
    if (!clickResult) {
        throw new Error(`Could not click the enabled X ${label} button below the manual field.`);
    }
    await wait(1600);
};

const fillXInputWithFallback = async ({ matcher, pattern, value, label }) => {
    try {
        return await fillXInputByDetails({ matcher, value, label });
    } catch (error) {
        console.log(`X ${label} DOM fill fallback needed: ${error.message}`);
        return await typeIntoXVisibleTextField({ pattern, value, label });
    }
};

const fillXLoginInputByLocator = async ({ selectors, value, label }) => {
    const input = await firstVisibleLocator(selectors);
    if (!input) {
        throw new Error(`Could not find visible X ${label} locator.`);
    }

    await input.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => null);
    await input.click({ timeout: 8000 });
    await wait(250);
    await input.fill('', { timeout: 5000 }).catch(async () => {
        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
    });
    await input.fill(String(value), { timeout: 8000 }).catch(async () => {
        await page.keyboard.type(String(value), { delay: 30 }).catch(async () => {
            await page.keyboard.insertText(String(value));
        });
    });
    await wait(650);

    const expected = normalizeCommentValue(value);
    const actual = normalizeCommentValue(await input.inputValue({ timeout: 1500 }).catch(() => getFocusedTextSnapshot()));
    if (!actual.includes(expected)) {
        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
        await page.keyboard.type(String(value), { delay: 30 }).catch(async () => {
            await page.keyboard.insertText(String(value));
        });
        await wait(650);
        const retryActual = normalizeCommentValue(await input.inputValue({ timeout: 1500 }).catch(() => getFocusedTextSnapshot()));
        if (!retryActual.includes(expected)) {
            throw new Error(`Could not type the full X ${label} value with locator.`);
        }
    }

    const box = await input.boundingBox({ timeout: 5000 }).catch(() => null);
    if (!box) {
        throw new Error(`Could not read the X ${label} field position.`);
    }
    return {
        left: box.x,
        top: box.y,
        right: box.x + box.width,
        bottom: box.y + box.height,
        width: box.width,
        height: box.height,
    };
};

const isXPhoneVerificationScreen = async () => {
    if (!isPageOpen()) {
        return false;
    }
    const url = page.url();
    if (/signup_phone/i.test(url)) {
        return true;
    }
    const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    return /enter your phone number|send an sms|text message|phone number/i.test(bodyText);
};

const hasXPasswordField = async () => {
    if (await isXPhoneVerificationScreen()) {
        return false;
    }

    const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    if (!/\bpassword\b/i.test(bodyText) || /enter your phone number|send an sms|text message/i.test(bodyText)) {
        return false;
    }

    if (await firstVisibleLocator(X_PASSWORD_INPUT_SELECTORS)) {
        return true;
    }

    const details = await getVisibleXInputDetails().catch(() => []);
    if (details.some(input => (
        input.frontmost
        && (
            input.type === 'password'
            || input.name === 'password'
            || input.placeholder === 'password'
            || input.ariaLabel === 'password'
        )
    ))) {
        return true;
    }

    return Boolean(await getXFieldRectByText('^password$'));
};

const waitForXPasswordField = async (timeoutMs = 10000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await hasXPasswordField()) {
            return true;
        }
        await wait(500);
    }
    return false;
};

const typeXCoordinateLoginField = async ({ value, label, fieldRatios, buttonRatios, successCheck = null }) => {
    const size = page.viewportSize() || BROWSER_VIEWPORT;
    const x = Math.round(size.width / 2);
    const expected = normalizeCommentValue(value);
    let typed = false;

    for (const ratio of fieldRatios) {
        const y = Math.round(size.height * ratio);
        await page.mouse.click(x, y);
        await wait(250);
        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
        await page.keyboard.type(String(value), { delay: 35 }).catch(async () => {
            await page.keyboard.insertText(String(value));
        });
        await wait(650);
        let snapshot = await getFocusedTextSnapshot();
        if (normalizeCommentValue(snapshot).includes(expected)) {
            typed = true;
            break;
        }

        const currentValue = await setFocusedXFieldValue(value);
        await wait(500);
        snapshot = await getFocusedTextSnapshot();
        if (normalizeCommentValue(`${currentValue}\n${snapshot}`).includes(expected)) {
            typed = true;
            break;
        }
    }

    if (!typed) {
        throw new Error(`Could not type the full X ${label} value using coordinate fallback.`);
    }

    await wait(1200);
    for (const ratio of buttonRatios) {
        await page.mouse.click(x, Math.round(size.height * ratio));
        await wait(1500);
        if (successCheck && await successCheck()) {
            return;
        }
    }
    await page.keyboard.press('Enter').catch(() => null);
    await wait(1500);
    if (successCheck) {
        await successCheck();
    }
};

const fillXUsernameStep = async accountName => {
    try {
        const fieldRect = await fillXLoginInputByLocator({
            selectors: X_USERNAME_INPUT_SELECTORS,
            value: accountName,
            label: 'email or username',
        });
        await clickXManualButtonBelow({ fieldRect, labels: [/^continue$/i, /^next$/i], label: 'username continue' });
        await wait(1800);
        return;
    } catch (error) {
        console.log(`X username locator fill fallback needed: ${error.message}`);
    }

    try {
        const fieldRect = await fillXInputWithFallback({
            value: accountName,
            label: 'email or username',
            pattern: /email or username|phone, email|username/i,
            matcher: input => (
                input.name === 'text'
                || input.placeholder.includes('email or username')
                || input.ariaLabel.includes('email or username')
                || input.label.includes('email or username')
                || input.placeholder.includes('phone, email')
                || input.label.includes('username')
            ) && input.type !== 'password',
        });
        await clickXManualButtonBelow({ fieldRect, labels: [/^continue$/i, /^next$/i], label: 'username continue' });
    } catch (error) {
        console.log(`X username coordinate fallback needed: ${error.message}`);
        await typeXCoordinateLoginField({
            value: accountName,
            label: 'email or username',
            fieldRatios: [0.62, 0.64, 0.6],
            buttonRatios: [0.76, 0.77, 0.78, 0.75],
            successCheck: hasXPasswordField,
        });
    }
    await wait(1800);
};

const fillXPasswordStep = async password => {
    try {
        const fieldRect = await fillXLoginInputByLocator({
            selectors: X_PASSWORD_INPUT_SELECTORS,
            value: password,
            label: 'password',
        });
        await clickXManualButtonBelow({ fieldRect, labels: [/^continue$/i, /^log in$/i, /^login$/i, /^next$/i], label: 'password continue' });
        await wait(3500);
        return;
    } catch (error) {
        console.log(`X password locator fill fallback needed: ${error.message}`);
    }

    try {
        const fieldRect = await fillXInputWithFallback({
            value: password,
            label: 'password',
            pattern: /^password$/i,
            matcher: input => (
                input.type === 'password'
                || input.name === 'password'
                || input.placeholder === 'password'
                || input.ariaLabel === 'password'
            ),
        });
        await clickXManualButtonBelow({ fieldRect, labels: [/^continue$/i, /^log in$/i, /^login$/i, /^next$/i], label: 'password continue' });
    } catch (error) {
        console.log(`X password coordinate fallback needed: ${error.message}`);
        if (!await hasXPasswordField()) {
            throw error;
        }
        await typeXCoordinateLoginField({
            value: password,
            label: 'password',
            fieldRatios: [0.39, 0.41, 0.37, 0.43],
            buttonRatios: [0.78, 0.76, 0.8],
        });
    }
    await wait(3500);
};

const submitXCredentialsAndConfirmLogin = async ({ accountName, password, stage = 'x login' }) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            await dismissXDialogs();
            await throwIfXBlocked(stage);

            for (let step = 0; step < 4; step += 1) {
                await throwIfXBlocked(stage);
                const visibleInputs = await getVisibleXInputDetails();
                const passwordInput = visibleInputs.find(input => (
                    input.type === 'password'
                    || input.name === 'password'
                    || input.placeholder === 'password'
                    || input.ariaLabel === 'password'
                ));
                if (passwordInput) {
                    break;
                }
                if (await hasXPasswordField()) {
                    break;
                }

                const textInput = visibleInputs.find(input => (
                    input.name === 'text'
                    || input.placeholder.includes('email or username')
                    || input.ariaLabel.includes('email or username')
                    || input.label.includes('email or username')
                    || input.placeholder.includes('phone, email')
                    || input.label.includes('username')
                ) && input.type !== 'password');
                if (!textInput) {
                    if (await getXFieldRectByText('email or username|phone, email|username')) {
                        await fillXUsernameStep(accountName);
                        continue;
                    }
                    const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
                    if (/password/i.test(bodyText) && /log in|continue/i.test(bodyText)) {
                        break;
                    }
                    await fillXUsernameStep(accountName);
                    continue;
                }

                await fillXUsernameStep(accountName);
            }

            if (!await waitForXPasswordField(10000)) {
                await throwIfXBlocked(stage);
                throw new Error('X did not show the password field after submitting the username.');
            }
            await fillXPasswordStep(password);
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
            await wait(6500);
            await dismissXDialogs();

            if (await isXLoggedIn()) {
                return true;
            }

            const loginGate = await getXLoginGate();
            throw new Error(loginGate || 'X did not create a logged-in session after submitting credentials.');
        } catch (error) {
            lastError = error;
            if (error?.manualVerification) {
                throw error;
            }
            console.log(`X login attempt ${attempt} failed for ${accountName}: ${error.message}`);
            if (/did not show the password field|temporarily limited|try again later|verification|captcha|phone|sms|text message/i.test(error.message || '')) {
                const blocker = await getXBlocker().catch(() => null);
                if (blocker) {
                    const task = await markXTaskPaused({
                        phase: 'manual-verification',
                        message: blocker,
                        blocker,
                        stage,
                    });
                    throw createXManualVerificationError({ stage, blocker, task });
                }
                break;
            }
            await wait(1600);
            if (attempt < 2) {
                await page.goto(X_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
            }
        }
    }

    throw createAutomaticLoginFailureError(`Automatic X login failed for "${accountName}": ${lastError?.message || 'unknown error'}`);
};

const startXWithSavedSession = async (sessionFile, targetUrl = X_HOME_URL) => {
    const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    await launchBrowser(sessionData);
    await page.goto(targetUrl || X_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    await wait(3500);
    await dismissXDialogs();
    return isXLoggedIn();
};

const connectToXManualChromeSession = async session => {
    const port = getXManualChromeDebugPort(session.accountKey);
    const activeSession = getActiveBrowserSession();
    const browserRef = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const contextRef = browserRef.contexts()[0];
    if (!contextRef) {
        await browserRef.close().catch(() => null);
        throw new Error('Dedicated Chrome login window is not open. Start the X row again, then login in that Chrome window.');
    }
    const pages = contextRef.pages();
    const pageRef = pages.find(item => {
        try {
            return /(^|\.)x\.com$/i.test(new URL(item.url()).hostname);
        } catch (_error) {
            return false;
        }
    }) || pages[0] || await contextRef.newPage();
    activeSession.browser = browserRef;
    activeSession.context = contextRef;
    activeSession.page = pageRef;
    activeSession.usesSystemBrowserProfile = false;
    installBrowserLifecycleHandlers(activeSession);
    currentAccountKey = session.accountKey;
    if (!/x\.com/i.test(pageRef.url())) {
        await pageRef.goto(X_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    }
    await dismissXDialogs();
    return isXLoggedIn();
};

const startXWithSystemBrowserProfile = async ({
    targetUrl = X_HOME_URL,
    browserChannel = X_SYSTEM_BROWSER_CHANNEL,
    userDataDir = null,
    profileDirectory = null,
    allowCreateProfile = false,
} = {}) => {
    await launchBrowser(null, {
        systemBrowserProfile: true,
        browserChannel,
        userDataDir,
        profileDirectory,
        allowCreateProfile,
    });
    await page.goto(targetUrl || X_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    await wait(4000);
    await dismissXDialogs();
    await throwIfXBlocked('x chrome profile');
    return isXLoggedIn();
};

const ensureXTargetPostLoaded = async (target, stage = 'x navigation') => {
    const expectedContentKey = target?.contentKey || getXContentKey(target?.url);
    if (!expectedContentKey) {
        return null;
    }

    const currentContentKey = getXContentKey(page.url());
    if (currentContentKey === expectedContentKey) {
        return currentContentKey;
    }

    const targetUrl = getXUrlForContentKey(expectedContentKey) || target.url;
    console.log(`X redirected away from target before ${stage}: ${page.url()}. Returning to ${targetUrl}.`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(5000);
    await dismissXDialogs();
    await throwIfXBlocked(stage);

    const retriedContentKey = getXContentKey(page.url());
    if (retriedContentKey !== expectedContentKey) {
        throw new Error(`X did not open the target post. Expected ${expectedContentKey}, current URL is ${page.url()}.`);
    }

    return retriedContentKey;
};

const loginXAndSaveSession = async ({ session, password, targetUrl = X_HOME_URL, stage = 'x login' }) => {
    await launchBrowser(null, X_USE_SYSTEM_BROWSER_PROFILE ? {
        systemBrowserProfile: true,
        browserChannel: session.systemBrowserChannel || X_SYSTEM_BROWSER_CHANNEL,
        userDataDir: session.systemUserDataDir,
        profileDirectory: session.systemProfileDirectory,
    } : {});
    await page.goto(X_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await submitXCredentialsAndConfirmLogin({
        accountName: session.xLoginIdentifier || session.accountName || stripPlatformAccountKey(session.accountKey),
        password,
        stage,
    });
    await saveSession(getXSessionFileForAccountKey(session.accountKey));
    if (targetUrl) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        await wait(3500);
        await dismissXDialogs();
    }
};

const createXManualVerificationError = ({ stage, blocker, task }) => {
    const error = new Error(`X verification required during ${stage}. ${blocker} Solve it manually in the visible X browser, then call POST /x/save-session for this account.`);
    error.manualVerification = true;
    error.stage = stage;
    error.blocker = blocker;
    error.task = task || getActiveTask();
    return error;
};

const markXTaskPaused = async ({ phase = 'manual-verification', message, blocker, stage, loginRequired = false, payload = null, session = null } = {}) => {
    const activeSession = session || getActiveBrowserSession();
    const task = ensureCurrentTask();
    const target = payload ? getXActionTargetFromPayload(payload) : {};
    const pausedAt = new Date().toISOString();

    task.platform = 'x';
    task.accountKey = activeSession.accountKey;
    task.accountName = activeSession.accountName || stripPlatformAccountKey(activeSession.accountKey);
    task.originalUrl = target.url || task.originalUrl || null;
    task.requestedContentKey = target.contentKey || task.requestedContentKey || null;
    task.contentKey = target.contentKey || task.contentKey || null;
    task.rowNumber = target.rowNumber || task.rowNumber || null;
    task.comment = target.comment || task.comment || null;
    task.phase = phase;
    task.error = message || blocker || 'X needs manual verification.';
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

const ensureXBrowserReadyForAction = async (session, payload, target, stage = 'x action') => {
    const targetUrl = target.url || X_HOME_URL;
    const validationUrl = X_HOME_URL;
    if (isPageOpen()) {
        await dismissXDialogs();
        if (await isXLoggedIn()) {
            return 'already-open';
        }
    }

    if (isPageOpen()) {
        await closeBrowser({ preserveTask: true });
    }

    const sessionFile = getXSessionFileForAccountKey(session.accountKey);
    if (fs.existsSync(sessionFile)) {
        console.log(`Trying saved X session for ${session.accountName || session.accountKey}.`);
        try {
            if (await startXWithSavedSession(sessionFile, validationUrl)) {
                currentAccountKey = session.accountKey;
                return 'saved-session';
            }
            await closeBrowser({ preserveTask: true });
            console.log(`Saved X session did not validate as logged in for ${session.accountName || session.accountKey}.`);
        } catch (error) {
            if (error?.manualVerification) {
                throw error;
            }
            console.log(`Saved X session failed for ${session.accountName || session.accountKey}: ${error.message}`);
            await closeBrowser({ preserveTask: true }).catch(() => null);
        }
    }

    if (X_USE_SYSTEM_BROWSER_PROFILE) {
        const browserChannel = String(session.systemBrowserChannel || X_SYSTEM_BROWSER_CHANNEL).trim().toLowerCase();
        const browserName = browserChannel === 'chrome' ? 'Chrome' : 'Edge';
        const profileDirectory = session.systemProfileDirectory || DEFAULT_X_SYSTEM_PROFILE_DIRECTORY;
        const requestedUserDataDir = session.systemUserDataDir || DEFAULT_X_SYSTEM_USER_DATA_DIR;
        const profileAttempts = [];
        if (browserChannel !== 'chrome') {
            profileAttempts.push({
                userDataDir: DEDICATED_X_EDGE_USER_DATA_DIR,
                profileDirectory: DEFAULT_EDGE_PROFILE_DIRECTORY,
                allowCreateProfile: true,
                label: `dedicated Edge bot profile "${DEFAULT_EDGE_PROFILE_DIRECTORY}"`,
            });
        }
        profileAttempts.push({
            userDataDir: requestedUserDataDir,
            profileDirectory,
            allowCreateProfile: false,
            label: `system ${browserName} profile "${profileDirectory}"`,
        });
        if (
            browserChannel !== 'chrome'
            && path.resolve(requestedUserDataDir) !== path.resolve(DEDICATED_X_EDGE_USER_DATA_DIR)
            && !profileAttempts.some(attempt => path.resolve(attempt.userDataDir) === path.resolve(DEDICATED_X_EDGE_USER_DATA_DIR))
        ) {
            profileAttempts.push({
                userDataDir: DEDICATED_X_EDGE_USER_DATA_DIR,
                profileDirectory: DEFAULT_EDGE_PROFILE_DIRECTORY,
                allowCreateProfile: true,
                label: `dedicated Edge bot profile "${DEFAULT_EDGE_PROFILE_DIRECTORY}"`,
            });
        }

        for (const profileAttempt of profileAttempts) {
            console.log(`Trying ${profileAttempt.label} for ${session.accountName || session.accountKey}.`);
            try {
                if (await startXWithSystemBrowserProfile({
                    targetUrl: validationUrl,
                    browserChannel,
                    userDataDir: profileAttempt.userDataDir,
                    profileDirectory: profileAttempt.profileDirectory,
                    allowCreateProfile: profileAttempt.allowCreateProfile,
                })) {
                    currentAccountKey = session.accountKey;
                    session.systemUserDataDir = profileAttempt.userDataDir;
                    session.systemProfileDirectory = profileAttempt.profileDirectory;
                    console.log(`Using ${profileAttempt.label} for X account ${session.accountName || session.accountKey}.`);
                    return 'system-browser-profile';
                }
                session.systemUserDataDir = profileAttempt.userDataDir;
                session.systemProfileDirectory = profileAttempt.profileDirectory;
                await closeBrowser({ preserveTask: true });
                break;
            } catch (error) {
                if (error?.manualVerification) {
                    throw error;
                }
                await closeBrowser({ preserveTask: true }).catch(() => null);
                const profileLocked = /(Chrome|Edge) profile .*already open/i.test(error.message || '');
                const hasFallback = profileAttempts.indexOf(profileAttempt) < profileAttempts.length - 1;
                if (profileLocked && hasFallback) {
                    console.log(`${profileAttempt.label} is already open; trying the next X browser profile.`);
                    continue;
                }
                if (profileLocked) {
                    console.log(`${profileAttempt.label} is already open; falling back to saved X session or login.`);
                    break;
                }
                console.log(`${profileAttempt.label} did not provide an X session for ${session.accountName || session.accountKey}: ${error.message}`);
            }
        }
    }

    const password = getXAccountPassword(payload) || session.accountPassword || '';
    if (X_AUTO_LOGIN && password) {
        session.accountPassword = password;
        console.log(`Logging in to X with credentials for ${session.accountName || session.accountKey}.`);
        try {
            await loginXAndSaveSession({ session, password, targetUrl, stage });
        } catch (error) {
            if (error?.manualVerification) {
                throw error;
            }
            const pausedTask = await markXTaskPaused({
                phase: 'login-needed',
                message: `Automatic X login could not finish for "${session.accountName || stripPlatformAccountKey(session.accountKey)}": ${error.message}. Complete login in the visible browser, then call POST /x/save-session and rerun this row.`,
                loginRequired: true,
                payload,
                session,
                stage,
            });
            throw createXManualVerificationError({ stage, blocker: pausedTask.error, task: pausedTask });
        }
        currentAccountKey = session.accountKey;
        return 'password';
    }

    openXManualLoginChrome(session);
    const pausedTask = await markXTaskPaused({
        phase: 'login-needed',
        message: `Complete X login in the dedicated Chrome window for "${session.accountName || stripPlatformAccountKey(session.accountKey)}", then click Save & Continue. The controller will save and continue this row.`,
        loginRequired: true,
        payload,
        session,
        stage,
    });
    throw createXManualVerificationError({ stage, blocker: pausedTask.error, task: pausedTask });
};

const clickXRepostIfNeeded = async task => {
    await dismissXDialogs();
    const alreadyReposted = page.locator('[data-testid="unretweet"]').first();
    if (await alreadyReposted.isVisible({ timeout: 2500 }).catch(() => false)) {
        task.repostVerification = { verified: true, alreadyReposted: true, at: new Date().toISOString() };
        return { alreadyReposted: true, verified: true };
    }

    const repostButton = page.locator('[data-testid="retweet"]').first();
    if (!await repostButton.isVisible({ timeout: 8000 }).catch(() => false)) {
        throw new Error('Could not find the X Repost button on this post.');
    }

    await repostButton.click({ timeout: 8000 });
    await wait(900);

    const confirmed = await page.waitForFunction(() => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = element => {
            if (!element) return false;
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
        const isEnabled = element => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
        const roots = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"], [aria-modal="true"]')).filter(isVisible);
        const candidates = (roots.length ? roots : [document.body])
            .flatMap(root => Array.from(root.querySelectorAll('[data-testid="retweetConfirm"], button, [role="menuitem"], [role="button"]')))
            .filter(element => isVisible(element) && isEnabled(element))
            .filter(element => {
                const testId = element.getAttribute('data-testid') || '';
                const label = normalize(element.getAttribute('aria-label') || element.textContent);
                return testId === 'retweetConfirm' || /^repost$/i.test(label);
            });
        const target = candidates[0];
        if (!target) return false;
        target.click();
        return true;
    }, { timeout: 10000 }).then(handle => handle.jsonValue()).catch(() => false);

    if (!confirmed) {
        throw new Error('Could not click the X Repost option after opening the repost menu.');
    }

    await wait(1800);
    await dismissXDialogs();
    const verified = await page.locator('[data-testid="unretweet"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    task.repostVerification = { verified, alreadyReposted: false, at: new Date().toISOString() };
    if (!verified) {
        throw new Error('X repost was clicked, but the repost button did not turn active.');
    }
    return { alreadyReposted: false, verified: true };
};

const clickXLikeIfNeeded = async task => {
    await dismissXDialogs();
    const unlike = page.locator('[data-testid="unlike"]').first();
    if (await unlike.isVisible({ timeout: 2500 }).catch(() => false)) {
        task.likeVerification = { verified: true, alreadyLiked: true, at: new Date().toISOString() };
        return { alreadyLiked: true, verified: true };
    }

    const like = page.locator('[data-testid="like"]').first();
    if (!await like.isVisible({ timeout: 8000 }).catch(() => false)) {
        throw new Error('Could not find the X Like button on this post.');
    }

    await like.click({ timeout: 8000 });
    await wait(1800);
    await dismissXDialogs();
    const verified = await page.locator('[data-testid="unlike"]').first().isVisible({ timeout: 3000 }).catch(() => false);
    task.likeVerification = { verified, alreadyLiked: false, at: new Date().toISOString() };
    return { alreadyLiked: false, verified };
};

const fillXReplyComposer = async comment => {
    const textbox = await firstVisibleLocator([
        '[role="dialog"] [data-testid="tweetTextarea_0"][role="textbox"]',
        '[role="dialog"] [data-testid^="tweetTextarea_"][role="textbox"]',
        '[role="dialog"] div[role="textbox"][contenteditable="true"]',
        '[role="dialog"] [contenteditable="true"][role="textbox"]',
        '[data-testid="tweetTextarea_0"][role="textbox"]',
        '[data-testid^="tweetTextarea_"][role="textbox"]',
        'div[role="textbox"][contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
    ]);
    if (!textbox) {
        throw new Error('Could not find the X reply textbox.');
    }

    await textbox.click({ timeout: 8000 });
    await textbox.fill(comment, { timeout: 10000 }).catch(async () => {
        await page.keyboard.press('Control+A').catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
        await page.keyboard.type(comment, { delay: 20 });
    });
    await textbox.evaluate((element, value) => {
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }, comment).catch(() => null);
    await wait(1200);
};

const clickXReplySubmit = async () => {
    const clicked = await page.waitForFunction(() => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = element => {
            if (!element) return false;
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
        const isEnabled = element => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(isVisible);
        const roots = dialogs.length ? dialogs : [document.body];
        const candidates = roots
            .flatMap(root => Array.from(root.querySelectorAll('button, [role="button"]')))
            .filter(element => isVisible(element) && isEnabled(element))
            .filter(element => {
                const testId = element.getAttribute('data-testid') || '';
                const label = normalize(element.getAttribute('aria-label') || element.textContent);
                return /^(reply|post)$/i.test(label) || ['tweetButton', 'tweetButtonInline'].includes(testId);
            })
            .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        const target = candidates[0];
        if (!target) return false;
        target.click();
        return true;
    }, { timeout: 14000 }).then(handle => handle.jsonValue()).catch(() => false);

    if (!clicked) {
        throw new Error('Could not find the X Reply/Post button.');
    }
    return true;
};

const submitXReply = async (task, comment) => {
    await dismissXDialogs();
    const replyButton = page.locator('[data-testid="reply"]').first();
    if (!await replyButton.isVisible({ timeout: 10000 }).catch(() => false)) {
        throw new Error('Could not find the X Reply button on this post.');
    }

    await replyButton.click({ timeout: 8000 });
    await wait(1300);
    if (!await page.locator('[role="dialog"]').first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await wait(1000);
    }
    const loginGate = await getXLoginGate();
    if (loginGate) {
        throw new Error(loginGate);
    }

    await fillXReplyComposer(comment);
    await clickXReplySubmit();
    await wait(5000);
    await dismissXDialogs();

    const expected = normalizeCommentValue(comment);
    const verification = await page.waitForFunction(text => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const bodyText = normalize(document.body?.innerText || '');
        return bodyText.includes(text)
            || /your post was sent|your reply was sent|post sent|reply sent/i.test(bodyText);
    }, expected, { timeout: 18000 }).then(() => true).catch(() => false);

    task.commentVerification = {
        visible: verification,
        method: verification ? 'x-visible-reply-or-toast' : 'x-submit-clicked',
    };

    if (!verification) {
        throw new Error('X reply was submitted, but the posted reply was not visibly verified.');
    }
    await dismissXDialogs();
};

const markXTaskCompleted = async task => {
    if (!task?.accountKey || !task?.contentKey) {
        return null;
    }
    if (!task.commentVerification?.visible) {
        throw new Error('X reply was not visibly verified, so this row will not be marked done.');
    }
    if (!task.repostVerification?.verified) {
        throw new Error('X repost was not visibly verified, so this row will not be marked done.');
    }

    const completedAt = new Date().toISOString();
    const currentUrl = isPageOpen() ? page.url() : null;
    const currentContentKey = currentUrl ? getXContentKey(currentUrl) : null;
    const verifiedPostUrl = currentContentKey === task.contentKey && isXStatusContentKey(currentContentKey)
        ? currentUrl
        : task.finalUrl || task.originalUrl;
    const completedAction = {
        platform: 'x',
        account: task.accountName || stripPlatformAccountKey(task.accountKey),
        accountKey: task.accountKey,
        contentKey: task.contentKey,
        rowNumber: task.rowNumber || null,
        originalUrl: task.originalUrl,
        finalUrl: verifiedPostUrl,
        completedAt,
        comment: task.comment || null,
        verification: task.commentVerification,
        repostVerification: task.repostVerification,
        likeVerification: task.likeVerification || null,
    };
    const thumbnailUrl = await captureActionThumbnail(task);
    if (thumbnailUrl) {
        completedAction.thumbnailUrl = thumbnailUrl;
        task.thumbnailUrl = thumbnailUrl;
    }

    const history = readActionHistory();
    history.completed[getHistoryKey(task.accountKey, task.contentKey)] = completedAction;
    writeActionHistory(history);

    task.phase = 'done';
    task.completedAt = completedAt;
    task.completedAction = completedAction;
    task.updatedAt = completedAt;
    upsertDashboardPost({
        platform: 'x',
        account: completedAction.account,
        accountKey: task.accountKey,
        contentKey: task.contentKey,
        rowNumber: task.rowNumber || null,
        url: completedAction.originalUrl || completedAction.finalUrl,
        status: 'done',
        phase: 'done',
        comment: task.comment || null,
        verification: completedAction.verification,
        repostVerification: completedAction.repostVerification,
        likeVerification: completedAction.likeVerification,
        startedAt: task.startedAt || null,
        completedAt,
        thumbnailUrl: completedAction.thumbnailUrl || null,
    });
    recordTaskEvent(task, 'done', {
        status: 'done',
        completedAt,
        thumbnailUrl: completedAction.thumbnailUrl || null,
        message: 'X repost, like and reply completed',
    });
    console.log(`Recorded completed X action: ${getHistoryKey(task.accountKey, task.contentKey)}`);
    return completedAction;
};

const performXAction = async (session, payload) => {
    const target = getXActionTargetFromPayload(payload);
    if (!target.url) {
        throw new Error('Missing x_url. Send the X post URL from the x_accounts sheet.');
    }
    if (!target.comment) {
        throw new Error('Missing comment_text. Send the reply text from the x_accounts sheet.');
    }

    const completedBefore = await returnCompletedXActionWithoutBrowser(session, target);
    if (completedBefore) {
        return completedBefore;
    }

    await waitForSchedule(payload, `X row ${target.rowNumber || target.contentKey || target.url}`);

    const completedAfterSchedule = await returnCompletedXActionWithoutBrowser(session, target);
    if (completedAfterSchedule) {
        return completedAfterSchedule;
    }

    const now = new Date().toISOString();
    setActiveTask({
        platform: 'x',
        accountKey: session.accountKey,
        accountName: session.accountName || stripPlatformAccountKey(session.accountKey),
        originalUrl: target.url,
        requestedContentKey: target.contentKey,
        contentKey: target.contentKey,
        rowNumber: target.rowNumber,
        comment: target.comment,
        skip: false,
        redirected: false,
        redirectBrowsingDone: false,
        phase: 'starting',
        startedAt: now,
        updatedAt: now,
    });
    const task = ensureCurrentTask();
    recordTaskEvent(task, 'starting', { status: 'running' });

    if (canUseXApiForPayload(payload, session)) {
        return performXApiAction({ session, payload, target, task });
    }

    await ensureXBrowserReadyForAction(session, payload, target, 'x action');

    task.phase = 'navigating';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'navigating', { status: 'running' });
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(5000);
    await dismissXDialogs();
    await throwIfXBlocked('x navigation');

    if (!await isXLoggedIn()) {
        await ensureXBrowserReadyForAction(session, payload, target, 'x post-login navigation');
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await wait(5000);
        await dismissXDialogs();
    }

    const loadedContentKey = await ensureXTargetPostLoaded(target, 'x action');
    task.finalUrl = page.url();
    task.contentKey = loadedContentKey || target.contentKey;
    task.phase = 'loaded';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'loaded', { status: 'running' });

    const completedAfterNavigation = getCompletedAction(task.accountKey, task.contentKey);
    if (completedAfterNavigation) {
        return completedAfterNavigation;
    }

    task.phase = 'reposting';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'reposting', { status: 'running' });
    await clickXRepostIfNeeded(task);

    task.phase = 'liking';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'liking', { status: 'running' });
    await clickXLikeIfNeeded(task);

    task.phase = 'commenting';
    task.updatedAt = new Date().toISOString();
    recordTaskEvent(task, 'commenting', { status: 'running' });
    await submitXReply(task, target.comment);

    const completedAction = await markXTaskCompleted(task);
    await closeBrowserAfterCompletedTask(session, 'x action completion');
    return completedAction;
};

const getXResumePayloadFromTask = (task, fallbackPayload = {}) => {
    if (!task || !isResumableActionTask(task)) {
        return null;
    }
    const url = task.originalUrl || task.finalUrl || getXUrlForContentKey(task.contentKey || task.requestedContentKey);
    const comment = task.comment || fallbackPayload.comment_text || fallbackPayload.comment;
    if (!url || !comment) {
        return null;
    }
    return {
        ...fallbackPayload,
        platform: 'x',
        x_username: task.accountName || stripPlatformAccountKey(task.accountKey),
        account_username: task.accountName || stripPlatformAccountKey(task.accountKey),
        x_url: url,
        row_number: task.rowNumber || fallbackPayload.row_number || fallbackPayload.rowNumber || null,
        comment_text: comment,
    };
};

const sendXManualVerificationResponse = (res, action, errorOrTask, extra = {}) => {
    const task = errorOrTask?.manualVerification ? (errorOrTask.task || getActiveTask()) : errorOrTask;
    const phase = extra.phase || task?.phase || (task?.loginRequired ? 'login-needed' : 'manual-verification');
    return res.status(extra.statusCode || 423).json({
        success: false,
        completed: false,
        status: 'running',
        actionStatus: 'running',
        action,
        platform: 'x',
        account: task?.accountName || stripPlatformAccountKey(task?.accountKey) || extra.account || null,
        accountKey: task?.accountKey || null,
        contentKey: task?.contentKey || task?.requestedContentKey || extra.contentKey || null,
        rowNumber: task?.rowNumber || extra.rowNumber || null,
        ...runningSheetFields(task?.rowNumber || extra.rowNumber || null),
        phase,
        paused: true,
        verificationRequired: phase !== 'login-needed',
        loginRequired: phase === 'login-needed',
        browserVisible: Boolean(isPageOpen()),
        message: extra.message || errorOrTask?.message || task?.error || 'X login/verification is still waiting.',
        next: extra.next || 'Finish X login/verification in the visible browser, then call POST /x/save-session; it will save and resume this row.',
    });
};

const startManualVerificationAutoChecks = () => {
    setInterval(() => {
        for (const session of browserSessions.values()) {
            if (
                session.manualVerificationAutoCheckInFlight
                || getItemPlatform(session) === 'x'
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

const hasDashboardVisibleSessionWork = session => {
    const task = session.currentTask || null;
    const pageOpen = Boolean(session.page && !session.page.isClosed());
    const hasPendingWork = Boolean((session.pendingOperations || 0) > 0 || (session.queuedActionTasks || []).length);
    const hasTarget = Boolean(
        task?.contentKey
        || task?.requestedContentKey
        || task?.finalContentKey
        || task?.originalUrl
        || task?.finalUrl
    );

    if (!pageOpen && !hasPendingWork) {
        return false;
    }

    return Boolean(pageOpen || hasPendingWork || hasTarget);
};

const getActiveSessionsSummary = ({ platform = null } = {}) => {
    const requestedPlatform = normalizePlatform(platform);
    return Array.from(browserSessions.values())
        .filter(session => !requestedPlatform || getItemPlatform(session) === requestedPlatform)
        .filter(hasDashboardVisibleSessionWork)
        .map(session => ({
            platform: getItemPlatform(session),
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
                    platform: getItemPlatform(session.currentTask),
                    contentKey: session.currentTask.contentKey || null,
                    requestedContentKey: session.currentTask.requestedContentKey || null,
                    finalContentKey: session.currentTask.finalContentKey || null,
                    originalUrl: session.currentTask.originalUrl || null,
                    finalUrl: session.currentTask.finalUrl || null,
                    phase: session.currentTask.phase || null,
                    actionState: session.currentTask.actionState || deriveActionState(session.currentTask) || null,
                    actionStateRank: session.currentTask.actionStateRank ?? getActionStateRank(deriveActionState(session.currentTask)),
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

const getActionHistorySummary = ({ accountKey, contentKey, platform = null, limit = 120 } = {}) => {
    const normalizedAccountKey = normalizeAccountName(accountKey);
    const requestedPlatform = normalizePlatform(platform);
    const history = readActionHistory();
    const completedEvents = Object.values(history.completed).map(completed => ({
        id: `completed-${getHistoryKey(normalizeAccountName(completed.accountKey || completed.account), completed.contentKey)}`,
        time: completed.completedAt,
        platform: getItemPlatform(completed),
        account: completed.account || stripPlatformAccountKey(normalizeAccountName(completed.accountKey || completed.account)) || 'default',
        accountKey: normalizeAccountName(completed.accountKey || completed.account) || 'default',
        action: 'done',
        status: 'done',
        actionState: 'done',
        actionStateRank: getActionStateRank('done'),
        contentKey: completed.contentKey || null,
        url: completed.finalUrl || completed.originalUrl || null,
        message: 'Like and comment completed',
        error: null,
    }));

    return [...history.events, ...completedEvents]
        .filter(event => !requestedPlatform || getItemPlatform(event) === requestedPlatform)
        .filter(event => !normalizedAccountKey || event.accountKey === normalizedAccountKey)
        .filter(event => !contentKey || event.contentKey === contentKey)
        .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
        .slice(0, Math.max(1, Number(limit) || 120));
};

app.use((req, _res, next) => {
    const importantRequest = req.method !== 'GET'
        && !req.path.startsWith('/dashboard/posts');
    if (LOG_HTTP_REQUESTS || importantRequest) {
        console.log(`HTTP ${req.method} ${req.path}`);
    }
    next();
});

app.get('/', (_req, res) => {
    res.redirect('/monitor');
});

app.get('/monitor', (_req, res) => {
    res.type('html').send(getMonitorHtml());
});

app.get('/health', (req, res) => {
    const platform = normalizePlatform(req.query.platform);
    const activeSessions = getActiveSessionsSummary({ platform });
    const activeTask = getActiveTask();
    res.json({
        success: true,
        defaultSessionFileExists: fs.existsSync(SESSION_FILE),
        actionHistoryFileExists: fs.existsSync(ACTION_HISTORY_FILE),
        savedAccounts: getSavedAccounts(),
        currentAccount: currentAccountKey || null,
        activeSessions,
        dashboardPosts: getDashboardPostsSummary({ platform }),
        currentTask: activeTask
            ? {
                platform: getItemPlatform(activeTask),
                account: activeTask.accountName || activeTask.accountKey,
                contentKey: activeTask.contentKey || null,
                phase: activeTask.phase || null,
                actionState: activeTask.actionState || deriveActionState(activeTask) || null,
                actionStateRank: activeTask.actionStateRank ?? getActionStateRank(deriveActionState(activeTask)),
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
            platform: req.query.platform,
            limit: req.query.limit,
        }),
    });
});

app.get('/dashboard/posts', (req, res) => {
    const platform = normalizePlatform(req.query.platform);
    res.json({
        success: true,
        posts: getDashboardPostsSummary({ platform }),
    });
});

app.post('/dashboard/posts', (req, res) => {
    try {
        const payload = getPayload(req);
        const rows = getDashboardRowsFromPayload(payload);
        const currentRow = getDashboardCurrentRowFromPayload(payload);
        const platform = getDashboardRowsPlatform(payload, rows, currentRow);
        const posts = rows
            .map(row => getDashboardPostFromPayload(row, { source: 'sheet', platform }))
            .filter(Boolean);
        posts.forEach(rememberDashboardPost);
        const currentPost = currentRow
            ? getDashboardPostFromPayload(currentRow, { source: 'sheet', platform })
            : null;
        const storedPosts = replaceDashboardPosts(posts, {
            platform,
            activePostKey: currentPost ? getDashboardPostKey(currentPost) : null,
        });
        const responseRows = currentRow ? [currentRow] : (rows.length ? rows : [{}]);
        const history = readActionHistory();
        res.json(responseRows.map(row => normalizeDashboardSheetSyncRow(row, storedPosts.length, history)));
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

app.post(['/x/action', '/x/reply'], async (req, res) => {
    let payload = null;
    let session = null;
    try {
        payload = getPayload(req);
        session = getXSessionForRequestPayload(payload);
        session.accountPassword = getXAccountPassword(payload) || session.accountPassword;

        await runInBrowserSession(session, async () => {
            const completedAction = await performXAction(session, payload);
            res.json({
                success: true,
                completed: true,
                status: 'done',
                actionStatus: 'done',
                action: 'x-action',
                platform: 'x',
                account: session.accountName || stripPlatformAccountKey(session.accountKey),
                accountKey: session.accountKey,
                contentKey: completedAction?.contentKey || null,
                completedAction,
                ...completedActionSheetFields(completedAction),
            });
        }, 'x-action');
    } catch (error) {
        console.error('X action error:', error.message);
        if (error?.manualVerification) {
            return sendXManualVerificationResponse(res, 'x-action', error, { statusCode: 200 });
        }
        const target = payload ? getXActionTargetFromPayload(payload) : {};
        const account = session?.accountName || stripPlatformAccountKey(session?.accountKey) || payload?.account_username || null;
        res.json({
            success: false,
            completed: false,
            status: 'failed',
            actionStatus: 'failed',
            action: 'x-action',
            platform: 'x',
            account,
            accountKey: session?.accountKey || null,
            contentKey: target.contentKey || null,
            rowNumber: target.rowNumber || null,
            error: error.message,
            message: error.message,
            ...failedSheetFields(target.rowNumber || null, error.message),
        });
    }
});

app.post('/x/save-session', async (req, res) => {
    try {
        const payload = getPayload(req);
        const session = getXSessionForRequestPayload(payload);
        await runInBrowserSession(session, async () => {
            let sessionFile = getXSessionFileForAccountKey(session.accountKey);
            if (!isPageOpen()) {
                const loggedIn = await connectToXManualChromeSession(session);
                if (!loggedIn) {
                    const task = await markXTaskPaused({
                        phase: 'login-needed',
                        message: 'X is not logged in yet in the dedicated Chrome window. Finish login, then click Save & Continue again.',
                        loginRequired: true,
                        payload,
                        session,
                        stage: 'x save-session',
                    });
                    return sendXManualVerificationResponse(res, 'x-save-session', task, {
                        message: task.error,
                    });
                }
                await saveSession(sessionFile);
                await hideBrowserWindow();
            } else {
                await dismissXDialogs();
                if (!await isXLoggedIn()) {
                    const task = await markXTaskPaused({
                        phase: 'login-needed',
                        message: 'X is not logged in yet. Complete login in the visible browser, then save again.',
                        loginRequired: true,
                        payload,
                        session,
                        stage: 'x save-session',
                    });
                    return sendXManualVerificationResponse(res, 'x-save-session', task, {
                        message: task.error,
                    });
                }
                await saveSession(sessionFile);
                await hideBrowserWindow();
            }

            currentAccountKey = session.accountKey;
            session.manualVerification = null;
            session.manualVerificationResolvedAt = null;
            const task = getActiveTask();
            const resumePayload = AUTO_RESUME_AFTER_MANUAL_VERIFICATION
                ? (getXResumePayloadFromTask(task, payload) || getStoredXResumePayloadForSession(session, payload))
                : null;
            if (task && isManualVerificationTask(task)) {
                task.platform = 'x';
                task.phase = 'ready';
                task.error = null;
                task.verificationRequired = false;
                task.loginRequired = false;
                task.updatedAt = new Date().toISOString();
                recordTaskEvent(task, 'ready', { status: 'running' });
            }

            if (resumePayload) {
                const completedAction = await performXAction(session, resumePayload);
                return res.json({
                    success: true,
                    completed: true,
                    resumed: true,
                    status: 'done',
                    actionStatus: 'done',
                    action: 'x-action',
                    platform: 'x',
                    account: session.accountName || stripPlatformAccountKey(session.accountKey),
                    accountKey: session.accountKey,
                    sessionSaved: true,
                    sessionFile,
                    contentKey: completedAction?.contentKey || null,
                    completedAction,
                    ...completedActionSheetFields(completedAction),
                });
            }

            await hideBrowserWindow();
            res.json({
                success: true,
                platform: 'x',
                account: session.accountName || stripPlatformAccountKey(session.accountKey),
                accountKey: session.accountKey,
                sessionSaved: true,
                sessionFile,
            });
        }, 'x-save-session');
    } catch (error) {
        console.error('X save-session error:', error.message);
        if (error?.manualVerification) {
            return sendXManualVerificationResponse(res, 'x-save-session', error);
        }
        sendError(res, error);
    }
});

app.post('/x/import-chrome-session', async (req, res) => {
    try {
        const payload = getPayload(req);
        const session = getXSessionForRequestPayload(payload);
        const result = await importXSessionFromChromeProfile({
            session,
            chromeUserDataDir: payload.chromeUserDataDir || payload.chrome_user_data_dir,
            chromeProfileDirectory: payload.chromeProfileDirectory || payload.chrome_profile_directory || payload.profile || payload.profileDirectory,
        });
        currentAccountKey = session.accountKey;
        session.manualVerification = null;
        session.manualVerificationResolvedAt = null;
        res.json({
            success: true,
            platform: 'x',
            account: session.accountName || stripPlatformAccountKey(session.accountKey),
            accountKey: session.accountKey,
            sessionSaved: true,
            sessionFile: result.sessionFile,
            chromeUserDataDir: result.userDataDir,
            chromeProfileDirectory: result.profileDirectory,
            next: 'Rerun the X row. It will use this saved session instead of logging in.',
        });
    } catch (error) {
        console.error('X Chrome session import error:', error.message);
        sendError(res, error);
    }
});

app.post('/x/import-edge-session', async (req, res) => {
    try {
        const payload = getPayload(req);
        const session = getXSessionForRequestPayload(payload);
        const result = await importXSessionFromEdgeProfile({
            session,
            edgeUserDataDir: payload.edgeUserDataDir || payload.edge_user_data_dir || payload.userDataDir || payload.user_data_dir,
            edgeProfileDirectory: payload.edgeProfileDirectory || payload.edge_profile_directory || payload.profile || payload.profileDirectory,
        });
        currentAccountKey = session.accountKey;
        session.manualVerification = null;
        session.manualVerificationResolvedAt = null;
        res.json({
            success: true,
            platform: 'x',
            account: session.accountName || stripPlatformAccountKey(session.accountKey),
            accountKey: session.accountKey,
            sessionSaved: true,
            sessionFile: result.sessionFile,
            edgeUserDataDir: result.userDataDir,
            edgeProfileDirectory: result.profileDirectory,
            next: 'Rerun the X row. It will use this saved Edge session instead of logging in.',
        });
    } catch (error) {
        console.error('X Edge session import error:', error.message);
        sendError(res, error);
    }
});

app.post('/x/close', async (req, res) => {
    try {
        const payload = getPayload(req);
        const session = getXSessionForRequestPayload(payload);
        await runInBrowserSession(session, async () => {
            await closeBrowser();
            res.json({
                success: true,
                platform: 'x',
                account: session.accountName || stripPlatformAccountKey(session.accountKey),
                accountKey: session.accountKey,
            });
        }, 'x-close');
    } catch (error) {
        console.error('X close error:', error.message);
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
            const payloadTarget = getActionTargetFromPayload(payload);
            const rememberedPost = findRememberedDashboardPost({
                accountKey,
                contentKey: payloadTarget.contentKey,
                rowNumber: payloadTarget.rowNumber,
                url: payloadTarget.url,
            });
            await ensureBrowserReadyForAction(session, payload, {
                url: payloadTarget.url || rememberedPost?.url || null,
                contentKey: payloadTarget.contentKey || rememberedPost?.contentKey || null,
                rowNumber: payloadTarget.rowNumber || rememberedPost?.rowNumber || null,
                comment: payloadTarget.comment || rememberedPost?.comment || null,
            }, 'save-session');

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
                rowNumber: task.rowNumber || null,
                url,
                status: 'running',
                phase: 'navigating',
                startedAt: task.startedAt,
            });
            recordTaskEvent(task, 'navigating', { status: 'running' });

            console.log(`Navigating ${session.accountName} to: ${url}`);
            await dismissInstagramDialogs();
            const navigationRecovery = await gotoWithBrowserRecovery(session, payload, url, 'navigation', {
                contentKey: requestedContentKey,
                rowNumber: task.rowNumber || null,
                comment: task.comment || null,
            });
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
                rowNumber: task.rowNumber || null,
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
                recoveredBrowser: navigationRecovery === 'recovered',
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

            await ensureBrowserReadyForAction(session, payload, payloadTarget, 'like');
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
                    task.likeVerification = {
                        verified: true,
                        alreadyLiked: true,
                        stage: 'like',
                        at: new Date().toISOString(),
                    };
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
            const verifiedUnlike = await verifyLikedOrContinue(session, task, 'like verification');
            console.log(verifiedUnlike
                ? `Liked and verified for ${session.accountName}. Unlike button: ${JSON.stringify(verifiedUnlike.clickRect)}`
                : `Like click was not visibly verified for ${session.accountName}; continuing workflow.`);
            if (task) {
                task.phase = 'liked';
                task.updatedAt = new Date().toISOString();
                recordTaskEvent(task, 'liked', { status: 'running' });
            }
            res.json({
                success: true,
                account: session.accountName,
                verified: Boolean(verifiedUnlike),
                warning: verifiedUnlike ? null : task?.likeVerification?.warning || null,
            });
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
                        ...completedActionSheetFields(completedQueuedAction),
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
                            ...completedActionSheetFields(completedQueuedAction),
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
                            ...completedActionSheetFields(completedQueuedAction),
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
                    ...completedActionSheetFields(completedRecoveredAction),
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
            const queuedActionsWaiting = (session.queuedActionTasks || []).filter(task => task.comment).length;
            const browserClosed = await closeBrowserAfterCompletedTask(session, 'comment completion');
            const queuedDrainScheduled = scheduleQueuedActionDrain(session, 'comment completion');

            res.json({
                success: true,
                completed: true,
                status: 'done',
                actionStatus: 'done',
                account: session.accountName,
                completedAction,
                queuedActionsWaiting,
                browserClosed,
                queuedDrainScheduled,
                ...completedActionSheetFields(completedAction),
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
                    ...completedActionSheetFields(completedAction),
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
