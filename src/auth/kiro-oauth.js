import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import logger from '../utils/logger.js';
import { getAccountPool } from '../pool/account-pool.js';

var OAUTH_CONFIG = {
    authServiceEndpoint: 'https://prod.us-east-1.auth.desktop.kiro.dev',
    ssoOIDCEndpoint: 'https://oidc.{{region}}.amazonaws.com',
    builderIDStartURL: 'https://view.awsapps.com/start',
    authTimeout: 10 * 60 * 1000,
    scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
};

var REFRESH_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    DEFAULT_REGION: 'us-east-1',
};

var activePollingTasks = new Map();

// Stores pending social OAuth sessions: state -> { codeVerifier, provider, createdAt }
var pendingSocialSessions = new Map();

// Cleanup stale sessions every 5 minutes
setInterval(function() {
    var now = Date.now();
    for (var entry of pendingSocialSessions.entries()) {
        if (now - entry[1].createdAt > OAUTH_CONFIG.authTimeout) {
            pendingSocialSessions.delete(entry[0]);
        }
    }
}, 5 * 60 * 1000);

// =============================================================================
// Public API
// =============================================================================

export async function handleKiroOAuth(options) {
    options = options || {};
    var method = options.method || options.authMethod || 'google';
    logger.info('[Kiro Auth] Starting OAuth: ' + method);
    if (method === 'google') return handleSocialAuth('Google', options);
    if (method === 'github') return handleSocialAuth('Github', options);
    if (method === 'builder-id') return handleBuilderIDDeviceCode(options);
    throw new Error('Unsupported auth method: ' + method);
}

/**
 * Exchange a pasted redirect URL for tokens (Google/GitHub social auth on cloud)
 * User copies the kiro://... URL from browser after authenticating and pastes it here.
 */
