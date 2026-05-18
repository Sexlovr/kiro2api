import { KiroApiService } from '../providers/claude-kiro.js';
import { KiroApiError } from '../providers/kiro-error.js';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const STATUS = {
    HEALTHY: 'healthy',
    REFRESHING: 'refreshing',
    UNHEALTHY: 'unhealthy',
    COOLDOWN: 'cooldown',
};

const COOLDOWN_MS = {
    RATE_LIMIT: 30_000,   // 429 → 30s cooldown
    SERVER: 10_000,       // 5xx → 10s cooldown
};

class AccountPool {
    constructor(config = {}) {
        this.accounts = [];
        this.roundRobinIndex = 0;
        this.refreshIntervalMs = config.tokenRefreshIntervalMs
            || parseInt(process.env.KIRO_TOKEN_REFRESH_INTERVAL_MS, 10)
            || 45 * 60 * 1000; // 45 min default
        this.configsDir = config.configsDir || path.join(process.cwd(), 'configs', 'kiro');
        this._keepAliveRunning = false;
    }

    // =========================================================================
    // Loading accounts
    // =========================================================================

    /**
     * Full initialization: load from env vars + config directory
     */
    async initialize() {
        await this._ensureConfigsDir();
        await this._loadFromEnv();
        await this._loadFromDirectory();

        const total = this.accounts.length;
        const healthy = this.accounts.filter(a => a.status === STATUS.HEALTHY).length;
        logger.info(`[Pool] Initialized: ${total} account(s) loaded, ${healthy} healthy`);

        if (total > 0) this.startKeepAlive();
    }

    async _ensureConfigsDir() {
        try {
            await fs.mkdir(this.configsDir, { recursive: true });
        } catch (e) {
            logger.warn(`[Pool] Could not create configs dir: ${e.message}`);
        }
    }

    async _loadFromEnv() {
        // Single account via base64
        const single = process.env.KIRO_OAUTH_CREDS_BASE64;
        if (single) {
            await this.addAccountFromBase64(single, 'env:KIRO_OAUTH_CREDS_BASE64');
        }

        // Multiple accounts: comma-separated base64 strings
        const multi = process.env.KIRO_ACCOUNTS_BASE64;
        if (multi) {
            const parts = multi.split(',').map(s => s.trim()).filter(Boolean);
            for (let i = 0; i < parts.length; i++) {
                await this.addAccountFromBase64(parts[i], `env:KIRO_ACCOUNTS_BASE64[${i}]`);
            }
        }
    }

    async _loadFromDirectory() {
        let entries;
        try {
            entries = await fs.readdir(this.configsDir, { withFileTypes: true });
        } catch (e) {
            logger.info(`[Pool] No configs directory to scan: ${e.message}`);
            return;
        }

        for (const entry of entries) {
            try {
                if (entry.isDirectory()) {
                    const subDir = path.join(this.configsDir, entry.name);
                    const files = await fs.readdir(subDir);
                    const jsonFile = files.find(f => f.endsWith('.json'));
                    if (jsonFile) {
                        await this.addAccountFromFile(path.join(subDir, jsonFile));
                    }
                } else if (entry.isFile() && entry.name.endsWith('.json')) {
                    await this.addAccountFromFile(path.join(this.configsDir, entry.name));
                }
            } catch (e) {
                logger.warn(`[Pool] Error loading ${entry.name}: ${e.message}`);
            }
        }
    }

    /**
     * Rescan configs dir and add any new accounts not already loaded
     */
    async scanAndLoadNew() {
        const existingPaths = new Set(this.accounts.map(a => a.credPath));
        let entries;
        try {
            entries = await fs.readdir(this.configsDir, { withFileTypes: true });
        } catch { return 0; }

        let added = 0;
        for (const entry of entries) {
            try {
                let credPath = null;
                if (entry.isDirectory()) {
                    const subDir = path.join(this.configsDir, entry.name);
                    const files = await fs.readdir(subDir);
                    const jsonFile = files.find(f => f.endsWith('.json'));
                    if (jsonFile) credPath = path.join(subDir, jsonFile);
                } else if (entry.isFile() && entry.name.endsWith('.json')) {
                    credPath = path.join(this.configsDir, entry.name);
                }
                if (credPath && !existingPaths.has(credPath)) {
                    await this.addAccountFromFile(credPath);
                    added++;
                }
            } catch (e) {
                logger.warn(`[Pool] Error scanning ${entry.name}: ${e.message}`);
            }
        }
        if (added > 0) logger.info(`[Pool] Scan found ${added} new account(s)`);
        return added;
    }

    // =========================================================================
    // Adding accounts
    // =========================================================================

