import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import logger from '../utils/logger.js';
import { getAccountPool } from '../pool/account-pool.js';

var OAUTH_CONFIG = {
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

export async function handleKiroOAuth(options) {
    options = options || {};
    var method = options.method || options.authMethod || 'builder-id';
    logger.info('[Kiro Auth] Starting OAuth: ' + method);
    if (method === 'builder-id') return handleBuilderIDDeviceCode(options);
    throw new Error('Only Builder ID auth is supported on cloud deployments');
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
            logger.info('[Kiro Auth] Refreshing token ' + (i + 1) + '/' + refreshTokens.length);
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
    if (!credentials.accessToken) missing.push('accessToken');
    if (!credentials.refreshToken) missing.push('refreshToken');
    if (missing.length > 0) return { success: false, error: 'Missing: ' + missing.join(', ') };

    try {
        var data = {
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            authMethod: credentials.authMethod || (credentials.clientId ? 'builder-id' : 'social'),
            region: credentials.region || REFRESH_CONSTANTS.DEFAULT_REGION,
        };
        if (credentials.clientId) data.clientId = credentials.clientId;
        if (credentials.clientSecret) data.clientSecret = credentials.clientSecret;
        if (credentials.profileArn) data.profileArn = credentials.profileArn;
        if (credentials.idcRegion) data.idcRegion = credentials.idcRegion;
        if (credentials.expiresAt) data.expiresAt = credentials.expiresAt;

        // Try refresh to validate
        try {
            if (data.clientId && data.clientSecret) {
                var region = data.idcRegion || REFRESH_CONSTANTS.DEFAULT_REGION;
                var url = REFRESH_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', region);
                var resp = await axios.post(url, {
                    refreshToken: data.refreshToken, clientId: data.clientId,
                    clientSecret: data.clientSecret, grantType: 'refresh_token',
                }, { timeout: 15000 });
                if (resp.data && resp.data.accessToken) {
                    data.accessToken = resp.data.accessToken;
                    data.refreshToken = resp.data.refreshToken || data.refreshToken;
                    data.expiresAt = new Date(Date.now() + (resp.data.expiresIn || 3600) * 1000).toISOString();
                    logger.info('[Kiro Auth] Token refreshed during import');
                }
            } else if (data.refreshToken) {
                var socialRegion = data.region || REFRESH_CONSTANTS.DEFAULT_REGION;
                var socialUrl = REFRESH_CONSTANTS.REFRESH_URL.replace('{{region}}', socialRegion);
                var socialResp = await axios.post(socialUrl, { refreshToken: data.refreshToken }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
                if (socialResp.data && socialResp.data.accessToken) {
                    data.accessToken = socialResp.data.accessToken;
                    data.refreshToken = socialResp.data.refreshToken || data.refreshToken;
                    data.profileArn = socialResp.data.profileArn || data.profileArn;
                    data.expiresAt = new Date(Date.now() + (socialResp.data.expiresIn || 3600) * 1000).toISOString();
                    logger.info('[Kiro Auth] Social token refreshed during import');
                }
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
                    authMethod: 'builder-id', clientId: clientId, clientSecret: clientSecret, idcRegion: region,
                };
                var credPath = await saveCredentials(tokenData);
                var pool = getAccountPool();
                await pool.addAccountFromFile(credPath);
                activePollingTasks.delete(taskId);
                return tokenData;
            }
        } catch (error) {
            var data = error.response && error.response.data;
            if (data && data.error === 'authorization_pending') { await sleep(interval * 1000); return poll(); }
            if (data && data.error === 'slow_down') { await sleep((interval + 5) * 1000); return poll(); }
            if (data && data.error) { activePollingTasks.delete(taskId); throw new Error('Auth failed: ' + data.error); }
            await sleep(interval * 1000); return poll();
        }
    };
    return poll();
}

async function refreshKiroToken(refreshToken, region) {
    var url = REFRESH_CONSTANTS.REFRESH_URL.replace('{{region}}', region || 'us-east-1');
    var resp = await axios.post(url, { refreshToken: refreshToken }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    if (!resp.data || !resp.data.accessToken) throw new Error('Missing accessToken');
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
    logger.info('[Kiro Auth] Saved: ' + path.relative(baseDir, credPath));
    return credPath;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