export async function exchangeOAuthCode(redirectUrl) {
    if (!redirectUrl) throw new Error('No redirect URL provided');

    // Parse the redirect URL to extract code and state
    var url;
    try {
        // kiro:// URLs aren't parseable by URL constructor, convert to https://
        var normalizedUrl = redirectUrl.replace(/^kiro:\/\//, 'https://');
        url = new URL(normalizedUrl);
    } catch (e) {
        throw new Error('Invalid redirect URL format');
    }

    var code = url.searchParams.get('code');
    var state = url.searchParams.get('state');

    if (!code) throw new Error('No authorization code found in URL');
    if (!state) throw new Error('No state parameter found in URL');

    // Look up the pending session
    var session = pendingSocialSessions.get(state);
    if (!session) throw new Error('No pending OAuth session found for this state. The session may have expired. Please try again.');

    // Remove the session so it can't be reused
    pendingSocialSessions.delete(state);

    logger.info('[Kiro Auth] Exchanging code for token (provider: ' + session.provider + ')');

    // Exchange code for token
    var tokenResp;
    try {
        tokenResp = await axios.post(OAUTH_CONFIG.authServiceEndpoint + '/oauth/token', {
            code: code,
            code_verifier: session.codeVerifier,
            redirect_uri: 'kiro://kiro.kiroAgent/authenticate-success',
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    } catch (e) {
        var errMsg = 'Token exchange failed';
        if (e.response && e.response.data) {
            var errData = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
            errMsg += ': ' + e.response.status + ' - ' + errData;
        } else {
            errMsg += ': ' + e.message;
        }
        throw new Error(errMsg);
    }

    if (!tokenResp.data || !tokenResp.data.accessToken) {
        throw new Error('No accessToken in token response');
    }

    var tokenData = {
        accessToken: tokenResp.data.accessToken,
        refreshToken: tokenResp.data.refreshToken,
        profileArn: tokenResp.data.profileArn,
        socialProvider: session.provider,
        expiresAt: new Date(Date.now() + (tokenResp.data.expiresIn || 3600) * 1000).toISOString(),
        authMethod: 'social',
        region: 'us-east-1',
    };

    var credPath = await saveCredentials(tokenData);
    var pool = getAccountPool();
    await pool.addAccountFromFile(credPath);

    var baseDir = process.env.DATA_DIR || process.cwd();
    logger.info('[Kiro Auth] Social OAuth completed: ' + session.provider);

    return { success: true, provider: session.provider, path: path.relative(baseDir, credPath) };
}

export async function batchImportRefreshTokens(refreshTokens, region) {
    region = region || REFRESH_CONSTANTS.DEFAULT_REGION;
    var baseDir = process.env.DATA_DIR || process.cwd();
    var results = { total: refreshTokens.length, success: 0, failed: 0, details: [] };
    var pool = getAccountPool();

    for (var i = 0; i < refreshTokens.length; i++) {
        var token = refreshTokens[i] && refreshTokens[i].trim();
        if (!token) {
            results.details.push({ index: i + 1, success: false, error: 'Empty token' });
            results.failed++;
            continue;
        }
        try {
            logger.info('[Kiro Auth] Refreshing token ' + (i + 1) + '/' + refreshTokens.length + '...');
            var tokenData = await refreshKiroToken(token, region);
            var credPath = await saveCredentials(tokenData);
            await pool.addAccountFromFile(credPath);
            results.details.push({ index: i + 1, success: true, path: path.relative(baseDir, credPath), expiresAt: tokenData.expiresAt });
            results.success++;
        } catch (error) {
            logger.error('[Kiro Auth] Token ' + (i + 1) + ' failed: ' + error.message);
            results.details.push({ index: i + 1, success: false, error: error.message });
            results.failed++;
        }
    }
    return results;
}

export async function importAwsCredentials(credentials) {
    var missing = [];
    if (!credentials.clientId) missing.push('clientId');
    if (!credentials.clientSecret) missing.push('clientSecret');
    if (!credentials.accessToken) missing.push('accessToken');
    if (!credentials.refreshToken) missing.push('refreshToken');
    if (missing.length > 0) return { success: false, error: 'Missing: ' + missing.join(', ') };

    try {
        var data = {
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            authMethod: credentials.authMethod || 'builder-id',
            idcRegion: credentials.idcRegion || REFRESH_CONSTANTS.DEFAULT_REGION,
        };
        if (credentials.expiresAt) data.expiresAt = credentials.expiresAt;

        try {
            var region = credentials.idcRegion || REFRESH_CONSTANTS.DEFAULT_REGION;
            var url = REFRESH_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', region);
            var resp = await axios.post(url, {
                refreshToken: credentials.refreshToken,
                clientId: credentials.clientId,
                clientSecret: credentials.clientSecret,
                grantType: 'refresh_token',
            }, { timeout: 15000 });

            if (resp.data && resp.data.accessToken) {
                data.accessToken = resp.data.accessToken;
                data.refreshToken = resp.data.refreshToken || data.refreshToken;
                data.expiresAt = new Date(Date.now() + (resp.data.expiresIn || 3600) * 1000).toISOString();
            }
        } catch (e) {
            logger.warn('[Kiro Auth] Pre-refresh failed: ' + e.message);
        }

        var credPath = await saveCredentials(data);
        var pool = getAccountPool();
        await pool.addAccountFromFile(credPath);
        var baseDir = process.env.DATA_DIR || process.cwd();
        return { success: true, path: path.relative(baseDir, credPath) };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// =============================================================================
// Social Auth (Google / GitHub) — paste-redirect flow for cloud
// =============================================================================

async function handleSocialAuth(provider, options) {
    var codeVerifier = crypto.randomBytes(32).toString('base64url');
    var codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    var state = crypto.randomBytes(16).toString('base64url');

    // Store the session so we can exchange the code later when user pastes the redirect URL
    pendingSocialSessions.set(state, {
        codeVerifier: codeVerifier,
        provider: provider,
        createdAt: Date.now(),
    });

    // Use the kiro:// redirect URI — user will copy the resulting URL from browser
    var redirectUri = 'kiro://kiro.kiroAgent/authenticate-success';

    var authUrl = OAUTH_CONFIG.authServiceEndpoint + '/login?'
        + 'idp=' + provider
        + '&redirect_uri=' + encodeURIComponent(redirectUri)
        + '&code_challenge=' + codeChallenge
        + '&code_challenge_method=S256'
        + '&state=' + state;

    return {
        authUrl: authUrl,
        authInfo: {
            provider: 'claude-kiro-oauth',
            authMethod: 'social',
            socialProvider: provider,
            state: state,
            needsRedirectPaste: true,
        },
    };
}

// =============================================================================
// Builder ID Device Code
// =============================================================================

async function handleBuilderIDDeviceCode(options) {
    options = options || {};
    var region = options.region || 'us-east-1';
    var ssoEndpoint = OAUTH_CONFIG.ssoOIDCEndpoint.replace('{{region}}', region);
    var startURL = options.builderIDStartURL || OAUTH_CONFIG.builderIDStartURL;

    var regResp = await axios.post(ssoEndpoint + '/client/register', {
        clientName: 'Kiro IDE', clientType: 'public', scopes: OAUTH_CONFIG.scopes,
    }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'KiroIDE' }, timeout: 30000 });

    var authResp = await axios.post(ssoEndpoint + '/device_authorization', {
        clientId: regResp.data.clientId, clientSecret: regResp.data.clientSecret, startUrl: startURL,
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

    var deviceAuth = authResp.data;
    var taskId = 'kiro-' + deviceAuth.deviceCode.substring(0, 8) + '-' + Date.now();

    pollDeviceToken(regResp.data.clientId, regResp.data.clientSecret, deviceAuth.deviceCode,
        deviceAuth.interval || 5, deviceAuth.expiresIn || 300, taskId, { region: region }).catch(function(e) {
        logger.error('[Kiro Auth] Polling failed: ' + e.message);
    });

    return {
        authUrl: deviceAuth.verificationUriComplete,
        authInfo: {
            provider: 'claude-kiro-oauth', authMethod: 'builder-id',
            deviceCode: deviceAuth.deviceCode, userCode: deviceAuth.userCode,
            verificationUri: deviceAuth.verificationUri,
            verificationUriComplete: deviceAuth.verificationUriComplete,
            expiresIn: deviceAuth.expiresIn, interval: deviceAuth.interval,
        },
    };
}

async function pollDeviceToken(clientId, clientSecret, deviceCode, interval, expiresIn, taskId, options) {
    options = options || {};
    var maxAttempts = Math.floor(expiresIn / interval);
    var attempts = 0;
    var ctrl = { shouldStop: false };
    activePollingTasks.set(taskId, ctrl);
    var region = options.region || 'us-east-1';
    var ssoEndpoint = OAUTH_CONFIG.ssoOIDCEndpoint.replace('{{region}}', region);

    var poll = async function() {
        if (ctrl.shouldStop) throw new Error('Polling cancelled');
        if (attempts >= maxAttempts) { activePollingTasks.delete(taskId); throw new Error('Authorization timeout'); }
        attempts++;

        try {
            var resp = await axios.post(ssoEndpoint + '/token', {
                clientId: clientId, clientSecret: clientSecret, deviceCode: deviceCode,
                grantType: 'urn:ietf:params:oauth:grant-type:device_code',
            }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'KiroIDE' }, timeout: 30000 });

            if (resp.data && resp.data.accessToken) {
                logger.info('[Kiro Auth] Token obtained [' + taskId + ']');
                var tokenData = {
                    accessToken: resp.data.accessToken, refreshToken: resp.data.refreshToken,
                    expiresAt: new Date(Date.now() + (resp.data.expiresIn || 3600) * 1000).toISOString(),
                    authMethod: 'builder-id', clientId: clientId, clientSecret: clientSecret,
                    idcRegion: region,
                };
                var credPath = await saveCredentials(tokenData);
                var pool = getAccountPool();
                await pool.addAccountFromFile(credPath);
                activePollingTasks.delete(taskId);
                return tokenData;
            }
        } catch (error) {
            var data = error.response && error.response.data;
            if (data && data.error === 'authorization_pending') {
                logger.info('[Kiro Auth] Waiting [' + taskId + '] (' + attempts + '/' + maxAttempts + ')');
                await sleep(interval * 1000);
                return poll();
            }
            if (data && data.error === 'slow_down') { await sleep((interval + 5) * 1000); return poll(); }
            if (data && data.error) { activePollingTasks.delete(taskId); throw new Error('Auth failed: ' + data.error); }
            await sleep(interval * 1000);
            return poll();
        }
    };
    return poll();
}

// =============================================================================
// Helpers
// =============================================================================

async function refreshKiroToken(refreshToken, region) {
    var url = REFRESH_CONSTANTS.REFRESH_URL.replace('{{region}}', region || 'us-east-1');
    var resp = await axios.post(url, { refreshToken: refreshToken }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    if (!resp.data || !resp.data.accessToken) throw new Error('Missing accessToken in refresh response');
    return {
        accessToken: resp.data.accessToken, refreshToken: resp.data.refreshToken || refreshToken,
        profileArn: resp.data.profileArn || '',
        expiresAt: new Date(Date.now() + (resp.data.expiresIn || 3600) * 1000).toISOString(),
        authMethod: 'social', region: region || 'us-east-1',
    };
}

async function saveCredentials(data) {
    var baseDir = process.env.DATA_DIR || process.cwd();
    var timestamp = Date.now();
    var folderName = timestamp + '_kiro-auth-token';
    var targetDir = path.join(baseDir, 'configs', 'kiro', folderName);
    await fs.promises.mkdir(targetDir, { recursive: true });
    var credPath = path.join(targetDir, folderName + '.json');
    await fs.promises.writeFile(credPath, JSON.stringify(data, null, 2));
    logger.info('[Kiro Auth] Credentials saved: ' + path.relative(baseDir, credPath));
    return credPath;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