    async addAccountFromFile(credPath) {
        // Check for duplicates
        if (this.accounts.some(a => a.credPath === credPath)) {
            logger.info(`[Pool] Account already loaded from ${credPath}, skipping`);
            return null;
        }

        try {
            const service = new KiroApiService({
                KIRO_OAUTH_CREDS_FILE_PATH: credPath,
            });
            await service.initialize();

            const account = this._createAccountEntry(service, credPath, path.basename(credPath));
            this.accounts.push(account);
            logger.info(`[Pool] ✅ Added account ${account.id} from ${path.relative(process.cwd(), credPath)}`);

            // Start keep-alive for this new account if pool is already running
            if (this._keepAliveRunning) this._startAccountRefreshTimer(account);
            return account.id;
        } catch (error) {
            logger.error(`[Pool] ❌ Failed to add account from ${credPath}: ${error.message}`);
            return null;
        }
    }

    async addAccountFromBase64(base64String, sourceLabel = 'base64') {
        try {
            const decoded = Buffer.from(base64String, 'base64').toString('utf8');
            const credentials = JSON.parse(decoded);

            // Save to disk so it persists
            const timestamp = Date.now();
            const folderName = `${timestamp}_kiro-auth-token`;
            const targetDir = path.join(this.configsDir, folderName);
            await fs.mkdir(targetDir, { recursive: true });
            const credPath = path.join(targetDir, `${folderName}.json`);
            await fs.writeFile(credPath, JSON.stringify(credentials, null, 2));

            const id = await this.addAccountFromFile(credPath);
            if (id) logger.info(`[Pool] Account added from ${sourceLabel}`);
            return id;
        } catch (error) {
            logger.error(`[Pool] Failed to add account from ${sourceLabel}: ${error.message}`);
            return null;
        }
    }

    async addAccountFromCredentials(credentials) {
        try {
            const timestamp = Date.now();
            const folderName = `${timestamp}_kiro-auth-token`;
            const targetDir = path.join(this.configsDir, folderName);
            await fs.mkdir(targetDir, { recursive: true });
            const credPath = path.join(targetDir, `${folderName}.json`);
            await fs.writeFile(credPath, JSON.stringify(credentials, null, 2));
            return await this.addAccountFromFile(credPath);
        } catch (error) {
            logger.error(`[Pool] Failed to add account from credentials: ${error.message}`);
            return null;
        }
    }

    _createAccountEntry(service, credPath, label) {
        return {
            id: crypto.randomBytes(4).toString('hex'),
            label: label || 'unknown',
            service,
            credPath,
            status: STATUS.HEALTHY,
            activeRequests: 0,
            lastError: null,
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            refreshTimer: null,
            totalRequests: 0,
            totalErrors: 0,
        };
    }

    // =========================================================================
    // Account selection (least-connections + round-robin)
    // =========================================================================

    /**
     * Acquire the best available account for a request.
     * Returns { account, release(error?) }
     */
    acquireAccount() {
        const account = this._selectBestAccount();
        if (!account) {
            const total = this.accounts.length;
            const statuses = this.accounts.map(a => `${a.id}:${a.status}`).join(', ');
            throw new Error(
                total === 0
                    ? 'No Kiro accounts configured. Add credentials via /ui/auth or env vars.'
                    : `No healthy accounts available (${total} total: ${statuses})`
            );
        }

        account.activeRequests++;
        account.lastUsedAt = new Date().toISOString();
        account.totalRequests++;

        let released = false;
        const release = (error = null) => {
            if (released) return;
            released = true;
            account.activeRequests = Math.max(0, account.activeRequests - 1);
            if (error) this._handleAccountError(account, error);
        };

        return { account, release };
    }

    _selectBestAccount() {
        const healthy = this.accounts.filter(a => a.status === STATUS.HEALTHY);
        if (healthy.length === 0) return null;

        // Find minimum active requests
        const minActive = Math.min(...healthy.map(a => a.activeRequests));
        const candidates = healthy.filter(a => a.activeRequests === minActive);

        // Round-robin among same-load candidates
        const idx = this.roundRobinIndex % candidates.length;
        this.roundRobinIndex = (this.roundRobinIndex + 1) % 1_000_000;
        return candidates[idx];
    }

    // =========================================================================
    // Error handling
    // =========================================================================

