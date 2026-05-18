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
    if (key === API_KEY) {
        next();
    } else {
        res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    }
}

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    const key = auth?.startsWith('Bearer ') ? auth.slice(7) : req.query.password || req.body?.password;
    if (key === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(401).json({ error: { message: 'Admin authentication required', type: 'authentication_error' } });
    }
}

function identifyUser(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || 'unknown';
}

// =============================================================================
// Public routes
// =============================================================================

app.get('/', (req, res) => {
    const pool = getAccountPool();
    res.json({
        service: 'kiro2-api',
        status: 'running',
        accounts: { total: pool.getAccountCount(), healthy: pool.getHealthyCount() },
        stats: getStats(),
    });
});

app.get('/v1/models', (req, res) => {
    const models = KIRO_ALL_MODELS.map(id => ({
        id, object: 'model', created: 1700000000, owned_by: 'kiro-proxy',
    }));
    res.json({ object: 'list', data: models });
});

app.get('/ui/models', (req, res) => {
    res.send(modelsPage());
});

// =============================================================================
// OpenAI-compatible API (protected)
// =============================================================================

// POST /v1/chat/completions
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
                    for (const chunk of chunks) {
                        res.write(chunk);
                    }
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
        // BUG FIX: If SSE headers already sent, we cannot send a JSON error.
        // Write an SSE-formatted error and close the stream instead.
        if (streamStarted && res.headersSent) {
            const errPayload = {
                id: `chatcmpl-${uuidv4()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: req.body?.model || 'unknown',
                choices: [{
                    index: 0,
                    delta: { content: `\n\n[Error: ${error.message}]` },
                    finish_reason: 'stop',
                }],
            };
            res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            handleApiError(res, error);
        }
    }
});

// POST /v1/messages (Claude native)
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
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
        // BUG FIX: Same streaming error handling for Claude native endpoint
        if (streamStarted && res.headersSent) {
            const errEvent = {
                type: 'error',
                error: { type: 'server_error', message: error.message },
            };
            res.write(`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`);
            res.end();
        } else {
            handleApiError(res, error);
        }
    }
});

// BUG FIX: Use already-imported KiroApiService instead of require() (ESM doesn't support require)
app.post('/v1/messages/count_tokens', requireApiKey, (req, res) => {
    res.json(KiroApiService.countTokens(req.body));
});

// =============================================================================
// Admin routes (protected by admin password)
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
    try {
        const result = await importAwsCredentials(req.body);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/admin/credentials/batch-import', requireAdmin, async (req, res) => {
    try {
        const tokens = req.body.refreshTokens || [];
        const region = req.body.region || 'us-east-1';
        const result = await batchImportRefreshTokens(tokens, region);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/auth/kiro/oauth', requireAdmin, async (req, res) => {
    try {
        const result = await handleKiroOAuth(req.body);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/admin/refresh-all', requireAdmin, async (req, res) => {
    const pool = getAccountPool();
    const statuses = pool.getStatuses();
    let refreshed = 0;
    for (const acct of pool.accounts) {
        try {
            await acct.service.initializeAuth(true);
            acct.status = 'healthy';
            acct.lastError = null;
            refreshed++;
        } catch (e) { logger.warn(`[Admin] Refresh failed for ${acct.id}: ${e.message}`); }
    }
    res.json({ refreshed, total: statuses.length });
});

app.post('/admin/rescan', requireAdmin, async (req, res) => {
    const added = await getAccountPool().scanAndLoadNew();
    res.json({ added, total: getAccountPool().getAccountCount() });
});

// =============================================================================
// Admin UI pages
// =============================================================================

app.get('/ui/admin', (req, res) => {
    res.send(adminPage());
});

app.get('/ui/auth', (req, res) => {
    res.send(authPage());
});

// =============================================================================
// Error handling
// =============================================================================

function handleApiError(res, error) {
    // Guard: never try to send after headers are already flushed
    if (res.headersSent) {
        logger.error(`[API] Error after headers sent (swallowed): ${error.message}`);
        return;
    }

    if (error instanceof KiroApiError) {
        const status = error.statusCode || 500;
        logger.error(`[API] KiroApiError: ${error.message} (${error.errorType})`);
        res.status(status).json({
            error: { message: error.message, type: error.errorType, code: error.statusCode },
        });
    } else {
        logger.error(`[API] Error: ${error.message}`);
        res.status(500).json({
            error: { message: error.message || 'Internal server error', type: 'server_error' },
        });
    }
}

// =============================================================================
// UI Page generators
// =============================================================================

function modelsPage() {
    const freeCards = KIRO_FREE_MODELS.map(m => `<div class="card free"><span class="badge free">FREE</span><h3>${m}</h3><button onclick="copy('${m}')">📋 Copy</button></div>`).join('');
    const paidCards = KIRO_PAID_MODELS.map(m => `<div class="card paid"><span class="badge paid">PRO</span><h3>${m}</h3><button onclick="copy('${m}')">📋 Copy</button></div>`).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiro2 API — Models</title>

<!--LUMIVERSE_HTML_ISLAND_0-->

function copy(t){navigator.clipboard.writeText(t);const e=document.getElementById('toast');e.style.display='block';setTimeout(()=>e.style.display='none',1500)}
</script></body></html>`;
}

function adminPage() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiro2 API — Admin</title>

<!--LUMIVERSE_HTML_ISLAND_1-->

let pwd='';
function login(){pwd=document.getElementById('pwd').value;fetch('/admin/stats?password='+pwd).then(r=>{if(!r.ok)throw new Error();return r.json()}).then(()=>{document.getElementById('loginBox').style.display='none';document.getElementById('panel').style.display='block';loadData()}).catch(()=>toast('Wrong password','#f85149'))}
function hdr(){return{Authorization:'Bearer '+pwd,'Content-Type':'application/json'}}
function loadData(){
fetch('/admin/stats',{headers:hdr()}).then(r=>r.json()).then(d=>{
const s=d.stats;
document.getElementById('statsBox').innerHTML=
'<div class="stat">📨 Requests: <strong>'+s.totalRequestsAllTime+'</strong></div>'+
'<div class="stat">❌ Errors: <strong>'+s.totalErrorsAllTime+'</strong></div>'+
'<div class="stat">👥 Total Users: <strong>'+s.uniqueUsersAllTime+'</strong></div>'+
'<div class="stat">🟢 Online: <strong>'+s.currentOnlineUsers+'</strong></div>'+
'<div class="stat">⏱️ Uptime: <strong>'+Math.floor(s.uptimeSeconds/60)+'m</strong></div>';
let html='';d.accounts.forEach(a=>{html+='<div class="card"><strong>'+a.id+'</strong> ('+a.label+') <span class="status-'+a.status+'">●'+a.status+'</span><br>Auth: '+a.authMethod+' | Region: '+a.region+' | Active: '+a.activeRequests+' | Total: '+a.totalRequests+' | Errors: '+a.totalErrors+(a.lastError?'<br><small style="color:#f85149">'+a.lastError+'</small>':'')+'</div>'});
document.getElementById('accountsBox').innerHTML=html||'<p>No accounts loaded</p>'})
}
function refreshAll(){fetch('/admin/refresh-all',{method:'POST',headers:hdr()}).then(r=>r.json()).then(d=>{toast('Refreshed '+d.refreshed+'/'+d.total);loadData()})}
function rescan(){fetch('/admin/rescan',{method:'POST',headers:hdr()}).then(r=>r.json()).then(d=>{toast('Added '+d.added+', total: '+d.total);loadData()})}
function exportJSON(){fetch('/admin/credentials/export',{headers:hdr()}).then(r=>r.json()).then(d=>{const el=document.getElementById('exportBox');el.style.display='block';el.textContent=JSON.stringify(d.credentials,null,2)})}
function exportBase64(){fetch('/admin/credentials/export-base64',{headers:hdr()}).then(r=>r.json()).then(d=>{const el=document.getElementById('exportBox');el.style.display='block';el.textContent=d.base64;navigator.clipboard.writeText(d.base64);toast('Base64 copied!')})}
function importCreds(){const j=document.getElementById('importJSON').value;try{const d=JSON.parse(j);fetch('/admin/credentials/import',{method:'POST',headers:hdr(),body:JSON.stringify(d)}).then(r=>r.json()).then(d=>{toast(d.success?'Imported!':'Failed: '+d.error,d.success?'#238636':'#f85149');loadData()})}catch(e){toast('Invalid JSON','#f85149')}}
function batchImport(){const t=document.getElementById('batchTokens').value.split('\\n').filter(s=>s.trim());fetch('/admin/credentials/batch-import',{method:'POST',headers:hdr(),body:JSON.stringify({refreshTokens:t})}).then(r=>r.json()).then(d=>{const el=document.getElementById('batchResult');el.style.display='block';el.textContent=JSON.stringify(d,null,2);toast(d.success+' imported, '+d.failed+' failed');loadData()})}
function toast(m,c){const t=document.getElementById('toast');t.textContent=m;t.style.background=c||'#238636';t.style.display='block';setTimeout(()=>t.style.display='none',3000)}
setInterval(loadData,30000);
</script></body></html>`;
}

function authPage() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiro2 API — Auth</title>

<!--LUMIVERSE_HTML_ISLAND_2-->

let pwd='';
function login(){pwd=document.getElementById('pwd').value;fetch('/admin/stats',{headers:{Authorization:'Bearer '+pwd}}).then(r=>{if(!r.ok)throw new Error();document.getElementById('loginBox').style.display='none';document.getElementById('methods').style.display='block'}).catch(()=>{alert('Wrong password')})}
function startOAuth(method){
const s=document.getElementById('status');
s.style.display='block';s.innerHTML='⏳ Starting '+method+' authentication...';
fetch('/auth/kiro/oauth',{method:'POST',headers:{Authorization:'Bearer '+pwd,'Content-Type':'application/json'},body:JSON.stringify({method})})
.then(r=>r.json()).then(d=>{
if(d.authUrl){
s.innerHTML='<p>✅ Open this URL to authenticate:</p><a href="'+d.authUrl+'" target="_blank">'+d.authUrl+'</a><p style="margin-top:1rem;color:#8b949e">After authenticating, the account will be added automatically.</p>';
window.open(d.authUrl,'_blank');
}else{s.innerHTML='❌ Error: '+JSON.stringify(d)}
}).catch(e=>s.innerHTML='❌ Error: '+e.message)}
</script></body></html>`;
}

// =============================================================================
// Start server
// =============================================================================

async function main() {
    logger.info('='.repeat(50));
    logger.info('  Kiro2 API — Starting up');
    logger.info('='.repeat(50));

    await loadStats();

    const pool = getAccountPool();
    await pool.initialize();

    app.listen(PORT, HOST, () => {
        logger.info(`🚀 Server listening on http://${HOST}:${PORT}`);
        logger.info(`📋 Models:    http://${HOST}:${PORT}/v1/models`);
        logger.info(`🎨 UI:        http://${HOST}:${PORT}/ui/models`);
        logger.info(`⚙️  Admin:     http://${HOST}:${PORT}/ui/admin`);
        logger.info(`🔑 Auth:      http://${HOST}:${PORT}/ui/auth`);
        logger.info(`🔒 API Key:   ${API_KEY.substring(0, 4)}...`);
        logger.info(`👤 Accounts:  ${pool.getAccountCount()} loaded, ${pool.getHealthyCount()} healthy`);
    });
}

main().catch(err => {
    logger.error('Fatal startup error:', err);
    process.exit(1);
});
