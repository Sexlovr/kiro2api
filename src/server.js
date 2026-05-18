import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';
import { getAccountPool } from './pool/account-pool.js';
import { KIRO_FREE_MODELS, KIRO_PAID_MODELS, KIRO_ALL_MODELS, KiroApiService } from './providers/claude-kiro.js';
import { KiroApiError } from './providers/kiro-error.js';
import { toClaudeRequestFromOpenAI, toOpenAIChatCompletionFromClaude, ClaudeToOpenAIStreamAdapter } from './convert/convert.js';
import { handleKiroOAuth, batchImportRefreshTokens, importAwsCredentials } from './auth/kiro-oauth.js';
import { recordRequest, recordError, getStats, loadStats, saveStats } from './tracking/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));

// =============================================================================
// Config
// =============================================================================

const PORT = parseInt(process.env.PORT, 10) || 7860;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || 'here-you-go-ai';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-please';

// =============================================================================
// Middleware
// =============================================================================

function requireApiKey(req, res, next) {
    const auth = req.headers.authorization;
    const key = auth?.startsWith('Bearer ') ? auth.slice(7) : req.query.key;
    if (key === API_KEY) return next();
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
}

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    const key = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (key === ADMIN_PASSWORD) return next();
    res.status(401).json({ error: { message: 'Admin auth required', type: 'authentication_error' } });
}

function identifyUser(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress || 'unknown';
}

// =============================================================================
// Root — Single-page dashboard (public HTML, admin features behind password)
// =============================================================================

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildMainPage());
});

// Models page (public)
app.get('/ui/models', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildModelsPage());
});

// =============================================================================
// JSON API — Models (public)
// =============================================================================

app.get('/v1/models', (req, res) => {
    const models = KIRO_ALL_MODELS.map(id => ({
        id, object: 'model', created: 1700000000, owned_by: 'kiro-proxy',
    }));
    res.json({ object: 'list', data: models });
});

// =============================================================================
// OpenAI-compatible chat (protected by API key)
// =============================================================================

app.post('/v1/chat/completions', requireApiKey, async (req, res) => {
    const user = identifyUser(req);
    recordRequest(user);
    let streamStarted = false;

    try {
        const claudeRequest = toClaudeRequestFromOpenAI(req.body);
        const model = claudeRequest.model || 'claude-sonnet-4-5';
        const isStream = claudeRequest.stream === true;
        const pool = getAccountPool();
        const { account, release } = pool.acquireAccount();

        try {
            if (isStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                streamStarted = true;

                const adapter = new ClaudeToOpenAIStreamAdapter(req.body.model || model);
                for await (const event of account.service.generateContentStream(model, claudeRequest)) {
                    const chunks = adapter.convert(event);
                    for (const chunk of chunks) res.write(chunk);
                }
                res.end();
                release();
            } else {
                const claudeResponse = await account.service.generateContent(model, claudeRequest);
                const openaiResponse = toOpenAIChatCompletionFromClaude(claudeResponse, req.body.model || model);
                release();
                res.json(openaiResponse);
            }
        } catch (error) {
            release(error);
            throw error;
        }
    } catch (error) {
        recordError();
        if (streamStarted && res.headersSent) {
            const errPayload = { id: 'err-' + uuidv4(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: req.body?.model || 'unknown', choices: [{ index: 0, delta: { content: '\n\n[Error: ' + error.message + ']' }, finish_reason: 'stop' }] };
            res.write('data: ' + JSON.stringify(errPayload) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            handleApiError(res, error);
        }
    }
});

// Claude native messages (protected by API key)
app.post('/v1/messages', requireApiKey, async (req, res) => {
    const user = identifyUser(req);
    recordRequest(user);
    let streamStarted = false;

    try {
        const model = req.body.model || 'claude-sonnet-4-5';
        const isStream = req.body.stream === true;
        const pool = getAccountPool();
        const { account, release } = pool.acquireAccount();

        try {
            if (isStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                streamStarted = true;

                for await (const event of account.service.generateContentStream(model, req.body)) {
                    res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
                }
                res.end();
                release();
            } else {
                const response = await account.service.generateContent(model, req.body);
                release();
                res.json(response);
            }
        } catch (error) {
            release(error);
            throw error;
        }
    } catch (error) {
        recordError();
        if (streamStarted && res.headersSent) {
            res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'server_error', message: error.message } }) + '\n\n');
            res.end();
        } else {
            handleApiError(res, error);
        }
    }
});