    _handleAccountError(account, error) {
        account.totalErrors++;
        const type = error instanceof KiroApiError ? error.errorType : 'unknown';

        switch (type) {
            case 'auth':
                logger.warn(`[Pool] Account ${account.id} auth error — refreshing in background`);
                account.lastError = error.message;
                this._backgroundRefresh(account);
                break;

            case 'rate_limit':
                logger.warn(`[Pool] Account ${account.id} rate limited — cooldown ${COOLDOWN_MS.RATE_LIMIT}ms`);
                account.status = STATUS.COOLDOWN;
                account.lastError = error.message;
                setTimeout(() => {
                    if (account.status === STATUS.COOLDOWN) account.status = STATUS.HEALTHY;
                }, COOLDOWN_MS.RATE_LIMIT);
                break;

            case 'quota':
                logger.warn(`[Pool] Account ${account.id} quota exhausted — marking unhealthy`);
                account.status = STATUS.UNHEALTHY;
                account.lastError = 'Quota exhausted (resets next month)';
                break;

            case 'server':
                logger.warn(`[Pool] Account ${account.id} server error — cooldown ${COOLDOWN_MS.SERVER}ms`);
                account.status = STATUS.COOLDOWN;
                account.lastError = error.message;
                setTimeout(() => {
                    if (account.status === STATUS.COOLDOWN) account.status = STATUS.HEALTHY;
                }, COOLDOWN_MS.SERVER);
                break;

            case 'network':
                // Network errors are transient, don't penalize the account
                logger.info(`[Pool] Account ${account.id} network error (not penalized)`);
                break;

            default:
                account.lastError = error.message;
                break;
        }
    }

    async _backgroundRefresh(account) {
        if (account.status === STATUS.REFRESHING) return;
        account.status = STATUS.REFRESHING;

        try {
            await account.service.loadCredentials();
            await account.service.initializeAuth(true);
            account.status = STATUS.HEALTHY;
            account.lastError = null;
            logger.info(`[Pool] ✅ Account ${account.id} refreshed successfully`);
        } catch (error) {
            account.status = STATUS.UNHEALTHY;
            account.lastError = `Refresh failed: ${error.message}`;
            logger.error(`[Pool] ❌ Account ${account.id} refresh failed: ${error.message}`);
        }
    }

    // =========================================================================
    // Keep-alive (proactive token refresh)
    // =========================================================================

    startKeepAlive() {
        if (this._keepAliveRunning) return;
        this._keepAliveRunning = true;
        for (const account of this.accounts) {
            this._startAccountRefreshTimer(account);
        }
        logger.info(`[Pool] Keep-alive started (interval: ${Math.round(this.refreshIntervalMs / 60000)}min)`);
    }

    _startAccountRefreshTimer(account) {
        if (account.refreshTimer) clearInterval(account.refreshTimer);
        account.refreshTimer = setInterval(async () => {
            if (account.status === STATUS.HEALTHY || account.status === STATUS.UNHEALTHY) {
                logger.info(`[Pool] Keep-alive refresh for account ${account.id}`);
                await this._backgroundRefresh(account);
            }
        }, this.refreshIntervalMs);
        // Don't block process exit
        if (account.refreshTimer.unref) account.refreshTimer.unref();
    }

    stopKeepAlive() {
        for (const account of this.accounts) {
            if (account.refreshTimer) {
                clearInterval(account.refreshTimer);
                account.refreshTimer = null;
            }
        }
        this._keepAliveRunning = false;
        logger.info('[Pool] Keep-alive stopped');
    }

    // =========================================================================
    // Status / Export
    // =========================================================================

    getStatuses() {
        return this.accounts.map(a => ({
            id: a.id,
            label: a.label,
            status: a.status,
            activeRequests: a.activeRequests,
            totalRequests: a.totalRequests,
            totalErrors: a.totalErrors,
            lastError: a.lastError,
            lastUsedAt: a.lastUsedAt,
            createdAt: a.createdAt,
            credPath: a.credPath ? path.relative(process.cwd(), a.credPath) : null,
            authMethod: a.service?.authMethod || 'unknown',
            region: a.service?.region || 'unknown',
            expiresAt: a.service?.expiresAt || null,
        }));
    }

    exportAllCredentials() {
        return this.accounts.map(a => ({
            id: a.id,
            label: a.label,
            credentials: {
                accessToken: a.service.accessToken,
                refreshToken: a.service.refreshToken,
                clientId: a.service.clientId || undefined,
                clientSecret: a.service.clientSecret || undefined,
                profileArn: a.service.profileArn || undefined,
                authMethod: a.service.authMethod,
                region: a.service.region,
                idcRegion: a.service.idcRegion || undefined,
                expiresAt: a.service.expiresAt,
            },
        }));
    }

    exportAllCredentialsBase64() {
        const creds = this.exportAllCredentials();
        return Buffer.from(JSON.stringify(creds, null, 2)).toString('base64');
    }

    getAccountCount() { return this.accounts.length; }
    getHealthyCount() { return this.accounts.filter(a => a.status === STATUS.HEALTHY).length; }
}

// =========================================================================
// Singleton
// =========================================================================
let _pool = null;
export function getAccountPool(config = {}) {
    if (!_pool) _pool = new AccountPool(config);
    return _pool;
}
