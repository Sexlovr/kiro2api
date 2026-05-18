import { atomicWriteFile } from '../utils/file-lock.js';
import axios from 'axios';
import logger from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { KiroApiError } from './kiro-error.js';
import {
    countTextTokens as countTextTokensUtil,
    estimateInputTokens as estimateInputTokensUtil,
    countTokensAnthropic as countTokensUtil,
    processContent as processContentUtil,
    getContentText as getContentTextUtil,
} from '../utils/token-utils.js';

// =============================================================================
// Constants
// =============================================================================

const KIRO_THINKING = {
    MIN_BUDGET_TOKENS: 1024,
    MAX_BUDGET_TOKENS: 24576,
    DEFAULT_BUDGET_TOKENS: 20000,
    START_TAG: '',
    MODE_TAG: '<thinking_mode>',
    MAX_LEN_TAG: '<max_thinking_length>',
    EFFORT_TAG: '<thinking_effort>',
};

const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
    DEFAULT_MODEL_NAME: 'claude-sonnet-4-5',
    AXIOS_TIMEOUT: 120000,
    TOKEN_REFRESH_TIMEOUT: 15000,
    KIRO_VERSION: '0.11.63',
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
    TOTAL_CONTEXT_TOKENS: 200000,
};

const KIRO_MAX_TOOL_NAME_LENGTH = 64;

const MODEL_CONTEXT_TOKENS = {
    'claude-opus-4-7': 1000000,
    'claude-opus-4-6': 1000000,
    'claude-opus-4-5': 1000000,
    'claude-sonnet-4-6': 200000,
    'claude-sonnet-4-5': 200000,
    'claude-haiku-4-5': 200000,
};

// Hardcoded model list — Kiro has no /models endpoint
export const KIRO_FREE_MODELS = [
    'claude-sonnet-4-5',
];

export const KIRO_PAID_MODELS = [
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
];

export const KIRO_ALL_MODELS = [...new Set([...KIRO_FREE_MODELS, ...KIRO_PAID_MODELS])];

const FULL_MODEL_MAPPING = {
    'claude-haiku-4-5': 'claude-haiku-4.5',
    'claude-opus-4-7': 'claude-opus-4.7',
    'claude-opus-4-6': 'claude-opus-4.6',
    'claude-sonnet-4-6': 'claude-sonnet-4.6',
    'claude-opus-4-5': 'claude-opus-4.5',
    'claude-sonnet-4-5': 'claude-sonnet-4.5',
};

const MODEL_MAPPING = Object.fromEntries(
    Object.entries(FULL_MODEL_MAPPING).filter(([key]) => KIRO_ALL_MODELS.includes(key))
);

const KIRO_AUTH_TOKEN_FILE = 'kiro-auth-token.json';

// =============================================================================
// Helpers — Network
// =============================================================================

function isRetryableNetworkError(error) {
    const code = error?.code;
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
}

// =============================================================================
// Helpers — Tool names
// =============================================================================

function shortenKiroToolName(name) {
    const raw = String(name || '');
    if (raw.length <= KIRO_MAX_TOOL_NAME_LENGTH) return raw;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const prefixLen = KIRO_MAX_TOOL_NAME_LENGTH - hash.length - 1;
    return `${raw.slice(0, prefixLen)}_${hash}`;
}

function buildKiroToolNameMaps(tools) {
    const aliasToOriginal = new Map();
    const originalToAlias = new Map();
    if (Array.isArray(tools)) {
        for (const tool of tools) {
            const orig = tool?.name;
            if (!orig) continue;
            const alias = shortenKiroToolName(orig);
            originalToAlias.set(orig, alias);
            if (alias !== orig) aliasToOriginal.set(alias, orig);
        }
    }
    return {
        aliasToOriginal,
        toKiroName: (n) => originalToAlias.get(n) || shortenKiroToolName(n),
        fromKiroName: (n) => aliasToOriginal.get(n) || n,
    };
}

function restoreKiroToolCallNames(toolCalls, maps) {
    if (!toolCalls || !maps?.fromKiroName) return toolCalls;
    return toolCalls.map(tc => ({
        ...tc,
        function: { ...tc.function, name: maps.fromKiroName(tc.function?.name) },
    }));
}

function normalizeKiroToolInput(input) {
    if (input === undefined || input === null) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'object') { try { return JSON.stringify(input); } catch { return String(input); } }
    return String(input);
}

// =============================================================================
// Helpers — Thinking tags
// =============================================================================

function isQuoteCharAt(text, i) {
    if (i < 0 || i >= text.length) return false;
    return '"\'`'.includes(text[i]);
}

function findRealTag(text, tag, start = 0) {
    let s = Math.max(0, start);
    while (true) {
        const pos = text.indexOf(tag, s);
        if (pos === -1) return -1;
        if (!isQuoteCharAt(text, pos - 1) && !isQuoteCharAt(text, pos + tag.length)) return pos;
        s = pos + 1;
    }
}

function isWhitespaceOnly(t) { return !t || String(t).trim().length === 0; }

function findRealThinkingEndTag(buf, start = 0) {
    let s = Math.max(0, start);
    while (true) {
        const pos = findRealTag(buf, KIRO_THINKING.END_TAG, s);
        if (pos === -1) return -1;
        if (buf.slice(pos + KIRO_THINKING.END_TAG.length).startsWith('\n\n')) return pos;
        s = pos + 1;
    }
}

function findRealThinkingEndTagAtBufferEnd(buf, start = 0) {
    let s = Math.max(0, start);
    while (true) {
        const pos = findRealTag(buf, KIRO_THINKING.END_TAG, s);
        if (pos === -1) return -1;
        if (isWhitespaceOnly(buf.slice(pos + KIRO_THINKING.END_TAG.length))) return pos;
        s = pos + 1;
    }
}

// =============================================================================
// Helpers — JSON / bracket parsing
// =============================================================================

function findMatchingBracket(text, startPos, open = '[', close = ']') {
    if (!text || startPos >= text.length || text[startPos] !== open) return -1;
    let count = 1, inStr = false, esc = false;
    for (let i = startPos + 1; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (!inStr) {
            if (ch === open) count++;
            else if (ch === close && --count === 0) return i;
        }
    }
    return -1;
}

function repairJson(str) {
    let r = str;
    r = r.replace(/,\s*([}\]])/g, '$1');
    r = r.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    r = r.replace(/:\s*([a-zA-Z0-9_]+)(?=[,}\]])/g, ':"$1"');
    return r;
}

