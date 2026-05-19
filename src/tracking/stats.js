import { promises as fs } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

var baseDir = process.env.DATA_DIR || process.cwd();
var STATS_FILE = path.join(baseDir, 'data', 'stats.json');
var SAVE_INTERVAL_MS = 60000;

var stats = {
    totalRequestsAllTime: 0,
    totalErrorsAllTime: 0,
    uniqueUsersAllTime: new Set(),
    currentOnlineUsers: new Map(),
    startedAt: new Date().toISOString(),
};

var ONLINE_TIMEOUT_MS = 5 * 60 * 1000;

export function recordRequest(userIdentifier) {
    stats.totalRequestsAllTime++;
    if (userIdentifier) {
        stats.uniqueUsersAllTime.add(userIdentifier);
        stats.currentOnlineUsers.set(userIdentifier, Date.now());
    }
}

export function recordError() {
    stats.totalErrorsAllTime++;
}

export function getOnlineCount() {
    var now = Date.now();
    var online = 0;
    var keys = Array.from(stats.currentOnlineUsers.keys());
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (now - stats.currentOnlineUsers.get(k) > ONLINE_TIMEOUT_MS) {
            stats.currentOnlineUsers.delete(k);
        } else {
            online++;
        }
    }
    return online;
}

export function getStats() {
    return {
        totalRequestsAllTime: stats.totalRequestsAllTime,
        totalErrorsAllTime: stats.totalErrorsAllTime,
        uniqueUsersAllTime: stats.uniqueUsersAllTime.size,
        currentOnlineUsers: getOnlineCount(),
        startedAt: stats.startedAt,
        uptimeSeconds: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
    };
}

export async function loadStats() {
    try {
        var raw = await fs.readFile(STATS_FILE, 'utf8');
        var saved = JSON.parse(raw);
        stats.totalRequestsAllTime = saved.totalRequestsAllTime || 0;
        stats.totalErrorsAllTime = saved.totalErrorsAllTime || 0;
        if (Array.isArray(saved.uniqueUsersAllTime)) {
            for (var i = 0; i < saved.uniqueUsersAllTime.length; i++) {
                stats.uniqueUsersAllTime.add(saved.uniqueUsersAllTime[i]);
            }
        }
        logger.info('[Stats] Loaded from ' + STATS_FILE + ': ' + stats.totalRequestsAllTime + ' requests');
    } catch (e) {
        if (e.code !== 'ENOENT') logger.warn('[Stats] Could not load stats: ' + e.message);
    }
}

export async function saveStats() {
    try {
        var dir = path.dirname(STATS_FILE);
        await fs.mkdir(dir, { recursive: true });
        var payload = {
            totalRequestsAllTime: stats.totalRequestsAllTime,
            totalErrorsAllTime: stats.totalErrorsAllTime,
            uniqueUsersAllTime: Array.from(stats.uniqueUsersAllTime),
            savedAt: new Date().toISOString(),
        };
        await fs.writeFile(STATS_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        logger.warn('[Stats] Could not save stats: ' + e.message);
    }
}

setInterval(function() { saveStats().catch(function(){}); }, SAVE_INTERVAL_MS);
process.on('SIGINT', async function() { await saveStats(); process.exit(0); });
process.on('SIGTERM', async function() { await saveStats(); process.exit(0); });