app.post('/v1/messages/count_tokens', requireApiKey, (req, res) => {
    res.json(KiroApiService.countTokens(req.body));
});

// =============================================================================
// Admin API routes (protected by admin password)
// =============================================================================

app.get('/admin/stats', requireAdmin, (req, res) => {
    const pool = getAccountPool();
    res.json({ stats: getStats(), accounts: pool.getStatuses() });
});

app.get('/admin/accounts', requireAdmin, (req, res) => {
    res.json({ accounts: getAccountPool().getStatuses() });
});

app.get('/admin/credentials/export', requireAdmin, (req, res) => {
    res.json({ credentials: getAccountPool().exportAllCredentials() });
});

app.get('/admin/credentials/export-base64', requireAdmin, (req, res) => {
    res.json({ base64: getAccountPool().exportAllCredentialsBase64() });
});

app.post('/admin/credentials/import', requireAdmin, async (req, res) => {
    try { res.json(await importAwsCredentials(req.body)); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/credentials/batch-import', requireAdmin, async (req, res) => {
    try {
        const tokens = req.body.refreshTokens || [];
        const region = req.body.region || 'us-east-1';
        res.json(await batchImportRefreshTokens(tokens, region));
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/auth/kiro/oauth', requireAdmin, async (req, res) => {
    try { res.json(await handleKiroOAuth(req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/refresh-all', requireAdmin, async (req, res) => {
    const pool = getAccountPool();
    let refreshed = 0;
    for (const acct of pool.accounts) {
        try {
            await acct.service.initializeAuth(true);
            acct.status = 'healthy';
            acct.lastError = null;
            refreshed++;
        } catch (e) { logger.warn('[Admin] Refresh failed: ' + e.message); }
    }
    res.json({ refreshed, total: pool.getAccountCount() });
});

app.post('/admin/rescan', requireAdmin, async (req, res) => {
    const added = await getAccountPool().scanAndLoadNew();
    res.json({ added, total: getAccountPool().getAccountCount() });
});

// =============================================================================
// Health check (JSON for monitoring)
// =============================================================================

app.get('/api/health', (req, res) => {
    const pool = getAccountPool();
    res.json({ service: 'kiro2-api', status: 'running', accounts: { total: pool.getAccountCount(), healthy: pool.getHealthyCount() }, stats: getStats() });
});

// =============================================================================
// Error handler
// =============================================================================

function handleApiError(res, error) {
    if (res.headersSent) { logger.error('[API] Error after headers sent: ' + error.message); return; }
    const status = (error instanceof KiroApiError && error.statusCode) ? error.statusCode : 500;
    const type = (error instanceof KiroApiError) ? error.errorType : 'server_error';
    logger.error('[API] ' + type + ': ' + error.message);
    res.status(status).json({ error: { message: error.message, type, code: status } });
}

// =============================================================================
// Page builders
// =============================================================================

function buildMainPage() {
    const freeModelsJSON = JSON.stringify(KIRO_FREE_MODELS);
    const paidModelsJSON = JSON.stringify(KIRO_PAID_MODELS);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiro2 API</title>

<!--LUMIVERSE_HTML_ISLAND_0-->


<!-- ======================== LOGIN ======================== -->

<!--LUMIVERSE_HTML_ISLAND_1-->


<div class="toast" id="toast"></div>

<script>
const FREE_MODELS = ${freeModelsJSON};
const PAID_MODELS = ${paidModelsJSON};
let adminPwd = '';
let loggedIn = false;

// ========== PAGE NAV ==========
function showPage(name) {
    if (['dashboard','auth','export'].includes(name) && !loggedIn) {
        showPage('login');
        toast('Please login first', '#f85149');
        return;
    }
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
    const page = document.getElementById('page-' + name);
    const nav = document.getElementById('nav-' + name);
    if (page) page.classList.add('active');
    if (nav) nav.classList.add('active');
    if (name === 'dashboard') loadDashboard();
    if (name === 'models') renderModels();
}

// ========== LOGIN ==========
function doLogin() {
    adminPwd = document.getElementById('pwdInput').value;
    if (!adminPwd) { toast('Enter a password', '#f85149'); return; }

    fetch('/admin/stats', { headers: { 'Authorization': 'Bearer ' + adminPwd } })
        .then(r => {
            if (!r.ok) throw new Error('Wrong password');
            return r.json();
        })
        .then(() => {
            loggedIn = true;
            document.getElementById('headerInfo').textContent = 'Admin \\u2714';
            document.getElementById('headerInfo').style.borderColor = '#3fb950';

            // Rebuild nav with admin tabs
            const nav = document.getElementById('navBar');
            nav.innerHTML = '';
            var tabs = [
                ['models', '\\u{1F4CB} Models'],
                ['dashboard', '\\u{1F4CA} Dashboard'],
                ['auth', '\\u{1F511} Add Account'],
                ['export', '\\u{1F4E6} Export'],
            ];
            tabs.forEach(function(t) {
                var btn = document.createElement('button');
                btn.id = 'nav-' + t[0];
                btn.textContent = t[1];
                btn.onclick = function() { showPage(t[0]); };
                nav.appendChild(btn);
            });

            toast('Logged in!', '#3fb950');
            showPage('dashboard');
        })
        .catch(() => {
            toast('Wrong password', '#f85149');
            adminPwd = '';
        });
}

// Enter key support
document.getElementById('pwdInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doLogin();
});

function hdr() { return { 'Authorization': 'Bearer ' + adminPwd, 'Content-Type': 'application/json' }; }

// ========== MODELS ==========
function renderModels() {
    renderModelGrid('freeModels', FREE_MODELS, 'free', 'FREE');
    renderModelGrid('paidModels', PAID_MODELS, 'paid', 'PRO');
}
function renderModelGrid(containerId, models, badgeClass, badgeText) {
    var container = document.getElementById(containerId);
    container.innerHTML = '';
    models.forEach(function(m) {
        var div = document.createElement('div');
        div.className = 'model-card';
        div.onclick = function() { copyText(m); };
        div.innerHTML = '<span class="badge ' + badgeClass + '">' + badgeText + '</span><h3>' + m + '</h3><small style="color:var(--dim)">Click to copy</small>';
        container.appendChild(div);
    });
}

// ========== DASHBOARD ==========
function loadDashboard() {
    fetch('/admin/stats', { headers: hdr() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var s = d.stats;
            var grid = document.getElementById('statsGrid');
            grid.innerHTML =
                statCard(s.totalRequestsAllTime, '\\u{1F4E8} Requests') +
                statCard(s.totalErrorsAllTime, '\\u274C Errors') +
                statCard(s.uniqueUsersAllTime, '\\u{1F465} Total Users') +
                statCard(s.currentOnlineUsers, '\\u{1F7E2} Online Now') +
                statCard(Math.floor(s.uptimeSeconds / 60) + 'm', '\\u23F1 Uptime');

            var list = document.getElementById('accountsList');
            if (!d.accounts || d.accounts.length === 0) {
                list.innerHTML = '<div class="card"><p style="color:var(--dim)">No accounts loaded. Go to <strong>Add Account</strong> to get started.</p></div>';
                return;
            }
            var html = '';
            d.accounts.forEach(function(a) {
                html += '<div class="card">' +
                    '<span class="account-status ' + a.status + '"></span>' +
                    '<strong>' + a.id + '</strong> <span style="color:var(--dim)">(' + a.label + ')</span>' +
                    '<div style="margin-top:8px;font-size:.85rem;color:var(--dim)">' +
                    'Auth: ' + a.authMethod + ' | Region: ' + a.region +
                    ' | Active: ' + a.activeRequests + ' | Total: ' + a.totalRequests +
                    ' | Errors: ' + a.totalErrors +
                    (a.lastError ? '<br><span style="color:var(--red)">' + a.lastError + '</span>' : '') +
                    '</div></div>';
            });
            list.innerHTML = html;
        })
        .catch(function(e) { toast('Failed to load stats: ' + e.message, '#f85149'); });
}

function statCard(value, label) {
    return '<div class="stat-card"><div class="number">' + value + '</div><div class="label">' + label + '</div></div>';
}

function refreshAll() {
    fetch('/admin/refresh-all', { method: 'POST', headers: hdr() })
        .then(function(r) { return r.json(); })
        .then(function(d) { toast('Refreshed ' + d.refreshed + '/' + d.total, '#3fb950'); loadDashboard(); })
        .catch(function(e) { toast('Error: ' + e.message, '#f85149'); });
}

function rescanConfigs() {
    fetch('/admin/rescan', { method: 'POST', headers: hdr() })
        .then(function(r) { return r.json(); })
        .then(function(d) { toast('Found ' + d.added + ' new, total: ' + d.total, '#3fb950'); loadDashboard(); })
        .catch(function(e) { toast('Error: ' + e.message, '#f85149'); });
}

// ========== AUTH ==========
function startOAuth(method) {
    var el = document.getElementById('authResult');
    el.style.display = 'block';
    el.innerHTML = '<p style="color:var(--dim)">\\u23F3 Starting ' + method + ' authentication...</p>';

    fetch('/auth/kiro/oauth', {
        method: 'POST',
        headers: hdr(),
        body: JSON.stringify({ method: method })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
        if (d.authUrl) {
            el.innerHTML = '<p>\\u2705 Open this link to authenticate:</p><a href="' + d.authUrl + '" target="_blank">' + d.authUrl + '</a><p style="margin-top:1rem;color:var(--dim)">After authenticating, the account will be added automatically.</p>';
            window.open(d.authUrl, '_blank');
        } else if (d.error) {
            el.innerHTML = '<p style="color:var(--red)">\\u274C Error: ' + d.error + '</p>';
        }
    })
    .catch(function(e) { el.innerHTML = '<p style="color:var(--red)">\\u274C ' + e.message + '</p>'; });
}

function importCreds() {
    var raw = document.getElementById('importJSON').value;
    var data;
    try { data = JSON.parse(raw); } catch (e) { toast('Invalid JSON', '#f85149'); return; }

    fetch('/admin/credentials/import', { method: 'POST', headers: hdr(), body: JSON.stringify(data) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.success) { toast('Account imported!', '#3fb950'); document.getElementById('importJSON').value = ''; }
            else toast('Failed: ' + d.error, '#f85149');
        })
        .catch(function(e) { toast('Error: ' + e.message, '#f85149'); });
}

function batchImport() {
    var lines = document.getElementById('batchTokens').value.split('\\n').filter(function(s) { return s.trim(); });
    if (lines.length === 0) { toast('No tokens entered', '#f85149'); return; }

    fetch('/admin/credentials/batch-import', {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({ refreshTokens: lines })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
        var el = document.getElementById('batchResult');
        el.classList.remove('hidden');
        el.textContent = JSON.stringify(d, null, 2);
        toast(d.success + ' imported, ' + d.failed + ' failed', d.success > 0 ? '#3fb950' : '#f85149');
    })
    .catch(function(e) { toast('Error: ' + e.message, '#f85149'); });
}

// ========== EXPORT ==========
function exportJSON() {
    fetch('/admin/credentials/export', { headers: hdr() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var el = document.getElementById('exportBox');
            el.classList.remove('hidden');
            el.textContent = JSON.stringify(d.credentials, null, 2);
        })
        .catch(function(e) { toast('Error: ' + e.message, '#f85149'); });
}

function exportBase64() {
    fetch('/admin/credentials/export-base64', { headers: hdr() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var el = document.getElementById('exportBox');
            el.classList.remove('hidden');
            el.textContent = d.base64;
            copyText(d.base64);
            toast('Base64 copied to clipboard!', '#3fb950');
        })
        .catch(function(e) { toast('Error: ' + e.message, '#f85149'); });
}

// ========== UTILS ==========
function copyText(text) {
    navigator.clipboard.writeText(text).then(function() {
        toast('Copied!', '#3fb950');
    }).catch(function() {
        // Fallback
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('Copied!', '#3fb950');
    });
}

function toast(msg, color) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.style.background = color || '#3fb950';
    t.style.display = 'block';
    setTimeout(function() { t.style.display = 'none'; }, 3000);
}

// ========== INIT ==========
renderModels();
showPage('models');
</script>
</body>
</html>`;
}

function buildModelsPage() {
    const freeCards = KIRO_FREE_MODELS.map(m =>
        '<div class="mc" onclick="c(\'' + m + '\')"><span class="b free">FREE</span><h3>' + m + '</h3><small>Click to copy</small></div>'
    ).join('');
    const paidCards = KIRO_PAID_MODELS.map(m =>
        '<div class="mc" onclick="c(\'' + m + '\')"><span class="b paid">PRO</span><h3>' + m + '</h3><small>Click to copy</small></div>'
    ).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiro2 API Models</title>

<!--LUMIVERSE_HTML_ISLAND_2-->

}

// =============================================================================
// Start
// =============================================================================

async function main() {
    logger.info('==================================================');
    logger.info('  Kiro2 API — Starting');
    logger.info('==================================================');
    await loadStats();
    const pool = getAccountPool();
    await pool.initialize();

    app.listen(PORT, HOST, () => {
        logger.info('Server: http://' + HOST + ':' + PORT);
        logger.info('Accounts: ' + pool.getAccountCount() + ' loaded, ' + pool.getHealthyCount() + ' healthy');
    });
}

main().catch(err => { logger.error('Fatal: ' + err.message); process.exit(1); });
