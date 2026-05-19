import { KiroApiService } from '../providers/claude-kiro.js';
import { KiroApiError } from '../providers/kiro-error.js';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

var STATUS = { HEALTHY: 'healthy', REFRESHING: 'refreshing', UNHEALTHY: 'unhealthy', COOLDOWN: 'cooldown', DISABLED: 'disabled' };
var COOLDOWN_MS = { RATE_LIMIT: 30000, SERVER: 10000 };
var FREE_TIER_DEFAULT_LIMIT = 50;

class AccountPool {
    constructor(config) {
        config = config || {};
        var baseDir = process.env.DATA_DIR || process.cwd();
        this.accounts = [];
        this.roundRobinIndex = 0;
        this.refreshIntervalMs = config.tokenRefreshIntervalMs || parseInt(process.env.KIRO_TOKEN_REFRESH_INTERVAL_MS, 10) || 45 * 60 * 1000;
        this.configsDir = config.configsDir || path.join(baseDir, 'configs', 'kiro');
        this._keepAliveRunning = false;
    }

    async initialize() {
        await this._ensureConfigsDir();
        await this._loadFromEnv();
        await this._loadFromDirectory();
        var total = this.accounts.length;
        var healthy = this.accounts.filter(function(a) { return a.status === STATUS.HEALTHY; }).length;
        logger.info('[Pool] Initialized: ' + total + ' account(s), ' + healthy + ' healthy. Dir: ' + this.configsDir);
        if (total > 0) this.startKeepAlive();
    }

    async _ensureConfigsDir() { try { await fs.mkdir(this.configsDir, { recursive: true }); } catch (e) {} }

    async _loadFromEnv() {
        var single = process.env.KIRO_OAUTH_CREDS_BASE64;
        if (single) await this.addAccountFromBase64(single, 'env:KIRO_OAUTH_CREDS_BASE64');
        var multi = process.env.KIRO_ACCOUNTS_BASE64;
        if (multi) {
            var parts = multi.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
            for (var i = 0; i < parts.length; i++) await this.addAccountFromBase64(parts[i], 'env:KIRO_ACCOUNTS_BASE64[' + i + ']');
        }
    }

    async _loadFromDirectory() {
        var entries;
        try { entries = await fs.readdir(this.configsDir, { withFileTypes: true }); } catch (e) { return; }
        for (var i = 0; i < entries.length; i++) {
            try {
                var entry = entries[i];
                if (entry.isDirectory()) {
                    var subDir = path.join(this.configsDir, entry.name);
                    var files = await fs.readdir(subDir);
                    var jsonFile = files.find(function(f) { return f.endsWith('.json'); });
                    if (jsonFile) await this.addAccountFromFile(path.join(subDir, jsonFile));
                } else if (entry.isFile() && entry.name.endsWith('.json')) {
                    await this.addAccountFromFile(path.join(this.configsDir, entry.name));
                }
            } catch (e) { logger.warn('[Pool] Error loading ' + entries[i].name + ': ' + e.message); }
        }
    }

    async scanAndLoadNew() {
        var existingPaths = new Set(this.accounts.map(function(a) { return a.credPath; }));
        var entries;
        try { entries = await fs.readdir(this.configsDir, { withFileTypes: true }); } catch (e) { return 0; }
        var added = 0;
        for (var i = 0; i < entries.length; i++) {
            try {
                var credPath = null;
                if (entries[i].isDirectory()) {
                    var subDir = path.join(this.configsDir, entries[i].name);
                    var files = await fs.readdir(subDir);
                    var jsonFile = files.find(function(f) { return f.endsWith('.json'); });
                    if (jsonFile) credPath = path.join(subDir, jsonFile);
                } else if (entries[i].isFile() && entries[i].name.endsWith('.json')) {
                    credPath = path.join(this.configsDir, entries[i].name);
                }
                if (credPath && !existingPaths.has(credPath)) { await this.addAccountFromFile(credPath); added++; }
            } catch (e) {}
        }
        if (added > 0) logger.info('[Pool] Scan found ' + added + ' new account(s)');
        return added;
    }