function extractCredentialsFromCorruptedJson(content) {
    const extracted = {};
    const patterns = {
        refreshToken: /"refreshToken"\s*:\s*"([^"]+)"/,
        accessToken: /"accessToken"\s*:\s*"([^"]+)"/,
        clientId: /"clientId"\s*:\s*"([^"]+)"/,
        clientSecret: /"clientSecret"\s*:\s*"([^"]+)"/,
        profileArn: /"profileArn"\s*:\s*"([^"]+)"/,
        region: /"region"\s*:\s*"([^"]+)"/,
        authMethod: /"authMethod"\s*:\s*"([^"]+)"/,
        expiresAt: /"expiresAt"\s*:\s*"([^"]+)"/,
    };
    for (const [field, pat] of Object.entries(patterns)) {
        const m = content.match(pat);
        if (m?.[1]) extracted[field] = m[1];
    }
    return (extracted.refreshToken || extracted.accessToken) ? extracted : null;
}

function parseSingleToolCall(text) {
    const nameMatch = text.match(/\[Called\s+(\w+)\s+with\s+args:/i);
    if (!nameMatch) return null;
    const funcName = nameMatch[1].trim();
    const argsStart = text.toLowerCase().indexOf('with args:');
    if (argsStart === -1) return null;
    const start = argsStart + 'with args:'.length;
    const end = text.lastIndexOf(']');
    if (end <= start) return null;
    const candidate = text.substring(start, end).trim();
    try {
        const obj = JSON.parse(repairJson(candidate));
        if (typeof obj !== 'object' || obj === null) return null;
        return {
            id: `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`,
            type: 'function',
            function: { name: funcName, arguments: JSON.stringify(obj) },
        };
    } catch { return null; }
}

function parseBracketToolCalls(text) {
    if (!text || !text.includes('[Called')) return null;
    const calls = [];
    const positions = [];
    let s = 0;
    while (true) {
        const p = text.indexOf('[Called', s);
        if (p === -1) break;
        positions.push(p);
        s = p + 1;
    }
    for (let i = 0; i < positions.length; i++) {
        const startPos = positions[i];
        const limit = (i + 1 < positions.length) ? positions[i + 1] : text.length;
        const seg = text.substring(startPos, limit);
        const bEnd = findMatchingBracket(seg, 0);
        const toolText = bEnd !== -1 ? seg.substring(0, bEnd + 1) : (() => {
            const lb = seg.lastIndexOf(']');
            return lb !== -1 ? seg.substring(0, lb + 1) : null;
        })();
        if (!toolText) continue;
        const parsed = parseSingleToolCall(toolText);
        if (parsed) calls.push(parsed);
    }
    return calls.length > 0 ? calls : null;
}

function deduplicateToolCalls(toolCalls) {
    const seen = new Set();
    return toolCalls.filter(tc => {
        const key = `${tc.function.name}-${tc.function.arguments}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// =============================================================================
// Helpers — System runtime info
// =============================================================================

function generateMachineId(credentials) {
    const key = credentials.profileArn || credentials.clientId || 'KIRO_DEFAULT';
    return crypto.createHash('sha256').update(key).digest('hex');
}

function getSystemRuntimeInfo() {
    const p = os.platform();
    const r = os.release();
    const nv = process.version.replace('v', '');
    let osName = p === 'win32' ? `windows#${r}` : p === 'darwin' ? `macos#${r}` : `${p}#${r}`;
    return { osName, nodeVersion: nv };
}

function getContextTokensForModel(model) {
    return MODEL_CONTEXT_TOKENS[model] || KIRO_CONSTANTS.TOTAL_CONTEXT_TOKENS;
}

// =============================================================================
// Throttle queue
// =============================================================================

let throttleQueue = Promise.resolve();
let lastRequestStartedAt = 0;

async function acquireRequestSlot(minIntervalMs) {
    if (!minIntervalMs || minIntervalMs <= 0) return () => {};
    let releaseFn;
    const prev = throttleQueue.catch(() => {});
    throttleQueue = prev.then(() => new Promise(r => { releaseFn = r; }));
    await prev;
    const wait = Math.max(0, minIntervalMs - (Date.now() - lastRequestStartedAt));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestStartedAt = Date.now();
    let released = false;
    return () => { if (!released) { released = true; releaseFn(); } };
}

// =============================================================================
// KiroApiService
// =============================================================================

export class KiroApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), '.aws', 'sso', 'cache');
        this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH || null;

        if (config.KIRO_OAUTH_CREDS_BASE64) {
            try {
                this.base64Creds = JSON.parse(Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8'));
            } catch (e) {
                logger.error(`[Kiro] Failed to parse Base64 creds: ${e.message}`);
            }
        }

        this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
        this.axiosInstance = null;
        this.axiosSocialRefreshInstance = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        await this.loadCredentials();

        const machineId = generateMachineId({ profileArn: this.profileArn, clientId: this.clientId });
        const ver = KIRO_CONSTANTS.KIRO_VERSION;
        const { osName, nodeVersion } = getSystemRuntimeInfo();

        this.axiosInstance = axios.create({
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'amz-sdk-invocation-id': uuidv4(),
                'amz-sdk-request': 'attempt=1; max=3',
                'x-amzn-codewhisperer-optout': true,
                'x-amzn-kiro-agent-mode': 'vibe',
                'x-amz-user-agent': `aws-sdk-js/1.0.34 KiroIDE-${ver}-${machineId}`,
                'user-agent': `aws-sdk-js/1.0.34 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${ver}-${machineId}`,
                'Connection': 'close',
            },
        });

        this.axiosSocialRefreshInstance = axios.create({
            timeout: KIRO_CONSTANTS.TOKEN_REFRESH_TIMEOUT,
            headers: { 'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON },
        });

        this.isInitialized = true;
        logger.info(`[Kiro] Service initialized (region: ${this.region}, auth: ${this.authMethod})`);
    }

    // =========================================================================
    // Credential loading
    // =========================================================================

    async loadCredentials() {
        const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);

        const loadFile = async (fp) => {
            try {
                const raw = await fs.readFile(fp, 'utf8');
                try { return JSON.parse(raw); } catch {
                    try { return JSON.parse(repairJson(raw)); } catch {
                        return extractCredentialsFromCorruptedJson(raw);
                    }
                }
            } catch (e) {
                if (e.code !== 'ENOENT') logger.warn(`[Kiro Auth] Read error ${fp}: ${e.message}`);
                return null;
            }
        };

        let merged = {};

        if (this.base64Creds) {
            Object.assign(merged, this.base64Creds);
            this.base64Creds = null;
        }

        const fileCreds = await loadFile(tokenFilePath);
        if (fileCreds) Object.assign(merged, fileCreds);

        // Also scan sibling JSON files in same directory
        try {
            const dir = path.dirname(tokenFilePath);
            const fname = path.basename(tokenFilePath);
            const files = await fs.readdir(dir);
            for (const f of files) {
                if (f.endsWith('.json') && f !== fname) {
                    const c = await loadFile(path.join(dir, f));
                    if (c) { c.expiresAt = merged.expiresAt; Object.assign(merged, c); }
                }
            }
        } catch { /* ignore */ }

        const apply = (f) => { if (merged[f] != null) this[f] = merged[f]; };
        ['accessToken', 'refreshToken', 'clientId', 'clientSecret', 'authMethod', 'expiresAt', 'profileArn', 'region', 'idcRegion'].forEach(apply);

        if (!this.region) this.region = 'us-east-1';
        if (!this.idcRegion) this.idcRegion = this.region;

        const isSocial = this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL || (!this.authMethod && !(this.clientId && this.clientSecret));
        this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', this.region);
        this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', this.idcRegion);
        this.baseUrl = KIRO_CONSTANTS.BASE_URL.replace('{{region}}', this.region);
    }

    async initializeAuth(forceRefresh = false) {
        if (this.accessToken && !forceRefresh) return;
        await this.loadCredentials();
        if ((forceRefresh || !this.accessToken) && this.refreshToken) {
            const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
            await this._doTokenRefresh(tokenFilePath);
        }
        if (!this.accessToken) throw new Error('No access token available after initialization');
    }

    async _doTokenRefresh(tokenFilePath) {
        const isSocial = this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL || (!this.authMethod && !(this.clientId && this.clientSecret));
        const body = { refreshToken: this.refreshToken };
        let url = this.refreshUrl;

        if (!isSocial) {
            url = this.refreshIDCUrl;
            body.clientId = this.clientId;
            body.clientSecret = this.clientSecret;
            body.grantType = 'refresh_token';
        }

        try {
            const instance = isSocial ? this.axiosSocialRefreshInstance : this.axiosInstance;
            const response = await (instance || axios).post(url, body, { timeout: KIRO_CONSTANTS.TOKEN_REFRESH_TIMEOUT });

            if (response.data?.accessToken) {
                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken || this.refreshToken;
                this.profileArn = response.data.profileArn || this.profileArn;
                const expiresIn = Number(response.data.expiresIn) || 3600;
                this.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

                await this._saveCredentials(tokenFilePath, {
                    accessToken: this.accessToken,
                    refreshToken: this.refreshToken,
                    expiresAt: this.expiresAt,
                    ...(this.profileArn ? { profileArn: this.profileArn } : {}),
                });
                logger.info('[Kiro Auth] Token refreshed successfully');
            } else {
                throw new Error('Missing accessToken in refresh response');
            }
        } catch (error) {
            logger.error('[Kiro Auth] Token refresh failed:', error.message);
            throw error;
        }
    }

    async _saveCredentials(filePath, newData) {
        let existing = {};
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            try { existing = JSON.parse(raw); } catch {
                try { existing = JSON.parse(repairJson(raw)); } catch {
                    existing = extractCredentialsFromCorruptedJson(raw) || {};
                }
            }
        } catch { /* file doesn't exist yet */ }
        await atomicWriteFile(filePath, JSON.stringify({ ...existing, ...newData }, null, 2), { encoding: 'utf8', mode: 0o600 });
    }

    // =========================================================================
    // Token utilities
    // =========================================================================

    static countTextTokens(text) { return countTextTokensUtil(text); }
    static estimateInputTokens(body) { return estimateInputTokensUtil(body); }
    static countTokens(body) { return countTokensUtil(body); }
    countTextTokens(t) { return KiroApiService.countTextTokens(t); }
    estimateInputTokens(b) { return KiroApiService.estimateInputTokens(b); }
    countTokens(b) { return KiroApiService.countTokens(b); }
    getContentText(msg) { return getContentTextUtil(msg); }
    processContent(c) { return processContentUtil(c); }

    _sanitizeToolInput(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
        const s = {};
        for (const [k, v] of Object.entries(input)) { if (k !== '') s[k] = v; }
        return s;
    }

    isTokenExpired() {
        try {
            if (!this.expiresAt) return true;
            return new Date(this.expiresAt).getTime() <= Date.now() + 30000;
        } catch { return true; }
    }

    isExpiryDateNear(minutesThreshold = 30) {
        try {
            const exp = new Date(this.expiresAt).getTime();
            return exp <= Date.now() + minutesThreshold * 60 * 1000;
        } catch { return false; }
    }

    // =========================================================================
    // Thinking prefix
    // =========================================================================

    _normalizeThinkingBudget(budget) {
        let v = Number(budget);
        if (!Number.isFinite(v) || v <= 0) v = KIRO_THINKING.DEFAULT_BUDGET_TOKENS;
        v = Math.floor(v);
        if (v < KIRO_THINKING.MIN_BUDGET_TOKENS) v = KIRO_THINKING.MIN_BUDGET_TOKENS;
        return Math.min(v, KIRO_THINKING.MAX_BUDGET_TOKENS);
    }

    _generateThinkingPrefix(thinking) {
        if (!thinking || typeof thinking !== 'object') return null;
        const type = String(thinking.type || '').toLowerCase().trim();
        if (type === 'enabled') {
            const budget = this._normalizeThinkingBudget(thinking.budget_tokens);
            return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
        }
        if (type === 'adaptive') {
            const e = String(thinking.effort || '').toLowerCase().trim();
            const effort = ['low', 'medium', 'high'].includes(e) ? e : 'high';
            return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${effort}</thinking_effort>`;
        }
        return null;
    }

    _hasThinkingPrefix(text) {
        return text && (text.includes(KIRO_THINKING.MODE_TAG) || text.includes(KIRO_THINKING.MAX_LEN_TAG) || text.includes(KIRO_THINKING.EFFORT_TAG));
    }

    _toClaudeContentBlocks(content) {
        const raw = content ?? '';
        if (!raw) return [];
        const startPos = findRealTag(raw, KIRO_THINKING.START_TAG);
        if (startPos === -1) return [{ type: 'text', text: raw }];
        const before = raw.slice(0, startPos);
        let rest = raw.slice(startPos + KIRO_THINKING.START_TAG.length);
        if (rest.startsWith('\r\n')) rest = rest.slice(2);
        else if (rest.startsWith('\n')) rest = rest.slice(1);
        let endPos = findRealThinkingEndTag(rest);
        if (endPos === -1) endPos = findRealThinkingEndTagAtBufferEnd(rest);
        let thinking = '', after = '';
        if (endPos === -1) { thinking = rest; } else { thinking = rest.slice(0, endPos); after = rest.slice(endPos + KIRO_THINKING.END_TAG.length); }
        if (after.startsWith('\n\n')) after = after.slice(2);
        if (isWhitespaceOnly(after)) after = '';
        const blocks = [];
        if (before && !isWhitespaceOnly(before)) blocks.push({ type: 'text', text: before });
        blocks.push({ type: 'thinking', thinking });
        if (after && !isWhitespaceOnly(after)) blocks.push({ type: 'text', text: after });
        return blocks;
    }

    // =========================================================================
    // Build CodeWhisperer request
    // =========================================================================

    async buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null, thinking = null) {
        const conversationId = uuidv4();
        let systemPrompt = this.getContentText(inSystemPrompt) || '';

        const thinkingPrefix = this._generateThinkingPrefix(thinking);
        if (thinkingPrefix && !this._hasThinkingPrefix(systemPrompt)) {
            systemPrompt = systemPrompt ? `${thinkingPrefix}\n${systemPrompt}` : thinkingPrefix;
        }

        const processed = messages.map(m => ({
            ...m, content: Array.isArray(m.content) ? [...m.content] : m.content,
        }));

        // Remove trailing assistant "{" message
        if (processed.length > 0) {
            const last = processed[processed.length - 1];
            if (last.role === 'assistant' && last.content?.[0]?.type === 'text' && last.content[0].text === '{') {
                processed.pop();
            }
        }

        // Merge adjacent same-role messages
        const merged = [];
        for (const msg of processed) {
            if (merged.length === 0) { merged.push(msg); continue; }
            const prev = merged[merged.length - 1];
            if (msg.role === prev.role) {
                if (Array.isArray(prev.content) && Array.isArray(msg.content)) prev.content.push(...msg.content);
                else if (typeof prev.content === 'string' && typeof msg.content === 'string') prev.content += '\n' + msg.content;
                else if (Array.isArray(prev.content) && typeof msg.content === 'string') prev.content.push({ type: 'text', text: msg.content });
                else if (typeof prev.content === 'string' && Array.isArray(msg.content)) prev.content = [{ type: 'text', text: prev.content }, ...msg.content];
            } else { merged.push(msg); }
        }

        const codewhispererModel = MODEL_MAPPING[model] || model;
        const toolNameMaps = buildKiroToolNameMaps(tools);

        // Build tools context
        let toolsContext = {};
        if (tools && Array.isArray(tools) && tools.length > 0) {
            const filtered = tools.filter(t => { const n = (t.name || '').toLowerCase(); return n !== 'web_search' && n !== 'websearch'; });
            const MAX_DESC = 9216;
            const kiroTools = filtered.filter(t => t.description?.trim()).map(t => {
                let desc = t.description || '';
                if (desc.length > MAX_DESC) desc = desc.substring(0, MAX_DESC) + '...';
                return { toolSpecification: { name: toolNameMaps.toKiroName(t.name), description: desc, inputSchema: { json: t.input_schema || {} } } };
            });
            toolsContext = kiroTools.length > 0 ? { tools: kiroTools } : { tools: [this._placeholderTool()] };
        } else {
            toolsContext = { tools: [this._placeholderTool()] };
        }

        // Build history
        const history = [];
        let startIndex = 0;
        let prependSystem = false;

        if (systemPrompt) {
            if (merged[0]?.role === 'user' && merged.length === 1) {
                prependSystem = true;
            } else if (merged[0]?.role === 'user') {
                history.push({ userInputMessage: { content: `${systemPrompt}\n\n${this.getContentText(merged[0])}`, modelId: codewhispererModel, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } });
                startIndex = 1;
            } else {
                history.push({ userInputMessage: { content: systemPrompt, modelId: codewhispererModel, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } });
            }
        }

        const keepImageThreshold = 5;
        for (let i = startIndex; i < merged.length - 1; i++) {
            const msg = merged[i];
            const distFromEnd = (merged.length - 1) - i;
            const keepImages = distFromEnd <= keepImageThreshold;

            if (msg.role === 'user') {
                const uim = { content: '', modelId: codewhispererModel, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR };
                let toolResults = [], images = [], imageCount = 0;
                if (Array.isArray(msg.content)) {
                    for (const p of msg.content) {
                        if (p.type === 'text') uim.content += p.text;
                        else if (p.type === 'tool_result') toolResults.push({ content: [{ text: this.getContentText(p.content) }], status: 'success', toolUseId: p.tool_use_id });
                        else if (p.type === 'image') {
                            if (keepImages) images.push({ format: p.source.media_type.split('/')[1], source: { bytes: p.source.data } });
                            else imageCount++;
                        }
                    }
                } else { uim.content = this.getContentText(msg); }
                if (images.length > 0) uim.images = images;
                if (imageCount > 0) uim.content += `\n[${imageCount} image(s) omitted from history]`;
                if (toolResults.length > 0) {
                    const unique = []; const seen = new Set();
                    for (const tr of toolResults) { if (!seen.has(tr.toolUseId)) { seen.add(tr.toolUseId); unique.push(tr); } }
                    uim.userInputMessageContext = { toolResults: unique };
                }
                history.push({ userInputMessage: uim });
            } else if (msg.role === 'assistant') {
                const arm = { content: '' };
                let toolUses = [], thinkingText = '';
                if (Array.isArray(msg.content)) {
                    for (const p of msg.content) {
                        if (p.type === 'text') arm.content += p.text;
                        else if (p.type === 'thinking') thinkingText += (p.thinking ?? p.text ?? '');
                        else if (p.type === 'tool_use') toolUses.push({ input: this._sanitizeToolInput(p.input), name: toolNameMaps.toKiroName(p.name), toolUseId: p.id });
                    }
                } else { arm.content = this.getContentText(msg); }
                if (thinkingText) arm.content = arm.content ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${arm.content}` : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
                if (toolUses.length > 0) arm.toolUses = toolUses;
                history.push({ assistantResponseMessage: arm });
            }
        }

        // Build current message
        let current = merged[merged.length - 1];
        let currentContent = '', currentToolResults = [], currentImages = [];

        if (current.role === 'assistant') {
            const arm = { content: '' };
            let thinkingText = '', toolUses = [];
            if (Array.isArray(current.content)) {
                for (const p of current.content) {
                    if (p.type === 'text') arm.content += p.text;
                    else if (p.type === 'thinking') thinkingText += (p.thinking ?? p.text ?? '');
                    else if (p.type === 'tool_use') toolUses.push({ input: this._sanitizeToolInput(p.input), name: toolNameMaps.toKiroName(p.name), toolUseId: p.id });
                }
            } else { arm.content = this.getContentText(current); }
            if (thinkingText) arm.content = arm.content ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${arm.content}` : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
            if (toolUses.length > 0) arm.toolUses = toolUses;
            history.push({ assistantResponseMessage: arm });
            currentContent = 'Continue';
        } else {
            if (history.length > 0 && !history[history.length - 1].assistantResponseMessage) {
                history.push({ assistantResponseMessage: { content: 'Continue' } });
            }
            if (Array.isArray(current.content)) {
                for (const p of current.content) {
                    if (p.type === 'text') currentContent += p.text;
                    else if (p.type === 'tool_result') currentToolResults.push({ content: [{ text: this.getContentText(p.content) }], status: 'success', toolUseId: p.tool_use_id });
                    else if (p.type === 'image') currentImages.push({ format: p.source.media_type.split('/')[1], source: { bytes: p.source.data } });
                }
            } else { currentContent = this.getContentText(current); }
            if (!currentContent) currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
            if (prependSystem) currentContent = currentContent ? `${systemPrompt}\n\n${currentContent}` : systemPrompt;
        }

        const uim = { content: currentContent, modelId: codewhispererModel, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR };
        if (currentImages.length > 0) uim.images = currentImages;
        const ctx = {};
        if (currentToolResults.length > 0) {
            const unique = []; const seen = new Set();
            for (const tr of currentToolResults) { if (!seen.has(tr.toolUseId)) { seen.add(tr.toolUseId); unique.push(tr); } }
            ctx.toolResults = unique;
        }
        if (toolsContext.tools) ctx.tools = toolsContext.tools;
        if (Object.keys(ctx).length > 0) uim.userInputMessageContext = ctx;

        const request = { conversationState: { agentTaskType: 'vibe', chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL, conversationId, currentMessage: { userInputMessage: uim } } };
        if (history.length > 0) request.conversationState.history = history;
        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) request.profileArn = this.profileArn;

        Object.defineProperty(request, '_kiroToolNameMaps', { value: toolNameMaps, enumerable: false });
        return request;
    }

    _placeholderTool() {
        return { toolSpecification: { name: 'no_tool_available', description: 'Placeholder — no tools available.', inputSchema: { json: { type: 'object', properties: {} } } } };
    }

    // =========================================================================
    // API calls
    // =========================================================================

    async callApi(model, body) {
        if (!this.isInitialized) await this.initialize();
        const messages = body.messages || (body.contents?.map(c => ({ role: c.role || 'user', content: c.parts?.map(p => p.text).join('') || '' })));
        if (!messages?.length) throw new Error('No messages in request body');

        const requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking);
        const toolNameMaps = requestData._kiroToolNameMaps;
        const release = await acquireRequestSlot(this.config.KIRO_REQUEST_MIN_INTERVAL_MS);

        try {
            const response = await this.axiosInstance.post(this.baseUrl, requestData, {
                headers: { 'Authorization': `Bearer ${this.accessToken}`, 'amz-sdk-invocation-id': uuidv4() },
            });
            response._kiroToolNameMaps = toolNameMaps;
            return response;
        } catch (error) {
            this._throwTypedError(error);
        } finally { release(); }
    }

    _throwTypedError(error) {
        const status = error.response?.status;
        if (status === 401 || status === 403) throw new KiroApiError(`Auth error (${status})`, { statusCode: status, errorType: 'auth', shouldSwitch: true });
        if (status === 402) throw new KiroApiError('Quota exceeded', { statusCode: 402, errorType: 'quota', shouldSwitch: true });
        if (status === 429) throw new KiroApiError('Rate limited', { statusCode: 429, errorType: 'rate_limit', shouldSwitch: true });
        if (status >= 500) throw new KiroApiError(`Server error (${status})`, { statusCode: status, errorType: 'server', shouldSwitch: true });
        if (isRetryableNetworkError(error)) throw new KiroApiError(`Network error: ${error.code}`, { statusCode: null, errorType: 'network', shouldSwitch: false });
        throw error;
    }

    // =========================================================================
    // Non-streaming generation
    // =========================================================================

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();
        const finalModel = MODEL_MAPPING[model] ? model : model;
        const inputTokens = this.estimateInputTokens(requestBody);
        const response = await this.callApi(finalModel, requestBody);
        const { responseText, toolCalls } = this._processApiResponse(response);
        const thinkingRequested = ['enabled', 'adaptive'].includes(String(requestBody?.thinking?.type).toLowerCase());
        const content = thinkingRequested ? this._toClaudeContentBlocks(responseText) : responseText;
        return this.buildClaudeResponse(content, false, 'assistant', model, toolCalls, inputTokens);
    }

    _processApiResponse(response) {
        const toolNameMaps = response?._kiroToolNameMaps;
        const raw = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);
        const parsed = this.parseEventStreamChunk(raw, toolNameMaps);
        let text = parsed.content;
        let allCalls = [...parsed.toolCalls];
        const rawBracket = parseBracketToolCalls(raw);
        if (rawBracket) allCalls.push(...restoreKiroToolCallNames(rawBracket, toolNameMaps));
        const unique = deduplicateToolCalls(allCalls);
        if (unique.length > 0) {
            for (const tc of unique) {
                const escaped = tc.function.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                text = text.replace(new RegExp(`\\[Called\\s+${escaped}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs'), '');
            }
            text = text.trim();
        }
        text = text.replace(/(?<!\\)\\n/g, '\n');
        return { responseText: text, toolCalls: unique };
    }

    parseEventStreamChunk(rawData, toolNameMaps = null) {
        const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        let fullContent = '';
        const toolCalls = [];
        let currentTool = null;

        const sseRegex = /:message-typeevent({[^]*?(?=:event-type|$))/g;
        const legacyRegex = /event({.*?(?=event{|$))/gs;
        let matches = [...rawStr.matchAll(sseRegex)];
        if (matches.length === 0) matches = [...rawStr.matchAll(legacyRegex)];

        for (const match of matches) {
            const block = match[1];
            if (!block?.trim()) continue;
            let pos = 0;
            while ((pos = block.indexOf('}', pos + 1)) !== -1) {
                try {
                    const evt = JSON.parse(block.substring(0, pos + 1).trim());
                    if (evt.name && evt.toolUseId) {
                        if (!currentTool) currentTool = { id: evt.toolUseId, type: 'function', function: { name: toolNameMaps?.fromKiroName ? toolNameMaps.fromKiroName(evt.name) : evt.name, arguments: '' } };
                        if (evt.input) currentTool.function.arguments += normalizeKiroToolInput(evt.input);
                        if (evt.stop) { try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)); } catch {} toolCalls.push(currentTool); currentTool = null; }
                    } else if (!evt.followupPrompt && evt.content) {
                        fullContent += evt.content;
                    }
                    break;
                } catch { continue; }
            }
        }
        if (currentTool) toolCalls.push(currentTool);

        const bracket = parseBracketToolCalls(fullContent);
        if (bracket) {
            toolCalls.push(...bracket);
            for (const tc of bracket) {
                const escaped = tc.function.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                fullContent = fullContent.replace(new RegExp(`\\[Called\\s+${escaped}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs'), '');
            }
            fullContent = fullContent.trim();
        }

        return { content: fullContent || '', toolCalls: restoreKiroToolCallNames(deduplicateToolCalls(toolCalls), toolNameMaps) };
    }

    // =========================================================================
    // AWS event stream parsing (binary streaming)
    // =========================================================================

    parseAwsEventStreamBuffer(buffer) {
        const events = [];
        let remaining = buffer;
        let searchStart = 0;

        while (true) {
            const jsonStart = remaining.indexOf('{', searchStart);
            if (jsonStart < 0) break;
            let braceCount = 0, jsonEnd = -1, inStr = false, esc = false;
            for (let i = jsonStart; i < remaining.length; i++) {
                const ch = remaining[i];
                if (esc) { esc = false; continue; }
                if (ch === '\\') { esc = true; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (!inStr) {
                    if (ch === '{') braceCount++;
                    else if (ch === '}' && --braceCount === 0) { jsonEnd = i; break; }
                }
            }
            if (jsonEnd < 0) { remaining = remaining.substring(jsonStart); break; }
            try {
                const parsed = JSON.parse(remaining.substring(jsonStart, jsonEnd + 1));
                if (parsed.content !== undefined && !parsed.followupPrompt) events.push({ type: 'content', data: parsed.content });
                else if (parsed.name && parsed.toolUseId) events.push({ type: 'toolUse', data: { name: parsed.name, toolUseId: parsed.toolUseId, input: normalizeKiroToolInput(parsed.input), stop: parsed.stop || false } });
                else if (parsed.input !== undefined && !parsed.name) events.push({ type: 'toolUseInput', data: { toolUseId: parsed.toolUseId, input: normalizeKiroToolInput(parsed.input) } });
                else if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) events.push({ type: 'toolUseStop', data: { stop: parsed.stop } });
                else if (parsed.contextUsagePercentage !== undefined) events.push({ type: 'contextUsage', data: { contextUsagePercentage: parsed.contextUsagePercentage } });
            } catch { searchStart = jsonStart + 1; continue; }
            searchStart = jsonEnd + 1;
            if (searchStart >= remaining.length) { remaining = ''; break; }
        }
        if (searchStart > 0 && remaining.length > 0) remaining = remaining.substring(searchStart);
        return { events, remaining };
    }

    // =========================================================================
    // Real streaming
    // =========================================================================

    async * streamApiReal(model, body, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = 3;
        const messages = body.messages || (body.contents?.map(c => ({ role: c.role || 'user', content: c.parts?.map(p => p.text).join('') || '' })));
        if (!messages?.length) throw new Error('No messages in request body');

        const requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking);
        const toolNameMaps = requestData._kiroToolNameMaps;
        const release = await acquireRequestSlot(this.config.KIRO_REQUEST_MIN_INTERVAL_MS);
        let stream = null;

        try {
            const response = await this.axiosInstance.post(this.baseUrl, requestData, {
                headers: { 'Authorization': `Bearer ${this.accessToken}`, 'amz-sdk-invocation-id': uuidv4() },
                responseType: 'stream',
            });

            stream = response.data;
            let buffer = '', lastContent = null;

            for await (const chunk of stream) {
                buffer += chunk.toString();
                const { events, remaining } = this.parseAwsEventStreamBuffer(buffer);
                buffer = remaining;
                for (const event of events) {
                    if (event.type === 'content' && event.data) {
                        if (lastContent === event.data) continue;
                        lastContent = event.data;
                        yield { type: 'content', content: event.data };
                    } else if (event.type === 'toolUse') {
                        yield { type: 'toolUse', toolUse: { ...event.data, name: toolNameMaps?.fromKiroName ? toolNameMaps.fromKiroName(event.data.name) : event.data.name } };
                    } else if (event.type === 'toolUseInput') yield { type: 'toolUseInput', input: event.data.input };
                    else if (event.type === 'toolUseStop') yield { type: 'toolUseStop', stop: event.data.stop };
                    else if (event.type === 'contextUsage') yield { type: 'contextUsage', contextUsagePercentage: event.data.contextUsagePercentage };
                }
            }
        } catch (error) {
            if (stream?.destroy) stream.destroy();
            if (isRetryableNetworkError(error) && retryCount < maxRetries) {
                const delay = 1000 * Math.pow(2, retryCount);
                logger.info(`[Kiro] Network error in stream, retrying in ${delay}ms (${retryCount + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, delay));
                yield* this.streamApiReal(model, body, retryCount + 1);
                return;
            }
            this._throwTypedError(error);
        } finally {
            release();
            if (stream?.destroy) stream.destroy();
        }
    }

    // =========================================================================
    // Streaming generation (Claude SSE format)
    // =========================================================================

    async * generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();
        const finalModel = MODEL_MAPPING[model] ? model : model;
        const messageId = uuidv4();
        const thinkingRequested = ['enabled', 'adaptive'].includes(String(requestBody?.thinking?.type).toLowerCase());

        // Stream state
        const S = {
            thinkingRequested, buffer: '', pendingText: '', inThinking: false, thinkingExtracted: false,
            thinkingBlockIndex: null, textBlockIndex: null, nextBlockIndex: 0, stoppedBlocks: new Set(),
            stripThinkingLF: false, stripTextLF: false, hasVisibleText: false, hasThinkingContent: false,
        };

        const ensureBlock = (type) => {
            const key = type === 'thinking' ? 'thinkingBlockIndex' : 'textBlockIndex';
            if (S[key] != null) return [];
            const idx = S.nextBlockIndex++;
            S[key] = idx;
            return [{ type: 'content_block_start', index: idx, content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } }];
        };

        const stopBlock = (idx) => {
            if (idx == null || S.stoppedBlocks.has(idx)) return [];
            S.stoppedBlocks.add(idx);
            return [{ type: 'content_block_stop', index: idx }];
        };

        const textDelta = (t) => {
            if (!t) return [];
            if (!isWhitespaceOnly(t)) S.hasVisibleText = true;
            return [...ensureBlock('text'), { type: 'content_block_delta', index: S.textBlockIndex, delta: { type: 'text_delta', text: t.replace(/(?<!\\)\\n/g, '\n') } }];
        };

        const thinkDelta = (t) => {
            if (t) S.hasThinkingContent = true;
            return [...ensureBlock('thinking'), { type: 'content_block_delta', index: S.thinkingBlockIndex, delta: { type: 'thinking_delta', thinking: t.replace(/(?<!\\)\\n/g, '\n') } }];
        };

        function* emit(evts) { for (const e of evts) yield e; }

        let totalContent = '', contextPct = null, inputTokens = 0;
        const estimatedInput = this.estimateInputTokens(requestBody);
        const toolCalls = [];
        let currentTool = null;
        const toolBlockIndexes = new Map();

        yield { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, usage: { input_tokens: estimatedInput, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } };

        for await (const event of this.streamApiReal(finalModel, requestBody)) {
            if (event.type === 'contextUsage') { contextPct = event.contextUsagePercentage; continue; }

            if (event.type === 'content' && event.content) {
                totalContent += event.content;
                if (!thinkingRequested) {
                    S.buffer += event.content;
                    if (S.buffer.endsWith('\\')) continue;
                    yield* emit(textDelta(S.buffer));
                    S.buffer = '';
                    continue;
                }

                S.buffer += event.content;
                const evts = [];

                while (S.buffer.length > 0) {
                    if (!S.inThinking && !S.thinkingExtracted) {
                        const sp = findRealTag(S.buffer, KIRO_THINKING.START_TAG);
                        if (sp !== -1) {
                            const before = `${S.pendingText}${S.buffer.slice(0, sp)}`;
                            if (before && !isWhitespaceOnly(before)) evts.push(...textDelta(before));
                            S.pendingText = '';
                            S.buffer = S.buffer.slice(sp + KIRO_THINKING.START_TAG.length);
                            S.inThinking = true; S.stripThinkingLF = true;
                            continue;
                        }
                        const safe = Math.max(0, S.buffer.length - KIRO_THINKING.START_TAG.length);
                        if (safe > 0) {
                            const t = S.buffer.slice(0, safe);
                            if (isWhitespaceOnly(t)) { S.pendingText += t.slice(0, 1024 - S.pendingText.length); }
                            else { evts.push(...textDelta(`${S.pendingText}${t}`)); S.pendingText = ''; }
                            S.buffer = S.buffer.slice(safe);
                        }
                        break;
                    }
                    if (S.inThinking) {
                        if (S.stripThinkingLF) {
                            if (S.buffer.startsWith('\r\n')) S.buffer = S.buffer.slice(2);
                            else if (S.buffer.startsWith('\n')) S.buffer = S.buffer.slice(1);
                            if (S.buffer.length > 0) S.stripThinkingLF = false;
                            else { S.stripThinkingLF = false; break; }
                        }
                        let ep = findRealThinkingEndTag(S.buffer);
                        if (ep === -1) ep = findRealThinkingEndTagAtBufferEnd(S.buffer);
                        if (ep !== -1) {
                            if (S.buffer.slice(0, ep)) evts.push(...thinkDelta(S.buffer.slice(0, ep)));
                            S.buffer = S.buffer.slice(ep + KIRO_THINKING.END_TAG.length);
                            S.inThinking = false; S.thinkingExtracted = true;
                            evts.push(...thinkDelta('')); evts.push(...stopBlock(S.thinkingBlockIndex));
                            S.stripTextLF = true;
                            continue;
                        }
                        const safe = Math.max(0, S.buffer.length - KIRO_THINKING.END_TAG.length);
                        if (safe > 0) { evts.push(...thinkDelta(S.buffer.slice(0, safe))); S.buffer = S.buffer.slice(safe); }
                        break;
                    }
                    if (S.thinkingExtracted) {
                        let rest = S.buffer; S.buffer = '';
                        if (S.stripTextLF) {
                            if (rest.startsWith('\r\n\r\n')) rest = rest.slice(4);
                            else if (rest.startsWith('\n\n')) rest = rest.slice(2);
                            S.stripTextLF = false;
                        }
                        if (rest) evts.push(...textDelta(rest));
                        break;
                    }
                }
                yield* emit(evts);
                continue;
            }

            // Tool use events
            if (event.type === 'toolUse') {
                const tc = event.toolUse;
                totalContent += (tc.name || '') + (tc.input || '');
                const evts = [];
                if (tc.name && tc.toolUseId) {
                    evts.push(...stopBlock(S.textBlockIndex));
                    if (currentTool && currentTool.toolUseId !== tc.toolUseId) {
                        let inp = currentTool.input; try { inp = JSON.parse(inp); } catch {}
                        toolCalls.push({ toolUseId: currentTool.toolUseId, name: currentTool.name, input: inp });
                        const bi = toolBlockIndexes.get(currentTool.toolUseId);
                        if (bi != null) evts.push({ type: 'content_block_stop', index: bi });
                    }
                    if (!currentTool || currentTool.toolUseId !== tc.toolUseId) {
                        const bi = S.nextBlockIndex++;
                        toolBlockIndexes.set(tc.toolUseId, bi);
                        evts.push({ type: 'content_block_start', index: bi, content_block: { type: 'tool_use', id: tc.toolUseId, name: tc.name, input: {} } });
                        currentTool = { toolUseId: tc.toolUseId, name: tc.name, input: '' };
                    }
                    currentTool.input += tc.input || '';
                    if (tc.input) { const bi = toolBlockIndexes.get(tc.toolUseId); if (bi != null) evts.push({ type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: tc.input } }); }
                    if (tc.stop) {
                        let inp = currentTool.input; try { inp = JSON.parse(inp); } catch {}
                        toolCalls.push({ toolUseId: currentTool.toolUseId, name: currentTool.name, input: inp });
                        const bi = toolBlockIndexes.get(currentTool.toolUseId); if (bi != null) evts.push({ type: 'content_block_stop', index: bi });
                        currentTool = null;
                    }
                }
                yield* emit(evts);
            } else if (event.type === 'toolUseInput') {
                const delta = normalizeKiroToolInput(event.input);
                totalContent += delta;
                if (currentTool) {
                    currentTool.input += delta;
                    const bi = toolBlockIndexes.get(currentTool.toolUseId);
                    if (bi != null && delta) yield { type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: delta } };
                }
            } else if (event.type === 'toolUseStop' && currentTool && event.stop) {
                let inp = currentTool.input; try { inp = JSON.parse(inp); } catch {}
                toolCalls.push({ toolUseId: currentTool.toolUseId, name: currentTool.name, input: inp });
                const bi = toolBlockIndexes.get(currentTool.toolUseId); if (bi != null) yield { type: 'content_block_stop', index: bi };
                currentTool = null;
            }
        }

        // Flush remaining
        if (currentTool) {
            let inp = currentTool.input; try { inp = JSON.parse(inp); } catch {}
            toolCalls.push({ toolUseId: currentTool.toolUseId, name: currentTool.name, input: inp });
            const bi = toolBlockIndexes.get(currentTool.toolUseId); if (bi != null) yield { type: 'content_block_stop', index: bi };
        }

        if (thinkingRequested && (S.inThinking || S.buffer || S.pendingText)) {
            if (S.inThinking) {
                if (S.stripThinkingLF) { if (S.buffer.startsWith('\r\n')) S.buffer = S.buffer.slice(2); else if (S.buffer.startsWith('\n')) S.buffer = S.buffer.slice(1); }
                yield* emit(thinkDelta(S.buffer)); S.buffer = '';
                yield* emit(thinkDelta('')); yield* emit(stopBlock(S.thinkingBlockIndex));
            } else if (!S.thinkingExtracted) {
                const rem = `${S.pendingText}${S.buffer}`; S.pendingText = ''; S.buffer = '';
                if (rem) yield* emit(textDelta(rem));
            } else {
                let rem = S.buffer; S.buffer = '';
                if (S.stripTextLF) { if (rem.startsWith('\n\n')) rem = rem.slice(2); S.stripTextLF = false; }
                if (rem) yield* emit(textDelta(rem));
            }
        } else if (!thinkingRequested && S.buffer) {
            yield* emit(textDelta(S.buffer)); S.buffer = '';
        }

        const onlyThinking = thinkingRequested && S.hasThinkingContent && !S.hasVisibleText && toolCalls.length === 0;
        if (onlyThinking) yield* emit(textDelta(' '));
        yield* emit(stopBlock(S.textBlockIndex));

        // Compute tokens
        let outputTokens = this.countTextTokens(totalContent);
        for (const tc of toolCalls) outputTokens += this.countTextTokens(JSON.stringify(tc.input || {}));
        if (contextPct != null && contextPct > 0) {
            const ctx = getContextTokensForModel(model);
            inputTokens = Math.max(0, Math.round(ctx * contextPct / 100) - outputTokens);
        } else { inputTokens = estimatedInput; }

        yield { type: 'message_delta', delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : (onlyThinking ? 'max_tokens' : 'end_turn') }, usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
        yield { type: 'message_stop' };
    }

    // =========================================================================
    // Build Claude response (non-streaming)
    // =========================================================================

    buildClaudeResponse(content, isStream, role, model, toolCalls = null, inputTokens = 0) {
        if (isStream) {
            const events = [];
            events.push({ type: 'message_start', message: { id: uuidv4(), type: 'message', role, model, usage: { input_tokens: inputTokens, output_tokens: 0 }, content: [] } });
            let outputTokens = 0;
            let stopReason = 'end_turn';

            if (toolCalls?.length) {
                toolCalls.forEach((tc, i) => {
                    let inp; try { inp = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch { inp = { raw: tc.function.arguments }; }
                    events.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
                    events.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(inp) } });
                    events.push({ type: 'content_block_stop', index: i });
                    outputTokens += this.countTextTokens(JSON.stringify(inp));
                });
                stopReason = 'tool_use';
            }

            if (content) {
                const idx = toolCalls?.length || 0;
                events.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
                events.push({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: content } });
                events.push({ type: 'content_block_stop', index: idx });
                outputTokens += this.countTextTokens(content);
                if (!toolCalls?.length) stopReason = 'end_turn';
            }

            events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
            events.push({ type: 'message_stop' });
            return events;
        }

        // Non-streaming
        const contentArray = [];
        let outputTokens = 0, hasText = false, hasThinking = false;

        if (Array.isArray(content)) {
            for (const b of content) {
                if (b?.type === 'text') { contentArray.push(b); outputTokens += this.countTextTokens(b.text); if (!isWhitespaceOnly(b.text)) hasText = true; }
                else if (b?.type === 'thinking') { contentArray.push(b); outputTokens += this.countTextTokens(b.thinking); if (b.thinking) hasThinking = true; }
            }
        } else if (content) {
            contentArray.push({ type: 'text', text: content }); outputTokens += this.countTextTokens(content); hasText = true;
        }

        let stopReason = 'end_turn';
        if (toolCalls?.length) {
            for (const tc of toolCalls) {
                let inp; try { inp = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch { inp = { raw: tc.function.arguments }; }
                contentArray.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: inp });
                outputTokens += this.countTextTokens(tc.function.arguments);
            }
            stopReason = 'tool_use';
        }
        if (hasThinking && !hasText && !toolCalls?.length) {
            contentArray.push({ type: 'text', text: ' ' }); stopReason = 'max_tokens';
        }

        return { id: uuidv4(), type: 'message', role, model, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, content: contentArray };
    }

    // =========================================================================
    // Models + usage
    // =========================================================================

    async listModels() {
        return { models: KIRO_ALL_MODELS.map(id => ({ name: id })) };
    }

    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        let url = this.baseUrl.replace('generateAssistantResponse', 'getUsageLimits');
        const params = new URLSearchParams({ isEmailRequired: 'true', origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR, resourceType: 'AGENTIC_REQUEST' });
        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) params.append('profileArn', this.profileArn);

        try {
            const resp = await this.axiosInstance.get(`${url}?${params}`, { headers: { 'Authorization': `Bearer ${this.accessToken}`, 'amz-sdk-invocation-id': uuidv4() } });
            return resp.data;
        } catch (error) { this._throwTypedError(error); }
    }
}
