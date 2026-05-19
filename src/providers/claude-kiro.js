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
import {
    getAllModelIds,
    getModelMapping,
    getContextTokenMap,
    getFreeModels,
    getPaidModels,
} from '../models.js';

// =============================================================================
// Inline atomic file write
// =============================================================================
async function atomicWriteFile(filePath, data, options) {
    options = options || {};
    var dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    var tmpSuffix = '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    var tmpPath = filePath + tmpSuffix;
    try { await fs.writeFile(tmpPath, data, options); await fs.rename(tmpPath, filePath); }
    catch (err) { try { await fs.unlink(tmpPath); } catch (_) {} throw err; }
}

// =============================================================================
// Constants
// =============================================================================

var KIRO_THINKING = {
    MIN_BUDGET_TOKENS: 1024, MAX_BUDGET_TOKENS: 24576, DEFAULT_BUDGET_TOKENS: 20000,
    START_TAG: '',
    MODE_TAG: '<thinking_mode>', MAX_LEN_TAG: '<max_thinking_length>', EFFORT_TAG: '<thinking_effort>',
};

var KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
    DEFAULT_MODEL_NAME: 'claude-sonnet-4-5',
    AXIOS_TIMEOUT: 120000, TOKEN_REFRESH_TIMEOUT: 15000,
    KIRO_VERSION: '0.11.63',
    CONTENT_TYPE_JSON: 'application/json', ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL', ORIGIN_AI_EDITOR: 'AI_EDITOR',
    TOTAL_CONTEXT_TOKENS: 200000,
};

var KIRO_MAX_TOOL_NAME_LENGTH = 64;

// Dynamic model data from configs/models.json
export var KIRO_FREE_MODELS = getFreeModels().map(function(m) { return m.id; });
export var KIRO_PAID_MODELS = getPaidModels().map(function(m) { return m.id; });
export var KIRO_ALL_MODELS = getAllModelIds();
export var KIRO_FREE_MODELS_FULL = getFreeModels();
export var KIRO_PAID_MODELS_FULL = getPaidModels();

var MODEL_MAPPING = getModelMapping();
var MODEL_CONTEXT_TOKENS = getContextTokenMap();

var KIRO_AUTH_TOKEN_FILE = 'kiro-auth-token.json';

// =============================================================================
// Helpers — Network
// =============================================================================

function isRetryableNetworkError(error) {
    var code = error && error.code;
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].indexOf(code) !== -1;
}

// =============================================================================
// Helpers — Tool names
// =============================================================================

function shortenKiroToolName(name) {
    var raw = String(name || '');
    if (raw.length <= KIRO_MAX_TOOL_NAME_LENGTH) return raw;
    var hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
    var prefixLen = KIRO_MAX_TOOL_NAME_LENGTH - hash.length - 1;
    return raw.slice(0, prefixLen) + '_' + hash;
}

function buildKiroToolNameMaps(tools) {
    var aliasToOriginal = new Map();
    var originalToAlias = new Map();
    if (Array.isArray(tools)) {
        for (var i = 0; i < tools.length; i++) {
            var orig = tools[i] && tools[i].name;
            if (!orig) continue;
            var alias = shortenKiroToolName(orig);
            originalToAlias.set(orig, alias);
            if (alias !== orig) aliasToOriginal.set(alias, orig);
        }
    }
    return {
        aliasToOriginal: aliasToOriginal,
        toKiroName: function(n) { return originalToAlias.get(n) || shortenKiroToolName(n); },
        fromKiroName: function(n) { return aliasToOriginal.get(n) || n; },
    };
}

function restoreKiroToolCallNames(toolCalls, maps) {
    if (!toolCalls || !maps || !maps.fromKiroName) return toolCalls;
    return toolCalls.map(function(tc) {
        return {
            id: tc.id, type: tc.type,
            function: { name: maps.fromKiroName(tc.function && tc.function.name), arguments: tc.function && tc.function.arguments },
        };
    });
}

function normalizeKiroToolInput(input) {
    if (input === undefined || input === null) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'object') { try { return JSON.stringify(input); } catch (e) { return String(input); } }
    return String(input);
}

// =============================================================================
// Helpers — Thinking tags
// =============================================================================

function isQuoteCharAt(text, i) {
    if (i < 0 || i >= text.length) return false;
    return '"\'`'.indexOf(text[i]) !== -1;
}

function findRealTag(text, tag, start) {
    var s = Math.max(0, start || 0);
    while (true) {
        var pos = text.indexOf(tag, s);
        if (pos === -1) return -1;
        if (!isQuoteCharAt(text, pos - 1) && !isQuoteCharAt(text, pos + tag.length)) return pos;
        s = pos + 1;
    }
}

function isWhitespaceOnly(t) { return !t || String(t).trim().length === 0; }

function findRealThinkingEndTag(buf, start) {
    var s = Math.max(0, start || 0);
    while (true) {
        var pos = findRealTag(buf, KIRO_THINKING.END_TAG, s);
        if (pos === -1) return -1;
        if (buf.slice(pos + KIRO_THINKING.END_TAG.length).startsWith('\n\n')) return pos;
        s = pos + 1;
    }
}

function findRealThinkingEndTagAtBufferEnd(buf, start) {
    var s = Math.max(0, start || 0);
    while (true) {
        var pos = findRealTag(buf, KIRO_THINKING.END_TAG, s);
        if (pos === -1) return -1;
        if (isWhitespaceOnly(buf.slice(pos + KIRO_THINKING.END_TAG.length))) return pos;
        s = pos + 1;
    }
}

// =============================================================================
// Helpers — JSON / bracket parsing
// =============================================================================

function findMatchingBracket(text, startPos, open, close) {
    open = open || '['; close = close || ']';
    if (!text || startPos >= text.length || text[startPos] !== open) return -1;
    var count = 1, inStr = false, esc = false;
    for (var i = startPos + 1; i < text.length; i++) {
        var ch = text[i];
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
    var r = str;
    r = r.replace(/,\s*([}\]])/g, '$1');
    r = r.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    r = r.replace(/:\s*([a-zA-Z0-9_]+)(?=[,}\]])/g, ':"$1"');
    return r;
}

function extractCredentialsFromCorruptedJson(content) {
    var extracted = {};
    var patterns = {
        refreshToken: /"refreshToken"\s*:\s*"([^"]+)"/,
        accessToken: /"accessToken"\s*:\s*"([^"]+)"/,
        clientId: /"clientId"\s*:\s*"([^"]+)"/,
        clientSecret: /"clientSecret"\s*:\s*"([^"]+)"/,
        profileArn: /"profileArn"\s*:\s*"([^"]+)"/,
        region: /"region"\s*:\s*"([^"]+)"/,
        authMethod: /"authMethod"\s*:\s*"([^"]+)"/,
        expiresAt: /"expiresAt"\s*:\s*"([^"]+)"/,
    };
    var keys = Object.keys(patterns);
    for (var i = 0; i < keys.length; i++) {
        var m = content.match(patterns[keys[i]]);
        if (m && m[1]) extracted[keys[i]] = m[1];
    }
    return (extracted.refreshToken || extracted.accessToken) ? extracted : null;
}