    async addAccountFromFile(credPath) {
        if (this.accounts.some(function(a) { return a.credPath === credPath; })) return null;
        try {
            var service = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: credPath });
            await service.initialize();
            var account = this._createAccountEntry(service, credPath, path.basename(credPath));
            this.accounts.push(account);
            var baseDir = process.env.DATA_DIR || process.cwd();
            logger.info('[Pool] Added account ' + account.id + ' from ' + path.relative(baseDir, credPath));
            if (this._keepAliveRunning) this._startAccountRefreshTimer(account);
            return account.id;
        } catch (error) { logger.error('[Pool] Failed to add from ' + credPath + ': ' + error.message); return null; }
    }

    async addAccountFromBase64(base64String, sourceLabel) {
        try {
            var decoded = Buffer.from(base64String, 'base64').toString('utf8');
            var credPath = await this._saveCredsToDisk(JSON.parse(decoded));
            return await this.addAccountFromFile(credPath);
        } catch (error) { logger.error('[Pool] Failed from ' + (sourceLabel || 'base64') + ': ' + error.message); return null; }
    }

    async addAccountFromCredentials(credentials) {
        try {
            var credPath = await this._saveCredsToDisk(credentials);
            return await this.addAccountFromFile(credPath);
        } catch (error) { logger.error('[Pool] Failed from credentials: ' + error.message); return null; }
    }

    async _saveCredsToDisk(credentials) {
        var timestamp = Date.now();
        var folderName = timestamp + '_kiro-auth-token';
        var targetDir = path.join(this.configsDir, folderName);
        await fs.mkdir(targetDir, { recursive: true });
        var credPath = path.join(targetDir, folderName + '.json');
        await fs.writeFile(credPath, JSON.stringify(credentials, null, 2));
        return credPath;
    }

    _createAccountEntry(service, credPath, label) {
        return {
            id: crypto.randomBytes(4).toString('hex'),
            label: label || 'unknown', service: service, credPath: credPath,
            status: STATUS.HEALTHY, activeRequests: 0, lastError: null,
            lastUsedAt: null, createdAt: new Date().toISOString(),
            refreshTimer: null, totalRequests: 0, totalErrors: 0, lastUsage: null,
        };
    }

    _extractCredits(result) {
        var used = 0;
        var limit = 0;

        logger.info('[Pool] Raw AWS Usage Payload: ' + JSON.stringify(result));

        if (!result || typeof result !== 'object') {
            return { used: 0, limit: FREE_TIER_DEFAULT_LIMIT };
        }

        // Collect all candidate number fields from every level
        var usedCandidates = [];
        var limitCandidates = [];

        var collectFromObj = function(obj) {
            if (!obj || typeof obj !== 'object') return;
            var keys = Object.keys(obj);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i].toLowerCase();
                var v = obj[keys[i]];

                // Used count fields
                if (k === 'usedcount' || k === 'used' || k === 'currentusage' || k === 'usagecount' || k === 'consumed' || k === 'requestcount') {
                    if (typeof v === 'number' || typeof v === 'string') usedCandidates.push(Number(v));
                }
                // Limit count fields
                if (k === 'limitcount' || k === 'limit' || k === 'max' || k === 'maxusage' || k === 'maxcount' || k === 'allowedcount' || k === 'totalcount' || k === 'quota' || k === 'maxrequests' || k === 'totallimit') {
                    if (typeof v === 'number' || typeof v === 'string') limitCandidates.push(Number(v));
                }

                // Recurse into nested objects
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    collectFromObj(v);
                }
                // Recurse into arrays
                if (Array.isArray(v)) {
                    for (var j = 0; j < v.length; j++) {
                        if (v[j] && typeof v[j] === 'object') collectFromObj(v[j]);
                    }
                }
            }
        };

        collectFromObj(result);

        // Pick the best values
        if (usedCandidates.length > 0) {
            used = Math.max.apply(null, usedCandidates.filter(function(n) { return !isNaN(n); }));
        }
        if (limitCandidates.length > 0) {
            limit = Math.max.apply(null, limitCandidates.filter(function(n) { return !isNaN(n) && n > 0; }));
        }

        // If we found used but no limit, default to free tier limit
        if (used > 0 && limit === 0) {
            limit = FREE_TIER_DEFAULT_LIMIT;
            logger.info('[Pool] No limit field found, defaulting to ' + FREE_TIER_DEFAULT_LIMIT);
        }

        if (isNaN(used)) used = 0;
        if (isNaN(limit)) limit = FREE_TIER_DEFAULT_LIMIT;

        logger.info('[Pool] Extracted credits: ' + used + '/' + limit);
        return { used: used, limit: limit };
    }

    disableAccount(id) {
        var account = this._findById(id);
        if (!account) return { success: false, error: 'Not found' };
        account.status = STATUS.DISABLED;
        return { success: true };
    }

    enableAccount(id) {
        var account = this._findById(id);
        if (!account) return { success: false, error: 'Not found' };
        account.status = STATUS.HEALTHY; account.lastError = null;
        return { success: true };
    }

    removeAccount(id) {
        var idx = -1;
        for (var i = 0; i < this.accounts.length; i++) { if (this.accounts[i].id === id) { idx = i; break; } }
        if (idx === -1) return { success: false, error: 'Not found' };
        var account = this.accounts[idx];
        if (account.refreshTimer) clearInterval(account.refreshTimer);
        this.accounts.splice(idx, 1);
        return { success: true, removed: id };
    }

    async healthCheck(id) {
        var account = this._findById(id);
        if (!account) return { success: false, error: 'Not found' };
        try {
            var result = await account.service.getUsageLimits();
            account.status = STATUS.HEALTHY; account.lastError = null;
            var extracted = this._extractCredits(result);
            account.lastUsage = { usedCount: extracted.used, limitCount: extracted.limit, checkedAt: new Date().toISOString() };
            return { success: true, healthy: true, usedCount: extracted.used, limitCount: extracted.limit };
        } catch (error) {
            account.status = STATUS.UNHEALTHY; account.lastError = error.message;
            return { success: true, healthy: false, error: error.message };
        }
    }

    async checkAllCredits() {
        var results = [];
        for (var i = 0; i < this.accounts.length; i++) {
            var account = this.accounts[i];
            if (account.status === STATUS.DISABLED) { results.push({ id: account.id, skipped: true, reason: 'disabled' }); continue; }
            try {
                var result = await account.service.getUsageLimits();
                var extracted = this._extractCredits(result);
                account.lastUsage = { usedCount: extracted.used, limitCount: extracted.limit, checkedAt: new Date().toISOString() };
                account.status = STATUS.HEALTHY; account.lastError = null;
                results.push({ id: account.id, healthy: true, usedCount: extracted.used, limitCount: extracted.limit });
            } catch (error) {
                account.status = STATUS.UNHEALTHY; account.lastError = error.message;
                results.push({ id: account.id, healthy: false, error: error.message });
            }
        }
        return results;
    }

    _findById(id) { for (var i = 0; i < this.accounts.length; i++) { if (this.accounts[i].id === id) return this.accounts[i]; } return null; }

    acquireAccount() {
        var account = this._selectBestAccount();
        if (!account) throw new Error(this.accounts.length === 0 ? 'No accounts configured.' : 'No healthy accounts available.');
        account.activeRequests++; account.lastUsedAt = new Date().toISOString(); account.totalRequests++;
        var released = false; var self = this;
        return { account: account, release: function(error) { if (released) return; released = true; account.activeRequests = Math.max(0, account.activeRequests - 1); if (error) self._handleAccountError(account, error); } };
    }

    _selectBestAccount() {
        var healthy = this.accounts.filter(function(a) { return a.status === STATUS.HEALTHY; });
        if (healthy.length === 0) return null;
        var minActive = Infinity;
        for (var i = 0; i < healthy.length; i++) { if (healthy[i].activeRequests < minActive) minActive = healthy[i].activeRequests; }
        var candidates = healthy.filter(function(a) { return a.activeRequests === minActive; });
        var idx = this.roundRobinIndex % candidates.length;
        this.roundRobinIndex = (this.roundRobinIndex + 1) % 1000000;
        return candidates[idx];
    }

    _handleAccountError(account, error) {
        account.totalErrors++;
        var type = (error instanceof KiroApiError) ? error.errorType : 'unknown';
        var self = this;
        if (type === 'auth') { account.lastError = error.message; self._backgroundRefresh(account); }
        else if (type === 'rate_limit') { account.status = STATUS.COOLDOWN; account.lastError = error.message; setTimeout(function() { if (account.status === STATUS.COOLDOWN) account.status = STATUS.HEALTHY; }, COOLDOWN_MS.RATE_LIMIT); }
        else if (type === 'quota') { account.status = STATUS.UNHEALTHY; account.lastError = 'Quota exhausted'; }
        else if (type === 'server') { account.status = STATUS.COOLDOWN; account.lastError = error.message; setTimeout(function() { if (account.status === STATUS.COOLDOWN) account.status = STATUS.HEALTHY; }, COOLDOWN_MS.SERVER); }
        else if (type !== 'network') { account.lastError = error.message; }
    }

    async _backgroundRefresh(account) {
        if (account.status === STATUS.REFRESHING) return;
        account.status = STATUS.REFRESHING;
        try { await account.service.loadCredentials(); await account.service.initializeAuth(true); account.status = STATUS.HEALTHY; account.lastError = null; }
        catch (error) { account.status = STATUS.UNHEALTHY; account.lastError = 'Refresh failed: ' + error.message; }
    }

    startKeepAlive() {
        if (this._keepAliveRunning) return; this._keepAliveRunning = true;
        for (var i = 0; i < this.accounts.length; i++) this._startAccountRefreshTimer(this.accounts[i]);
        logger.info('[Pool] Keep-alive started');
    }

    _startAccountRefreshTimer(account) {
        var self = this; if (account.refreshTimer) clearInterval(account.refreshTimer);
        account.refreshTimer = setInterval(async function() { if (account.status === STATUS.HEALTHY || account.status === STATUS.UNHEALTHY) { await self._backgroundRefresh(account); } }, this.refreshIntervalMs);
        if (account.refreshTimer.unref) account.refreshTimer.unref();
    }

    stopKeepAlive() {
        for (var i = 0; i < this.accounts.length; i++) { if (this.accounts[i].refreshTimer) { clearInterval(this.accounts[i].refreshTimer); this.accounts[i].refreshTimer = null; } }
        this._keepAliveRunning = false;
    }

    getStatuses() {
        var baseDir = process.env.DATA_DIR || process.cwd();
        return this.accounts.map(function(a) {
            return { id: a.id, label: a.label, status: a.status, activeRequests: a.activeRequests, totalRequests: a.totalRequests, totalErrors: a.totalErrors, lastError: a.lastError, lastUsedAt: a.lastUsedAt, createdAt: a.createdAt, credPath: a.credPath ? path.relative(baseDir, a.credPath) : null, authMethod: (a.service && a.service.authMethod) || 'unknown', region: (a.service && a.service.region) || 'unknown', expiresAt: (a.service && a.service.expiresAt) || null, lastUsage: a.lastUsage || null };
        });
    }

    exportAllCredentials() {
        return this.accounts.map(function(a) {
            return { id: a.id, label: a.label, credentials: { accessToken: a.service.accessToken, refreshToken: a.service.refreshToken, clientId: a.service.clientId || undefined, clientSecret: a.service.clientSecret || undefined, profileArn: a.service.profileArn || undefined, authMethod: a.service.authMethod, region: a.service.region, idcRegion: a.service.idcRegion || undefined, expiresAt: a.service.expiresAt } };
        });
    }

    exportAllCredentialsBase64() { return Buffer.from(JSON.stringify(this.exportAllCredentials(), null, 2)).toString('base64'); }
    getAccountCount() { return this.accounts.length; }
    getHealthyCount() { return this.accounts.filter(function(a) { return a.status === STATUS.HEALTHY; }).length; }
}

var _pool = null;
export function getAccountPool(config) { if (!_pool) _pool = new AccountPool(config || {}); return _pool; }
