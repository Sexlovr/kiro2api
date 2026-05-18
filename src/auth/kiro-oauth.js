/**
 * Kiro OAuth — standalone version.
 * Supports Google, GitHub (social), and Builder ID (device code).
 * Stripped of pool manager coupling, proxy utils, and broadcast events.
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import logger from '../utils/logger.js';
import { getAccountPool } from '../pool/account-pool.js';

const OAUTH_CONFIG = {
    authServiceEndpoint: 'https://prod.us-east-1.auth.desktop.kiro.dev',
    ssoOIDCEndpoint: 'https://oidc.{{region}}.amazonaws.com',
    builderIDStartURL: 'https://view.awsapps.com/start',
    callbackPortStart: 19876,
    callbackPortEnd: 19880,
    authTimeout: 10 * 60 * 1000,
    scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
};

const REFRESH_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    DEFAULT_REGION: 'us-east-1',
};

const activeServers = new Map();
const activePollingTasks = new Map();

// =============================================================================
// Public API
// =============================================================================

export async function handleKiroOAuth(options = {}) {
    const method = options.method || options.authMethod || 'google';
    logger.info(`[Kiro Auth] Starting OAuth: ${method}`);

    switch (method) {
        case 'google': return handleSocialAuth('Google', options);
        case 'github': return handleSocialAuth('Github', options);
        case 'builder-id': return handleBuilderIDDeviceCode(options);
        default: throw new Error(`Unsupported auth method: ${method}`);
    }
}

export async function batchImportRefreshTokens(refreshTokens, region = REFRESH_CONSTANTS.DEFAULT_REGION) {
    const results = { total: refreshTokens.length, success: 0, failed: 0, details: [] };
    const pool = getAccountPool();

    for (let i = 0; i < refreshTokens.length; i++) {
        const token = refreshTokens[i]?.trim();
        if (!token) {
            results.details.push({ index: i + 1, success: false, error: 'Empty token' });
            results.failed++;
            continue;
        }

        try {
            logger.info(`[Kiro Auth] Refreshing token ${i + 1}/${refreshTokens.length}...`);
            const tokenData = await refreshKiroToken(token, region);
            const credPath = await saveCredentials(tokenData);

            // Auto-add to pool
            await pool.addAccountFromFile(credPath);

            results.details.push({ index: i + 1, success: true, path: path.relative(process.cwd(), credPath), expiresAt: tokenData.expiresAt });
            results.success++;
        } catch (error) {
            logger.error(`[Kiro Auth] Token ${i + 1} failed: ${error.message}`);
            results.details.push({ index: i + 1, success: false, error: error.message });
            results.failed++;
        }
    }

    return results;
}

export async function importAwsCredentials(credentials) {
    const missing = [];
    if (!credentials.clientId) missing.push('clientId');
    if (!credentials.clientSecret) missing.push('clientSecret');
    if (!credentials.accessToken) missing.push('accessToken');
    if (!credentials.refreshToken) missing.push('refreshToken');
    if (missing.length > 0) return { success: false, error: `Missing: ${missing.join(', ')}` };

    try {
        const data = {
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            authMethod: credentials.authMethod || 'builder-id',
            idcRegion: credentials.idcRegion || REFRESH_CONSTANTS.DEFAULT_REGION,
        };
        if (credentials.expiresAt) data.expiresAt = credentials.expiresAt;

        // Try refresh
        try {
            const region = credentials.idcRegion || REFRESH_CONSTANTS.DEFAULT_REGION;
            const url = REFRESH_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', region);
            const resp = await axios.post(url, {
                refreshToken: credentials.refreshToken,
                clientId: credentials.clientId,
                clientSecret: credentials.clientSecret,
                grantType: 'refresh_token',
            }, { timeout: 15000 });

            if (resp.data?.accessToken) {
                data.accessToken = resp.data.accessToken;
                data.refreshToken = resp.data.refreshToken || data.refreshToken;
                data.expiresAt = new Date(Date.now() + (resp.data.expiresIn || 3600) * 1000).toISOString();
            }
        } catch (e) {
            logger.warn(`[Kiro Auth] Pre-refresh failed (saving original): ${e.message}`);
        }

        const credPath = await saveCredentials(data);
        const pool = getAccountPool();
        await pool.addAccountFromFile(credPath);

        return { success: true, path: path.relative(process.cwd(), credPath) };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// =============================================================================
// Social Auth (Google / GitHub)
// =============================================================================

async function handleSocialAuth(provider, options = {}) {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');

    const port = await startCallbackServer(codeVerifier, state, { ...options, socialProvider: provider });
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

    const authUrl = `${OAUTH_CONFIG.authServiceEndpoint}/login?` +
        `idp=${provider}&` +
        `redirect_uri=${encodeURIComponent('kiro://kiro.kiroAgent/authenticate-success')}&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=S256&` +
        `state=${state}`;

    return {
        authUrl,
        authInfo: { provider: 'claude-kiro-oauth', authMethod: 'social', socialProvider: provider, port, state },
    };
}

// =============================================================================
// Builder ID Device Code
// =============================================================================

async function handleBuilderIDDeviceCode(options = {}) {
    const region = options.region || 'us-east-1';
    const ssoEndpoint = OAUTH_CONFIG.ssoOIDCEndpoint.replace('{{region}}', region);
    const startURL = options.builderIDStartURL || OAUTH_CONFIG.builderIDStartURL;

    // Register client
    const regResp = await axios.post(`${ssoEndpoint}/client/register`, {
        clientName: 'Kiro IDE', clientType: 'public', scopes: OAUTH_CONFIG.scopes,
    }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'KiroIDE' }, timeout: 30000 });

    // Start device authorization
    const authResp = await axios.post(`${ssoEndpoint}/device_authorization`, {
        clientId: regResp.data.clientId, clientSecret: regResp.data.clientSecret, startUrl: startURL,
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

    const deviceAuth = authResp.data;
    const taskId = `kiro-${deviceAuth.deviceCode.substring(0, 8)}-${Date.now()}`;

    // Start background polling
    pollDeviceToken(regResp.data.clientId, regResp.data.clientSecret, deviceAuth.deviceCode,
        deviceAuth.interval || 5, deviceAuth.expiresIn || 300, taskId, { region }).catch(e => {
        logger.error(`[Kiro Auth] Polling failed [${taskId}]: ${e.message}`);
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

async function pollDeviceToken(clientId, clientSecret, deviceCode, interval, expiresIn, taskId, options = {}) {
    const maxAttempts = Math.floor(expiresIn / interval);
    let attempts = 0;
    const ctrl = { shouldStop: false };
    activePollingTasks.set(taskId, ctrl);
    const region = options.region || 'us-east-1';
    const ssoEndpoint = OAUTH_CONFIG.ssoOIDCEndpoint.replace('{{region}}', region);

    const poll = async () => {
        if (ctrl.shouldStop) throw new Error('Polling cancelled');
        if (attempts >= maxAttempts) { activePollingTasks.delete(taskId); throw new Error('Authorization timeout'); }
        attempts++;

        try {
            const resp = await axios.post(`${ssoEndpoint}/token`, {
                clientId, clientSecret, deviceCode,
                grantType: 'urn:ietf:params:oauth:grant-type:device_code',
            }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'KiroIDE' }, timeout: 30000 });

            if (resp.data?.accessToken) {
                logger.info(`[Kiro Auth] Token obtained [${taskId}]`);
                const tokenData = {
                    accessToken: resp.data.accessToken,
                    refreshToken: resp.data.refreshToken,
                    expiresAt: new Date(Date.now() + (resp.data.expiresIn || 3600) * 1000).toISOString(),
                    authMethod: 'builder-id', clientId, clientSecret,
                    idcRegion: region,
                };
                const credPath = await saveCredentials(tokenData);
                const pool = getAccountPool();
                await pool.addAccountFromFile(credPath);
                activePollingTasks.delete(taskId);
                return tokenData;
            }
        } catch (error) {
            const data = error.response?.data;
            if (data?.error === 'authorization_pending') {
                logger.info(`[Kiro Auth] Waiting for authorization [${taskId}] (${attempts}/${maxAttempts})`);
                await sleep(interval * 1000);
                return poll();
            }
            if (data?.error === 'slow_down') {
                await sleep((interval + 5) * 1000);
                return poll();
            }
            if (error.response?.data?.error) {
                activePollingTasks.delete(taskId);
                throw new Error(`Auth failed: ${data.error}`);
            }
            await sleep(interval * 1000);
            return poll();
        }
    };

    return poll();
}

// =============================================================================
// Callback Server (Social Auth)
// =============================================================================

async function startCallbackServer(codeVerifier, state, options = {}) {
    for (let port = OAUTH_CONFIG.callbackPortStart; port <= OAUTH_CONFIG.callbackPortEnd; port++) {
        try {
            const server = await createCallbackServer(port, codeVerifier, state, options);
            activeServers.set(port, server);
            logger.info(`[Kiro Auth] Callback server on port ${port}`);
            return port;
        } catch (e) {
            if (e.code !== 'EADDRINUSE') logger.warn(`[Kiro Auth] Port ${port} error: ${e.message}`);
        }
    }
    throw new Error('All callback ports in use');
}

function createCallbackServer(port, codeVerifier, expectedState, options = {}) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                if (url.pathname !== '/oauth/callback') { res.writeHead(204); res.end(); return; }

                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                const error = url.searchParams.get('error');

                if (error) { res.writeHead(400, htmlHeaders()); res.end(resultPage(false, `Auth failed: ${error}`)); return; }
                if (state !== expectedState) { res.writeHead(400, htmlHeaders()); res.end(resultPage(false, 'State mismatch')); return; }

                // Exchange code for token
                const tokenResp = await axios.post(`${OAUTH_CONFIG.authServiceEndpoint}/oauth/token`, {
                    code, code_verifier: codeVerifier,
                    redirect_uri: 'kiro://kiro.kiroAgent/authenticate-success',
                }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

                const tokenData = {
                    accessToken: tokenResp.data.accessToken,
                    refreshToken: tokenResp.data.refreshToken,
                    profileArn: tokenResp.data.profileArn,
                    socialProvider: options.socialProvider,
                    expiresAt: new Date(Date.now() + (tokenResp.data.expiresIn || 3600) * 1000).toISOString(),
                    authMethod: 'social', region: 'us-east-1',
                };

                const credPath = await saveCredentials(tokenData);
                const pool = getAccountPool();
                await pool.addAccountFromFile(credPath);

                res.writeHead(200, htmlHeaders());
                res.end(resultPage(true, 'Authorization successful! You can close this tab.'));
                server.close();
                activeServers.delete(port);
            } catch (err) {
                logger.error(`[Kiro Auth] Callback error: ${err.message}`);
                res.writeHead(500, htmlHeaders());
                res.end(resultPage(false, `Server error: ${err.message}`));
            }
        });

        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
        setTimeout(() => { if (server.listening) { server.close(); activeServers.delete(port); } }, OAUTH_CONFIG.authTimeout);
    });
}

// =============================================================================
// Helpers
// =============================================================================

async function refreshKiroToken(refreshToken, region = 'us-east-1') {
    const url = REFRESH_CONSTANTS.REFRESH_URL.replace('{{region}}', region);
    const resp = await axios.post(url, { refreshToken }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    if (!resp.data?.accessToken) throw new Error('Missing accessToken in refresh response');
    return {
        accessToken: resp.data.accessToken,
        refreshToken: resp.data.refreshToken || refreshToken,
        profileArn: resp.data.profileArn || '',
        expiresAt: new Date(Date.now() + (resp.data.expiresIn || 3600) * 1000).toISOString(),
        authMethod: 'social', region,
    };
}

async function saveCredentials(data) {
    const timestamp = Date.now();
    const folderName = `${timestamp}_kiro-auth-token`;
    const targetDir = path.join(process.cwd(), 'configs', 'kiro', folderName);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const credPath = path.join(targetDir, `${folderName}.json`);
    await fs.promises.writeFile(credPath, JSON.stringify(data, null, 2));
    logger.info(`[Kiro Auth] Credentials saved: ${path.relative(process.cwd(), credPath)}`);
    return credPath;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function htmlHeaders() { return { 'Content-Type': 'text/html; charset=utf-8' }; }

function resultPage(ok, message) {
    const emoji = ok ? '✅' : '❌';
    const color = ok ? '#4caf50' : '#f44336';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Success' : 'Error'}</title>

<!--LUMIVERSE_HTML_ISLAND_0-->

${ok ? '<script>setTimeout(()=>window.close(),5000)</script>' : ''}</div></body></html>`;
}
