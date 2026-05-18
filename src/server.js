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
import { buildMainPage, buildModelsPage } from './pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT, 10) || 7860;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || 'here-you-go-ai';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-please';

// =============================================================================
// Middleware
// =============================================================================

function requireApiKey(req, res, next) {
    var auth = req.headers.authorization;
    var key = auth && auth.startsWith('Bearer ') ? auth.slice(7) : req.query.key;
    if (key === API_KEY) return next();
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
}

function requireAdmin(req, res, next) {
    var auth = req.headers.authorization;
    var key = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (key === ADMIN_PASSWORD) return next();
    res.status(401).json({ error: { message: 'Admin auth required', type: 'authentication_error' } });
}

function identifyUser(req) {
    var fwd = req.headers['x-forwarded-for'];
    return (fwd ? fwd.split(',')[0].trim() : null) || req.socket.remoteAddress || 'unknown';
}

// =============================================================================
// HTML pages
// =============================================================================

app.get('/', function(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildMainPage(KIRO_FREE_MODELS, KIRO_PAID_MODELS));
});

app.get('/ui/models', function(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildModelsPage(KIRO_FREE_MODELS, KIRO_PAID_MODELS));
});

// =============================================================================
// JSON API — Models (public)
// =============================================================================

app.get('/v1/models', function(req, res) {
    var models = KIRO_ALL_MODELS.map(function(id) {
        return { id: id, object: 'model', created: 1700000000, owned_by: 'kiro-proxy' };
    });
    res.json({ object: 'list', data: models });
});

// =============================================================================
// OpenAI-compatible chat (API key protected)
// =============================================================================

app.post('/v1/chat/completions', requireApiKey, async function(req, res) {
    var user = identifyUser(req);
    recordRequest(user);
    var streamStarted = false;

    try {
        var claudeRequest = toClaudeRequestFromOpenAI(req.body);
        var model = claudeRequest.model || 'claude-sonnet-4-5';
        var isStream = claudeRequest.stream === true;
        var pool = getAccountPool();
        var acquired = pool.acquireAccount();
        var account = acquired.account;
        var release = acquired.release;

        try {
            if (isStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                streamStarted = true;

                var adapter = new ClaudeToOpenAIStreamAdapter(req.body.model || model);
                for await (var event of account.service.generateContentStream(model, claudeRequest)) {
                    var chunks = adapter.convert(event);
                    for (var i = 0; i < chunks.length; i++) res.write(chunks[i]);
                }
                res.end();
                release();
            } else {
                var claudeResponse = await account.service.generateContent(model, claudeRequest);
                var openaiResponse = toOpenAIChatCompletionFromClaude(claudeResponse, req.body.model || model);
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
            res.write('data: {"error":"' + error.message.replace(/"/g, '\\"') + '"}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            handleApiError(res, error);
        }
    }
});

// Claude native messages (API key protected)
app.post('/v1/messages', requireApiKey, async function(req, res) {
    var user = identifyUser(req);
    recordRequest(user);
    var streamStarted = false;

    try {
        var model = req.body.model || 'claude-sonnet-4-5';
        var isStream = req.body.stream === true;
        var pool = getAccountPool();
        var acquired = pool.acquireAccount();
        var account = acquired.account;
        var release = acquired.release;

        try {
            if (isStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                streamStarted = true;

                for await (var event of account.service.generateContentStream(model, req.body)) {
                    res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
                }
                res.end();
                release();
            } else {
                var response = await account.service.generateContent(model, req.body);
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
            res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { message: error.message } }) + '\n\n');
            res.end();
        } else {
            handleApiError(res, error);
        }
    }
});

app.post('/v1/messages/count_tokens', requireApiKey, function(req, res) {
    res.json(KiroApiService.countTokens(req.body));
});

// =============================================================================
// Admin API (admin password protected)
// =============================================================================

app.get('/admin/stats', requireAdmin, function(req, res) {
    var pool = getAccountPool();
    res.json({ stats: getStats(), accounts: pool.getStatuses() });
});

app.get('/admin/accounts', requireAdmin, function(req, res) {
    res.json({ accounts: getAccountPool().getStatuses() });
});

app.get('/admin/credentials/export', requireAdmin, function(req, res) {
    res.json({ credentials: getAccountPool().exportAllCredentials() });
});

app.get('/admin/credentials/export-base64', requireAdmin, function(req, res) {
    res.json({ base64: getAccountPool().exportAllCredentialsBase64() });
});

app.post('/admin/credentials/import', requireAdmin, async function(req, res) {
    try { res.json(await importAwsCredentials(req.body)); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/credentials/batch-import', requireAdmin, async function(req, res) {
    try {
        var tokens = req.body.refreshTokens || [];
        var region = req.body.region || 'us-east-1';
        res.json(await batchImportRefreshTokens(tokens, region));
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/auth/kiro/oauth', requireAdmin, async function(req, res) {
    try { res.json(await handleKiroOAuth(req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/refresh-all', requireAdmin, async function(req, res) {
    var pool = getAccountPool();
    var refreshed = 0;
    for (var i = 0; i < pool.accounts.length; i++) {
        try {
            await pool.accounts[i].service.initializeAuth(true);
            pool.accounts[i].status = 'healthy';
            pool.accounts[i].lastError = null;
            refreshed++;
        } catch (e) { logger.warn('[Admin] Refresh failed: ' + e.message); }
    }
    res.json({ refreshed: refreshed, total: pool.getAccountCount() });
});

app.post('/admin/rescan', requireAdmin, async function(req, res) {
    var added = await getAccountPool().scanAndLoadNew();
    res.json({ added: added, total: getAccountPool().getAccountCount() });
});

// =============================================================================
// Health check (JSON)
// =============================================================================

app.get('/api/health', function(req, res) {
    var pool = getAccountPool();
    res.json({ service: 'kiro2-api', status: 'running', accounts: { total: pool.getAccountCount(), healthy: pool.getHealthyCount() }, stats: getStats() });
});

// =============================================================================
// Error handler
// =============================================================================

function handleApiError(res, error) {
    if (res.headersSent) { logger.error('[API] Error after headers: ' + error.message); return; }
    var status = (error instanceof KiroApiError && error.statusCode) ? error.statusCode : 500;
    var type = (error instanceof KiroApiError) ? error.errorType : 'server_error';
    logger.error('[API] ' + type + ': ' + error.message);
    res.status(status).json({ error: { message: error.message, type: type, code: status } });
}

// =============================================================================
// Start
// =============================================================================

async function main() {
    logger.info('==================================================');
    logger.info('  Kiro2 API — Starting');
    logger.info('==================================================');
    await loadStats();
    var pool = getAccountPool();
    await pool.initialize();
    app.listen(PORT, HOST, function() {
        logger.info('Server: http://' + HOST + ':' + PORT);
        logger.info('Accounts: ' + pool.getAccountCount() + ' loaded, ' + pool.getHealthyCount() + ' healthy');
    });
}

main().catch(function(err) { logger.error('Fatal: ' + err.message); process.exit(1); });