function parseSingleToolCall(text) {
    var nameMatch = text.match(/\[Called\s+(\w+)\s+with\s+args:/i);
    if (!nameMatch) return null;
    var funcName = nameMatch[1].trim();
    var argsStart = text.toLowerCase().indexOf('with args:');
    if (argsStart === -1) return null;
    var start = argsStart + 'with args:'.length;
    var end = text.lastIndexOf(']');
    if (end <= start) return null;
    var candidate = text.substring(start, end).trim();
    try {
        var obj = JSON.parse(repairJson(candidate));
        if (typeof obj !== 'object' || obj === null) return null;
        return { id: 'call_' + uuidv4().replace(/-/g, '').substring(0, 8), type: 'function', function: { name: funcName, arguments: JSON.stringify(obj) } };
    } catch (e) { return null; }
}

function parseBracketToolCalls(text) {
    if (!text || text.indexOf('[Called') === -1) return null;
    var calls = [];
    var positions = [];
    var s = 0;
    while (true) {
        var p = text.indexOf('[Called', s);
        if (p === -1) break;
        positions.push(p);
        s = p + 1;
    }
    for (var i = 0; i < positions.length; i++) {
        var startPos = positions[i];
        var limit = (i + 1 < positions.length) ? positions[i + 1] : text.length;
        var seg = text.substring(startPos, limit);
        var bEnd = findMatchingBracket(seg, 0);
        var toolText = null;
        if (bEnd !== -1) { toolText = seg.substring(0, bEnd + 1); }
        else { var lb = seg.lastIndexOf(']'); if (lb !== -1) toolText = seg.substring(0, lb + 1); }
        if (!toolText) continue;
        var parsed = parseSingleToolCall(toolText);
        if (parsed) calls.push(parsed);
    }
    return calls.length > 0 ? calls : null;
}

function deduplicateToolCalls(toolCalls) {
    var seen = new Set();
    return toolCalls.filter(function(tc) {
        var key = tc.function.name + '-' + tc.function.arguments;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// =============================================================================
// Helpers — System
// =============================================================================

function generateMachineId(credentials) {
    var key = (credentials && credentials.profileArn) || (credentials && credentials.clientId) || 'KIRO_DEFAULT';
    return crypto.createHash('sha256').update(key).digest('hex');
}

function getSystemRuntimeInfo() {
    var p = os.platform();
    var r = os.release();
    var nv = process.version.replace('v', '');
    var osName = p === 'win32' ? 'windows#' + r : p === 'darwin' ? 'macos#' + r : p + '#' + r;
    return { osName: osName, nodeVersion: nv };
}

function getContextTokensForModel(model) {
    return MODEL_CONTEXT_TOKENS[model] || KIRO_CONSTANTS.TOTAL_CONTEXT_TOKENS;
}

// =============================================================================
// Throttle queue
// =============================================================================

var throttleQueue = Promise.resolve();
var lastRequestStartedAt = 0;

async function acquireRequestSlot(minIntervalMs) {
    if (!minIntervalMs || minIntervalMs <= 0) return function() {};
    var releaseFn;
    var prev = throttleQueue.catch(function() {});
    throttleQueue = prev.then(function() { return new Promise(function(r) { releaseFn = r; }); });
    await prev;
    var wait = Math.max(0, minIntervalMs - (Date.now() - lastRequestStartedAt));
    if (wait > 0) await new Promise(function(r) { setTimeout(r, wait); });
    lastRequestStartedAt = Date.now();
    var released = false;
    return function() { if (!released) { released = true; releaseFn(); } };
}

// =============================================================================
// KiroApiService
// =============================================================================

export class KiroApiService {
    constructor(config) {
        config = config || {};
        this.isInitialized = false;
        this.config = config;
        this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), '.aws', 'sso', 'cache');
        this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH || null;

        if (config.KIRO_OAUTH_CREDS_BASE64) {
            try {
                this.base64Creds = JSON.parse(Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8'));
            } catch (e) {
                logger.error('[Kiro] Failed to parse Base64 creds: ' + e.message);
            }
        }

        this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
        this.axiosInstance = null;
        this.axiosSocialRefreshInstance = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        await this.loadCredentials();

        var machineId = generateMachineId({ profileArn: this.profileArn, clientId: this.clientId });
        var ver = KIRO_CONSTANTS.KIRO_VERSION;
        var info = getSystemRuntimeInfo();

        this.axiosInstance = axios.create({
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'amz-sdk-invocation-id': uuidv4(),
                'amz-sdk-request': 'attempt=1; max=3',
                'x-amzn-codewhisperer-optout': true,
                'x-amzn-kiro-agent-mode': 'vibe',
                'x-amz-user-agent': 'aws-sdk-js/1.0.34 KiroIDE-' + ver + '-' + machineId,
                'user-agent': 'aws-sdk-js/1.0.34 ua/2.1 os/' + info.osName + ' lang/js md/nodejs#' + info.nodeVersion + ' api/codewhispererstreaming#1.0.34 m/E KiroIDE-' + ver + '-' + machineId,
                'Connection': 'close',
            },
        });

        this.axiosSocialRefreshInstance = axios.create({
            timeout: KIRO_CONSTANTS.TOKEN_REFRESH_TIMEOUT,
            headers: { 'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON },
        });

        this.isInitialized = true;
        logger.info('[Kiro] Service initialized (region: ' + this.region + ', auth: ' + this.authMethod + ')');
    }

    async loadCredentials() {
        var tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
        var self = this;

        var loadFile = async function(fp) {
            try {
                var raw = await fs.readFile(fp, 'utf8');
                try { return JSON.parse(raw); } catch (e) {
                    try { return JSON.parse(repairJson(raw)); } catch (e2) {
                        return extractCredentialsFromCorruptedJson(raw);
                    }
                }
            } catch (e) {
                if (e.code !== 'ENOENT') logger.warn('[Kiro Auth] Read error ' + fp + ': ' + e.message);
                return null;
            }
        };

        var merged = {};
        if (this.base64Creds) { Object.assign(merged, this.base64Creds); this.base64Creds = null; }
        var fileCreds = await loadFile(tokenFilePath);
        if (fileCreds) Object.assign(merged, fileCreds);

        try {
            var dir = path.dirname(tokenFilePath);
            var fname = path.basename(tokenFilePath);
            var files = await fs.readdir(dir);
            for (var i = 0; i < files.length; i++) {
                if (files[i].endsWith('.json') && files[i] !== fname) {
                    var c = await loadFile(path.join(dir, files[i]));
                    if (c) { c.expiresAt = merged.expiresAt; Object.assign(merged, c); }
                }
            }
        } catch (e) {}

        var fields = ['accessToken', 'refreshToken', 'clientId', 'clientSecret', 'authMethod', 'expiresAt', 'profileArn', 'region', 'idcRegion'];
        for (var i = 0; i < fields.length; i++) {
            if (merged[fields[i]] != null) self[fields[i]] = merged[fields[i]];
        }

        if (!this.region) this.region = 'us-east-1';
        if (!this.idcRegion) this.idcRegion = this.region;

        this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', this.region);
        this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', this.idcRegion);
        this.baseUrl = KIRO_CONSTANTS.BASE_URL.replace('{{region}}', this.region);
    }

    async initializeAuth(forceRefresh) {
        if (this.accessToken && !forceRefresh) return;
        await this.loadCredentials();
        if ((forceRefresh || !this.accessToken) && this.refreshToken) {
            var tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
            await this._doTokenRefresh(tokenFilePath);
        }
        if (!this.accessToken) throw new Error('No access token available after initialization');
    }

    async _doTokenRefresh(tokenFilePath) {
        var isSocial = this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL || (!this.authMethod && !(this.clientId && this.clientSecret));
        var body = { refreshToken: this.refreshToken };
        var url = this.refreshUrl;

        if (!isSocial) {
            url = this.refreshIDCUrl;
            body.clientId = this.clientId;
            body.clientSecret = this.clientSecret;
            body.grantType = 'refresh_token';
        }

        try {
            var instance = isSocial ? this.axiosSocialRefreshInstance : this.axiosInstance;
            var response = await (instance || axios).post(url, body, { timeout: KIRO_CONSTANTS.TOKEN_REFRESH_TIMEOUT });

            if (response.data && response.data.accessToken) {
                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken || this.refreshToken;
                this.profileArn = response.data.profileArn || this.profileArn;
                var expiresIn = Number(response.data.expiresIn) || 3600;
                this.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

                var saveData = { accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt };
                if (this.profileArn) saveData.profileArn = this.profileArn;
                await this._saveCredentials(tokenFilePath, saveData);
                logger.info('[Kiro Auth] Token refreshed successfully');
            } else {
                throw new Error('Missing accessToken in refresh response');
            }
        } catch (error) {
            logger.error('[Kiro Auth] Token refresh failed: ' + error.message);
            throw error;
        }
    }

    async _saveCredentials(filePath, newData) {
        var existing = {};
        try {
            var raw = await fs.readFile(filePath, 'utf8');
            try { existing = JSON.parse(raw); } catch (e) {
                try { existing = JSON.parse(repairJson(raw)); } catch (e2) {
                    existing = extractCredentialsFromCorruptedJson(raw) || {};
                }
            }
        } catch (e) {}
        await atomicWriteFile(filePath, JSON.stringify(Object.assign({}, existing, newData), null, 2), { encoding: 'utf8', mode: 0o600 });
    }

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
        var s = {};
        var keys = Object.keys(input);
        for (var i = 0; i < keys.length; i++) { if (keys[i] !== '') s[keys[i]] = input[keys[i]]; }
        return s;
    }

    isTokenExpired() {
        try {
            if (!this.expiresAt) return true;
            return new Date(this.expiresAt).getTime() <= Date.now() + 30000;
        } catch (e) { return true; }
    }

    isExpiryDateNear(minutesThreshold) {
        minutesThreshold = minutesThreshold || 30;
        try {
            var exp = new Date(this.expiresAt).getTime();
            return exp <= Date.now() + minutesThreshold * 60 * 1000;
        } catch (e) { return false; }
    }

    _normalizeThinkingBudget(budget) {
        var v = Number(budget);
        if (!Number.isFinite(v) || v <= 0) v = KIRO_THINKING.DEFAULT_BUDGET_TOKENS;
        v = Math.floor(v);
        if (v < KIRO_THINKING.MIN_BUDGET_TOKENS) v = KIRO_THINKING.MIN_BUDGET_TOKENS;
        return Math.min(v, KIRO_THINKING.MAX_BUDGET_TOKENS);
    }

    _generateThinkingPrefix(thinking) {
        if (!thinking || typeof thinking !== 'object') return null;
        var type = String(thinking.type || '').toLowerCase().trim();
        if (type === 'enabled') {
            var budget = this._normalizeThinkingBudget(thinking.budget_tokens);
            return '<thinking_mode>enabled</thinking_mode><max_thinking_length>' + budget + '</max_thinking_length>';
        }
        if (type === 'adaptive') {
            var e = String(thinking.effort || '').toLowerCase().trim();
            var effort = ['low', 'medium', 'high'].indexOf(e) !== -1 ? e : 'high';
            return '<thinking_mode>adaptive</thinking_mode><thinking_effort>' + effort + '</thinking_effort>';
        }
        return null;
    }

    _hasThinkingPrefix(text) {
        return text && (text.indexOf(KIRO_THINKING.MODE_TAG) !== -1 || text.indexOf(KIRO_THINKING.MAX_LEN_TAG) !== -1 || text.indexOf(KIRO_THINKING.EFFORT_TAG) !== -1);
    }

    _toClaudeContentBlocks(content) {
        var raw = content || '';
        if (!raw) return [];
        var startPos = findRealTag(raw, KIRO_THINKING.START_TAG);
        if (startPos === -1) return [{ type: 'text', text: raw }];
        var before = raw.slice(0, startPos);
        var rest = raw.slice(startPos + KIRO_THINKING.START_TAG.length);
        if (rest.startsWith('\r\n')) rest = rest.slice(2);
        else if (rest.startsWith('\n')) rest = rest.slice(1);
        var endPos = findRealThinkingEndTag(rest);
        if (endPos === -1) endPos = findRealThinkingEndTagAtBufferEnd(rest);
        var thinking = '', after = '';
        if (endPos === -1) { thinking = rest; } else { thinking = rest.slice(0, endPos); after = rest.slice(endPos + KIRO_THINKING.END_TAG.length); }
        if (after.startsWith('\n\n')) after = after.slice(2);
        if (isWhitespaceOnly(after)) after = '';
        var blocks = [];
        if (before && !isWhitespaceOnly(before)) blocks.push({ type: 'text', text: before });
        blocks.push({ type: 'thinking', thinking: thinking });
        if (after && !isWhitespaceOnly(after)) blocks.push({ type: 'text', text: after });
        return blocks;
    }

    async buildCodewhispererRequest(messages, model, tools, inSystemPrompt, thinking) {
        var conversationId = uuidv4();
        var systemPrompt = this.getContentText(inSystemPrompt) || '';
        var thinkingPrefix = this._generateThinkingPrefix(thinking);
        if (thinkingPrefix && !this._hasThinkingPrefix(systemPrompt)) {
            systemPrompt = systemPrompt ? thinkingPrefix + '\n' + systemPrompt : thinkingPrefix;
        }

        var processed = messages.map(function(m) { return { role: m.role, content: Array.isArray(m.content) ? m.content.slice() : m.content }; });

        if (processed.length > 0) {
            var last = processed[processed.length - 1];
            if (last.role === 'assistant' && last.content && last.content[0] && last.content[0].type === 'text' && last.content[0].text === '{') {
                processed.pop();
            }
        }

        var merged = [];
        for (var mi = 0; mi < processed.length; mi++) {
            var msg = processed[mi];
            if (merged.length === 0) { merged.push(msg); continue; }
            var prev = merged[merged.length - 1];
            if (msg.role === prev.role) {
                if (Array.isArray(prev.content) && Array.isArray(msg.content)) prev.content = prev.content.concat(msg.content);
                else if (typeof prev.content === 'string' && typeof msg.content === 'string') prev.content += '\n' + msg.content;
                else if (Array.isArray(prev.content) && typeof msg.content === 'string') prev.content.push({ type: 'text', text: msg.content });
                else if (typeof prev.content === 'string' && Array.isArray(msg.content)) prev.content = [{ type: 'text', text: prev.content }].concat(msg.content);
            } else { merged.push(msg); }
        }

        var codewhispererModel = MODEL_MAPPING[model] || model;
        var toolNameMaps = buildKiroToolNameMaps(tools);
        var self = this;

        var toolsContext = {};
        if (tools && Array.isArray(tools) && tools.length > 0) {
            var filtered = tools.filter(function(t) { var n = (t.name || '').toLowerCase(); return n !== 'web_search' && n !== 'websearch'; });
            var MAX_DESC = 9216;
            var kiroTools = filtered.filter(function(t) { return t.description && t.description.trim(); }).map(function(t) {
                var desc = t.description || '';
                if (desc.length > MAX_DESC) desc = desc.substring(0, MAX_DESC) + '...';
                return { toolSpecification: { name: toolNameMaps.toKiroName(t.name), description: desc, inputSchema: { json: t.input_schema || {} } } };
            });
            toolsContext = kiroTools.length > 0 ? { tools: kiroTools } : { tools: [self._placeholderTool()] };
        } else {
            toolsContext = { tools: [self._placeholderTool()] };
        }

        var history = [];
        var startIndex = 0;
        var prependSystem = false;

        if (systemPrompt) {
            if (merged[0] && merged[0].role === 'user' && merged.length === 1) {
                prependSystem = true;
            } else if (merged[0] && merged[0].role === 'user') {
                history.push({ userInputMessage: { content: systemPrompt + '\n\n' + self.getContentText(merged[0]), modelId: codewhispererModel, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } });
                startIndex = 1;
            } else {
                history.push({ userInputMessage: { content: systemPrompt, modelId: codewhispererModel, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } });
            }
        }

        var keepImageThreshold = 5;
        for (var i = startIndex; i < merged.length - 1; i++) {
            var m = merged[i];
            var distFromEnd = (merged.length - 1) - i;
            var keepImages = distFromEnd <= keepImageThreshold;

            if (m.role === 'user') {
                var uim = { content: '', modelId: codewhispererModel, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR };
                var toolResults = [], images = [], imageCount = 0;
                if (Array.isArray(m.content)) {
                    for (var pi = 0; pi < m.content.length; pi++) {
                        var p = m.content[pi];
                        if (p.type === 'text') uim.content += p.text;
                        else if (p.type === 'tool_result') toolResults.push({ content: [{ text: self.getContentText(p.content) }], status: 'success', toolUseId: p.tool_use_id });
                        else if (p.type === 'image') {
                            if (keepImages) images.push({ format: p.source.media_type.split('/')[1], source: { bytes: p.source.data } });
                            else imageCount++;
                        }
                    }
                } else { uim.content = self.getContentText(m); }
                if (images.length > 0) uim.images = images;
                if (imageCount > 0) uim.content += '\n[' + imageCount + ' image(s) omitted]';
                if (toolResults.length > 0) {
                    var unique = [], seen = new Set();
                    for (var ti = 0; ti < toolResults.length; ti++) { if (!seen.has(toolResults[ti].toolUseId)) { seen.add(toolResults[ti].toolUseId); unique.push(toolResults[ti]); } }
                    uim.userInputMessageContext = { toolResults: unique };
                }
                history.push({ userInputMessage: uim });
            } else if (m.role === 'assistant') {
                var arm = { content: '' };
                var toolUses = [], thinkingText = '';
                if (Array.isArray(m.content)) {
                    for (var ai = 0; ai < m.content.length; ai++) {
                        var ap = m.content[ai];
                        if (ap.type === 'text') arm.content += ap.text;
                        else if (ap.type === 'thinking') thinkingText += (ap.thinking || ap.text || '');
                        else if (ap.type === 'tool_use') toolUses.push({ input: self._sanitizeToolInput(ap.input), name: toolNameMaps.toKiroName(ap.name), toolUseId: ap.id });
                    }
                } else { arm.content = self.getContentText(m); }
                if (thinkingText) arm.content = arm.content ? KIRO_THINKING.START_TAG + thinkingText + KIRO_THINKING.END_TAG + '\n\n' + arm.content : KIRO_THINKING.START_TAG + thinkingText + KIRO_THINKING.END_TAG;
                if (toolUses.length > 0) arm.toolUses = toolUses;
                history.push({ assistantResponseMessage: arm });
            }
        }

        var current = merged[merged.length - 1];
        var currentContent = '', currentToolResults = [], currentImages = [];

        if (current.role === 'assistant') {
            var arm2 = { content: '' };
            var thinkText2 = '', toolUses2 = [];
            if (Array.isArray(current.content)) {
                for (var ci = 0; ci < current.content.length; ci++) {
                    var cp = current.content[ci];
                    if (cp.type === 'text') arm2.content += cp.text;
                    else if (cp.type === 'thinking') thinkText2 += (cp.thinking || cp.text || '');
                    else if (cp.type === 'tool_use') toolUses2.push({ input: self._sanitizeToolInput(cp.input), name: toolNameMaps.toKiroName(cp.name), toolUseId: cp.id });
                }
            } else { arm2.content = self.getContentText(current); }
            if (thinkText2) arm2.content = arm2.content ? KIRO_THINKING.START_TAG + thinkText2 + KIRO_THINKING.END_TAG + '\n\n' + arm2.content : KIRO_THINKING.START_TAG + thinkText2 + KIRO_THINKING.END_TAG;
            if (toolUses2.length > 0) arm2.toolUses = toolUses2;
            history.push({ assistantResponseMessage: arm2 });
            currentContent = 'Continue';
        } else {
            if (history.length > 0 && !history[history.length - 1].assistantResponseMessage) {
                history.push({ assistantResponseMessage: { content: 'Continue' } });
            }
            if (Array.isArray(current.content)) {
                for (var ui = 0; ui < current.content.length; ui++) {
                    var up = current.content[ui];
                    if (up.type === 'text') currentContent += up.text;
                    else if (up.type === 'tool_result') currentToolResults.push({ content: [{ text: self.getContentText(up.content) }], status: 'success', toolUseId: up.tool_use_id });
                    else if (up.type === 'image') currentImages.push({ format: up.source.media_type.split('/')[1], source: { bytes: up.source.data } });
                }
            } else { currentContent = self.getContentText(current); }
            if (!currentContent) currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
            if (prependSystem) currentContent = currentContent ? systemPrompt + '\n\n' + currentContent : systemPrompt;
        }

        var uimFinal = { content: currentContent, modelId: codewhispererModel, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR };
        if (currentImages.length > 0) uimFinal.images = currentImages;
        var ctx = {};
        if (currentToolResults.length > 0) {
            var uniq = [], seenIds = new Set();
            for (var ri = 0; ri < currentToolResults.length; ri++) { if (!seenIds.has(currentToolResults[ri].toolUseId)) { seenIds.add(currentToolResults[ri].toolUseId); uniq.push(currentToolResults[ri]); } }
            ctx.toolResults = uniq;
        }
        if (toolsContext.tools) ctx.tools = toolsContext.tools;
        if (Object.keys(ctx).length > 0) uimFinal.userInputMessageContext = ctx;

        var request = { conversationState: { agentTaskType: 'vibe', chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL, conversationId: conversationId, currentMessage: { userInputMessage: uimFinal } } };
        if (history.length > 0) request.conversationState.history = history;
        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) request.profileArn = this.profileArn;
        Object.defineProperty(request, '_kiroToolNameMaps', { value: toolNameMaps, enumerable: false });
        return request;
    }

    _placeholderTool() {
        return { toolSpecification: { name: 'no_tool_available', description: 'Placeholder.', inputSchema: { json: { type: 'object', properties: {} } } } };
    }

    async callApi(model, body) {
        if (!this.isInitialized) await this.initialize();
        var messages = body.messages || (body.contents && body.contents.map(function(c) { return { role: c.role || 'user', content: (c.parts && c.parts.map(function(p) { return p.text; }).join('')) || '' }; }));
        if (!messages || !messages.length) throw new Error('No messages in request body');
        var requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking);
        var toolNameMaps = requestData._kiroToolNameMaps;
        var release = await acquireRequestSlot(this.config.KIRO_REQUEST_MIN_INTERVAL_MS);
        try {
            var response = await this.axiosInstance.post(this.baseUrl, requestData, {
                headers: { 'Authorization': 'Bearer ' + this.accessToken, 'amz-sdk-invocation-id': uuidv4() },
            });
            response._kiroToolNameMaps = toolNameMaps;
            return response;
        } catch (error) { this._throwTypedError(error); }
        finally { release(); }
    }

    _throwTypedError(error) {
        var status = error.response && error.response.status;
        if (status === 401 || status === 403) throw new KiroApiError('Auth error (' + status + ')', { statusCode: status, errorType: 'auth', shouldSwitch: true });
        if (status === 402) throw new KiroApiError('Quota exceeded', { statusCode: 402, errorType: 'quota', shouldSwitch: true });
        if (status === 429) throw new KiroApiError('Rate limited', { statusCode: 429, errorType: 'rate_limit', shouldSwitch: true });
        if (status >= 500) throw new KiroApiError('Server error (' + status + ')', { statusCode: status, errorType: 'server', shouldSwitch: true });
        if (isRetryableNetworkError(error)) throw new KiroApiError('Network error: ' + error.code, { statusCode: null, errorType: 'network', shouldSwitch: false });
        throw error;
    }

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();
        var finalModel = MODEL_MAPPING[model] ? model : model;
        var inputTokens = this.estimateInputTokens(requestBody);
        var response = await this.callApi(finalModel, requestBody);
        var result = this._processApiResponse(response);
        var thinkingRequested = ['enabled', 'adaptive'].indexOf(String(requestBody && requestBody.thinking && requestBody.thinking.type || '').toLowerCase()) !== -1;
        var content = thinkingRequested ? this._toClaudeContentBlocks(result.responseText) : result.responseText;
        return this.buildClaudeResponse(content, false, 'assistant', model, result.toolCalls, inputTokens);
    }

    _processApiResponse(response) {
        var toolNameMaps = response && response._kiroToolNameMaps;
        var raw = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);
        var parsed = this.parseEventStreamChunk(raw, toolNameMaps);
        var text = parsed.content;
        var allCalls = parsed.toolCalls.slice();
        var rawBracket = parseBracketToolCalls(raw);
        if (rawBracket) allCalls = allCalls.concat(restoreKiroToolCallNames(rawBracket, toolNameMaps));
        var unique = deduplicateToolCalls(allCalls);
        if (unique.length > 0) {
            for (var i = 0; i < unique.length; i++) {
                var escaped = unique[i].function.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                text = text.replace(new RegExp('\\[Called\\s+' + escaped + '\\s+with\\s+args:\\s*{[^}]*(?:{[^}]*}[^}]*)*}\\]', 'gs'), '');
            }
            text = text.trim();
        }
        text = text.replace(/(?<!\\)\\n/g, '\n');
        return { responseText: text, toolCalls: unique };
    }

    parseEventStreamChunk(rawData, toolNameMaps) {
        var rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        var fullContent = '';
        var toolCalls = [];
        var currentTool = null;
        var sseRegex = /:message-typeevent({[^]*?(?=:event-type|$))/g;
        var legacyRegex = /event({.*?(?=event{|$))/gs;
        var matches = Array.from(rawStr.matchAll(sseRegex));
        if (matches.length === 0) matches = Array.from(rawStr.matchAll(legacyRegex));

        for (var mi = 0; mi < matches.length; mi++) {
            var block = matches[mi][1];
            if (!block || !block.trim()) continue;
            var pos = 0;
            while ((pos = block.indexOf('}', pos + 1)) !== -1) {
                try {
                    var evt = JSON.parse(block.substring(0, pos + 1).trim());
                    if (evt.name && evt.toolUseId) {
                        if (!currentTool) currentTool = { id: evt.toolUseId, type: 'function', function: { name: toolNameMaps && toolNameMaps.fromKiroName ? toolNameMaps.fromKiroName(evt.name) : evt.name, arguments: '' } };
                        if (evt.input) currentTool.function.arguments += normalizeKiroToolInput(evt.input);
                        if (evt.stop) { try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)); } catch (e) {} toolCalls.push(currentTool); currentTool = null; }
                    } else if (!evt.followupPrompt && evt.content) { fullContent += evt.content; }
                    break;
                } catch (e) { continue; }
            }
        }
        if (currentTool) toolCalls.push(currentTool);
        var bracket = parseBracketToolCalls(fullContent);
        if (bracket) {
            toolCalls = toolCalls.concat(bracket);
            for (var bi = 0; bi < bracket.length; bi++) {
                var esc = bracket[bi].function.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                fullContent = fullContent.replace(new RegExp('\\[Called\\s+' + esc + '\\s+with\\s+args:\\s*{[^}]*(?:{[^}]*}[^}]*)*}\\]', 'gs'), '');
            }
            fullContent = fullContent.trim();
        }
        return { content: fullContent || '', toolCalls: restoreKiroToolCallNames(deduplicateToolCalls(toolCalls), toolNameMaps) };
    }

    parseAwsEventStreamBuffer(buffer) {
        var events = [];
        var remaining = buffer;
        var searchStart = 0;
        while (true) {
            var jsonStart = remaining.indexOf('{', searchStart);
            if (jsonStart < 0) break;
            var braceCount = 0, jsonEnd = -1, inStr = false, esc = false;
            for (var i = jsonStart; i < remaining.length; i++) {
                var ch = remaining[i];
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
                var parsed = JSON.parse(remaining.substring(jsonStart, jsonEnd + 1));
                if (parsed.content !== undefined && !parsed.followupPrompt) events.push({ type: 'content', data: parsed.content });
                else if (parsed.name && parsed.toolUseId) events.push({ type: 'toolUse', data: { name: parsed.name, toolUseId: parsed.toolUseId, input: normalizeKiroToolInput(parsed.input), stop: parsed.stop || false } });
                else if (parsed.input !== undefined && !parsed.name) events.push({ type: 'toolUseInput', data: { toolUseId: parsed.toolUseId, input: normalizeKiroToolInput(parsed.input) } });
                else if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) events.push({ type: 'toolUseStop', data: { stop: parsed.stop } });
                else if (parsed.contextUsagePercentage !== undefined) events.push({ type: 'contextUsage', data: { contextUsagePercentage: parsed.contextUsagePercentage } });
            } catch (e) { searchStart = jsonStart + 1; continue; }
            searchStart = jsonEnd + 1;
            if (searchStart >= remaining.length) { remaining = ''; break; }
        }
        if (searchStart > 0 && remaining.length > 0) remaining = remaining.substring(searchStart);
        return { events: events, remaining: remaining };
    }

    async * streamApiReal(model, body, retryCount) {
        retryCount = retryCount || 0;
        if (!this.isInitialized) await this.initialize();
        var maxRetries = 3;
        var messages = body.messages || (body.contents && body.contents.map(function(c) { return { role: c.role || 'user', content: (c.parts && c.parts.map(function(p) { return p.text; }).join('')) || '' }; }));
        if (!messages || !messages.length) throw new Error('No messages in request body');
        var requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking);
        var toolNameMaps = requestData._kiroToolNameMaps;
        var release = await acquireRequestSlot(this.config.KIRO_REQUEST_MIN_INTERVAL_MS);
        var stream = null;
        try {
            var response = await this.axiosInstance.post(this.baseUrl, requestData, {
                headers: { 'Authorization': 'Bearer ' + this.accessToken, 'amz-sdk-invocation-id': uuidv4() },
                responseType: 'stream',
            });
            stream = response.data;
            var buffer = '', lastContent = null;
            for await (var chunk of stream) {
                buffer += chunk.toString();
                var result = this.parseAwsEventStreamBuffer(buffer);
                buffer = result.remaining;
                for (var ei = 0; ei < result.events.length; ei++) {
                    var event = result.events[ei];
                    if (event.type === 'content' && event.data) {
                        if (lastContent === event.data) continue;
                        lastContent = event.data;
                        yield { type: 'content', content: event.data };
                    } else if (event.type === 'toolUse') {
                        yield { type: 'toolUse', toolUse: { name: toolNameMaps && toolNameMaps.fromKiroName ? toolNameMaps.fromKiroName(event.data.name) : event.data.name, toolUseId: event.data.toolUseId, input: event.data.input, stop: event.data.stop } };
                    } else if (event.type === 'toolUseInput') yield { type: 'toolUseInput', input: event.data.input };
                    else if (event.type === 'toolUseStop') yield { type: 'toolUseStop', stop: event.data.stop };
                    else if (event.type === 'contextUsage') yield { type: 'contextUsage', contextUsagePercentage: event.data.contextUsagePercentage };
                }
            }
        } catch (error) {
            if (stream && stream.destroy) stream.destroy();
            if (isRetryableNetworkError(error) && retryCount < maxRetries) {
                var delay = 1000 * Math.pow(2, retryCount);
                logger.info('[Kiro] Network error in stream, retry in ' + delay + 'ms (' + (retryCount + 1) + '/' + maxRetries + ')');
                await new Promise(function(r) { setTimeout(r, delay); });
                yield* this.streamApiReal(model, body, retryCount + 1);
                return;
            }
            this._throwTypedError(error);
        } finally {
            release();
            if (stream && stream.destroy) stream.destroy();
        }
    }

    async * generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();
        var finalModel = MODEL_MAPPING[model] ? model : model;
        var messageId = uuidv4();
        var thinkingRequested = ['enabled', 'adaptive'].indexOf(String(requestBody && requestBody.thinking && requestBody.thinking.type || '').toLowerCase()) !== -1;
        var self = this;

        var S = { thinkingRequested: thinkingRequested, buffer: '', pendingText: '', inThinking: false, thinkingExtracted: false, thinkingBlockIndex: null, textBlockIndex: null, nextBlockIndex: 0, stoppedBlocks: new Set(), stripThinkingLF: false, stripTextLF: false, hasVisibleText: false, hasThinkingContent: false };

        var ensureBlock = function(type) {
            var key = type === 'thinking' ? 'thinkingBlockIndex' : 'textBlockIndex';
            if (S[key] != null) return [];
            var idx = S.nextBlockIndex++;
            S[key] = idx;
            return [{ type: 'content_block_start', index: idx, content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } }];
        };
        var stopBlock = function(idx) {
            if (idx == null || S.stoppedBlocks.has(idx)) return [];
            S.stoppedBlocks.add(idx);
            return [{ type: 'content_block_stop', index: idx }];
        };
        var textDelta = function(t) {
            if (!t) return [];
            if (!isWhitespaceOnly(t)) S.hasVisibleText = true;
            return ensureBlock('text').concat([{ type: 'content_block_delta', index: S.textBlockIndex, delta: { type: 'text_delta', text: t.replace(/(?<!\\)\\n/g, '\n') } }]);
        };
        var thinkDelta = function(t) {
            if (t) S.hasThinkingContent = true;
            return ensureBlock('thinking').concat([{ type: 'content_block_delta', index: S.thinkingBlockIndex, delta: { type: 'thinking_delta', thinking: t.replace(/(?<!\\)\\n/g, '\n') } }]);
        };

        function* emit(evts) { for (var i = 0; i < evts.length; i++) yield evts[i]; }

        var totalContent = '', contextPct = null, inputTokens = 0;
        var estimatedInput = self.estimateInputTokens(requestBody);
        var toolCalls = [];
        var currentTool = null;
        var toolBlockIndexes = new Map();

        yield { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: model, usage: { input_tokens: estimatedInput, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } };

        for await (var event of self.streamApiReal(finalModel, requestBody)) {
            if (event.type === 'contextUsage') { contextPct = event.contextUsagePercentage; continue; }

            if (event.type === 'content' && event.content) {
                totalContent += event.content;
                if (!thinkingRequested) {
                    S.buffer += event.content;
                    if (S.buffer.endsWith('\\')) continue;
                    yield* emit(textDelta(S.buffer)); S.buffer = ''; continue;
                }
                S.buffer += event.content;
                var evts = [];
                while (S.buffer.length > 0) {
                    if (!S.inThinking && !S.thinkingExtracted) {
                        var sp = findRealTag(S.buffer, KIRO_THINKING.START_TAG);
                        if (sp !== -1) {
                            var before = S.pendingText + S.buffer.slice(0, sp);
                            if (before && !isWhitespaceOnly(before)) evts = evts.concat(textDelta(before));
                            S.pendingText = ''; S.buffer = S.buffer.slice(sp + KIRO_THINKING.START_TAG.length);
                            S.inThinking = true; S.stripThinkingLF = true; continue;
                        }
                        var safe = Math.max(0, S.buffer.length - KIRO_THINKING.START_TAG.length);
                        if (safe > 0) {
                            var t = S.buffer.slice(0, safe);
                            if (isWhitespaceOnly(t)) { S.pendingText += t.slice(0, 1024 - S.pendingText.length); }
                            else { evts = evts.concat(textDelta(S.pendingText + t)); S.pendingText = ''; }
                            S.buffer = S.buffer.slice(safe);
                        }
                        break;
                    }
                    if (S.inThinking) {
                        if (S.stripThinkingLF) {
                            if (S.buffer.startsWith('\r\n')) S.buffer = S.buffer.slice(2);
                            else if (S.buffer.startsWith('\n')) S.buffer = S.buffer.slice(1);
                            if (S.buffer.length > 0) S.stripThinkingLF = false; else { S.stripThinkingLF = false; break; }
                        }
                        var ep = findRealThinkingEndTag(S.buffer);
                        if (ep === -1) ep = findRealThinkingEndTagAtBufferEnd(S.buffer);
                        if (ep !== -1) {
                            if (S.buffer.slice(0, ep)) evts = evts.concat(thinkDelta(S.buffer.slice(0, ep)));
                            S.buffer = S.buffer.slice(ep + KIRO_THINKING.END_TAG.length);
                            S.inThinking = false; S.thinkingExtracted = true;
                            evts = evts.concat(thinkDelta('')).concat(stopBlock(S.thinkingBlockIndex));
                            S.stripTextLF = true; continue;
                        }
                        var safe2 = Math.max(0, S.buffer.length - KIRO_THINKING.END_TAG.length);
                        if (safe2 > 0) { evts = evts.concat(thinkDelta(S.buffer.slice(0, safe2))); S.buffer = S.buffer.slice(safe2); }
                        break;
                    }
                    if (S.thinkingExtracted) {
                        var rest = S.buffer; S.buffer = '';
                        if (S.stripTextLF) { if (rest.startsWith('\r\n\r\n')) rest = rest.slice(4); else if (rest.startsWith('\n\n')) rest = rest.slice(2); S.stripTextLF = false; }
                        if (rest) evts = evts.concat(textDelta(rest));
                        break;
                    }
                }
                yield* emit(evts); continue;
            }

            if (event.type === 'toolUse') {
                var tc = event.toolUse;
                totalContent += (tc.name || '') + (tc.input || '');
                var tevts = [];
                if (tc.name && tc.toolUseId) {
                    tevts = tevts.concat(stopBlock(S.textBlockIndex));
                    if (currentTool && currentTool.toolUseId !== tc.toolUseId) {
                        var inp = currentTool.input; try { inp = JSON.parse(inp); } catch (e) {}
                        toolCalls.push({ toolUseId: currentTool.toolUseId, name: currentTool.name, input: inp });
                        var bi = toolBlockIndexes.get(currentTool.toolUseId);
                        if (bi != null) tevts.push({ type: 'content_block_stop', index: bi });
                    }
                    if (!currentTool || currentTool.toolUseId !== tc.toolUseId) {
                        var nbi = S.nextBlockIndex++;
                        toolBlockIndexes.set(tc.toolUseId, nbi);
                        tevts.push({ type: 'content_block_start', index: nbi, content_block: { type: 'tool_use', id: tc.toolUseId, name: tc.name, input: {} } });
                        currentTool = { toolUseId: tc.toolUseId, name: tc.name, input: '' };
                    }
                    currentTool.input += tc.input || '';
                    if (tc.input) { var tbi = toolBlockIndexes.get(tc.toolUseId); if (tbi != null) tevts.push({ type: 'content_block_delta', index: tbi, delta: { type: 'input_json_delta', partial_json: tc.input } }); }
                    if (tc.stop) {
                        var inp2 = currentTool.input; try { inp2 = JSON.parse(inp2); } catch (e) {}
                        toolCalls.push({ toolUseId: currentTool.toolUseId, name: currentTool.name, input: inp2 });
                        var sbi = toolBlockIndexes.get(currentTool.toolUseId); if (sbi != null) tevts.push({ type: 'content_block_stop', index: sbi });
                        currentTool = null;
                    }
                }
                yield* emit(tevts);
            } else if (event.type === 'toolUseInput') {
                var delta = normalizeKiroToolInput(event.input);
                totalContent += delta;
                if (currentTool) { currentTool.input += delta; var dbi = toolBlockIndexes.get(currentTool.toolUseId); if (dbi != null && delta) yield { type: 'content_block_delta', index: dbi, delta: { type: 'input_json_delta', partial_json: delta } }; }
            } else if (event.type === 'toolUseStop' && currentTool && event.stop) {
                var inp3 = currentTool.input; try { inp3 = JSON.parse(inp3); } catch (e) {}
                toolCalls.push({ toolUseId: currentTool.toolUseId, name: currentTool.name, input: inp3 });
                var ebi = toolBlockIndexes.get(currentTool.toolUseId); if (ebi != null) yield { type: 'content_block_stop', index: ebi };
                currentTool = null;
            }
        }

        if (currentTool) {
            var inp4 = currentTool.input; try { inp4 = JSON.parse(inp4); } catch (e) {}
            toolCalls.push({ toolUseId: currentTool.toolUseId, name: currentTool.name, input: inp4 });
            var fbi = toolBlockIndexes.get(currentTool.toolUseId); if (fbi != null) yield { type: 'content_block_stop', index: fbi };
        }

        if (thinkingRequested && (S.inThinking || S.buffer || S.pendingText)) {
            if (S.inThinking) {
                if (S.stripThinkingLF) { if (S.buffer.startsWith('\r\n')) S.buffer = S.buffer.slice(2); else if (S.buffer.startsWith('\n')) S.buffer = S.buffer.slice(1); }
                yield* emit(thinkDelta(S.buffer)); S.buffer = '';
                yield* emit(thinkDelta('')); yield* emit(stopBlock(S.thinkingBlockIndex));
            } else if (!S.thinkingExtracted) {
                var rem = S.pendingText + S.buffer; S.pendingText = ''; S.buffer = '';
                if (rem) yield* emit(textDelta(rem));
            } else {
                var rem2 = S.buffer; S.buffer = '';
                if (S.stripTextLF) { if (rem2.startsWith('\n\n')) rem2 = rem2.slice(2); S.stripTextLF = false; }
                if (rem2) yield* emit(textDelta(rem2));
            }
        } else if (!thinkingRequested && S.buffer) {
            yield* emit(textDelta(S.buffer)); S.buffer = '';
        }

        var onlyThinking = thinkingRequested && S.hasThinkingContent && !S.hasVisibleText && toolCalls.length === 0;
        if (onlyThinking) yield* emit(textDelta(' '));
        yield* emit(stopBlock(S.textBlockIndex));

        var outputTokens = self.countTextTokens(totalContent);
        for (var oi = 0; oi < toolCalls.length; oi++) outputTokens += self.countTextTokens(JSON.stringify(toolCalls[oi].input || {}));
        if (contextPct != null && contextPct > 0) {
            var ctxTokens = getContextTokensForModel(model);
            inputTokens = Math.max(0, Math.round(ctxTokens * contextPct / 100) - outputTokens);
        } else { inputTokens = estimatedInput; }

        yield { type: 'message_delta', delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : (onlyThinking ? 'max_tokens' : 'end_turn') }, usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
        yield { type: 'message_stop' };
    }

    buildClaudeResponse(content, isStream, role, model, toolCalls, inputTokens) {
        inputTokens = inputTokens || 0;
        var self = this;
        if (isStream) {
            var events = [];
            events.push({ type: 'message_start', message: { id: uuidv4(), type: 'message', role: role, model: model, usage: { input_tokens: inputTokens, output_tokens: 0 }, content: [] } });
            var outputTokens = 0;
            var stopReason = 'end_turn';
            if (toolCalls && toolCalls.length) {
                for (var i = 0; i < toolCalls.length; i++) {
                    var tc = toolCalls[i];
                    var inp; try { inp = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch (e) { inp = { raw: tc.function.arguments }; }
                    events.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
                    events.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(inp) } });
                    events.push({ type: 'content_block_stop', index: i });
                    outputTokens += self.countTextTokens(JSON.stringify(inp));
                }
                stopReason = 'tool_use';
            }
            if (content) {
                var idx = (toolCalls && toolCalls.length) || 0;
                events.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
                events.push({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: content } });
                events.push({ type: 'content_block_stop', index: idx });
                outputTokens += self.countTextTokens(content);
                if (!toolCalls || !toolCalls.length) stopReason = 'end_turn';
            }
            events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
            events.push({ type: 'message_stop' });
            return events;
        }

        var contentArray = [];
        var outputTokens2 = 0, hasText = false, hasThinking = false;
        if (Array.isArray(content)) {
            for (var ci = 0; ci < content.length; ci++) {
                var b = content[ci];
                if (b && b.type === 'text') { contentArray.push(b); outputTokens2 += self.countTextTokens(b.text); if (!isWhitespaceOnly(b.text)) hasText = true; }
                else if (b && b.type === 'thinking') { contentArray.push(b); outputTokens2 += self.countTextTokens(b.thinking); if (b.thinking) hasThinking = true; }
            }
        } else if (content) {
            contentArray.push({ type: 'text', text: content }); outputTokens2 += self.countTextTokens(content); hasText = true;
        }
        var stopReason2 = 'end_turn';
        if (toolCalls && toolCalls.length) {
            for (var ti = 0; ti < toolCalls.length; ti++) {
                var tc2 = toolCalls[ti];
                var inp2; try { inp2 = typeof tc2.function.arguments === 'string' ? JSON.parse(tc2.function.arguments) : tc2.function.arguments; } catch (e) { inp2 = { raw: tc2.function.arguments }; }
                contentArray.push({ type: 'tool_use', id: tc2.id, name: tc2.function.name, input: inp2 });
                outputTokens2 += self.countTextTokens(tc2.function.arguments);
            }
            stopReason2 = 'tool_use';
        }
        if (hasThinking && !hasText && (!toolCalls || !toolCalls.length)) {
            contentArray.push({ type: 'text', text: ' ' }); stopReason2 = 'max_tokens';
        }
        return { id: uuidv4(), type: 'message', role: role, model: model, stop_reason: stopReason2, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: outputTokens2 }, content: contentArray };
    }

    async listModels() {
        return { models: KIRO_ALL_MODELS.map(function(id) { return { name: id }; }) };
    }

    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        var url = this.baseUrl.replace('generateAssistantResponse', 'getUsageLimits');
        var params = new URLSearchParams({ isEmailRequired: 'true', origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR, resourceType: 'AGENTIC_REQUEST' });
        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) params.append('profileArn', this.profileArn);
        try {
            var resp = await this.axiosInstance.get(url + '?' + params, { headers: { 'Authorization': 'Bearer ' + this.accessToken, 'amz-sdk-invocation-id': uuidv4() } });
            return resp.data;
        } catch (error) { this._throwTypedError(error); }
    }
}
