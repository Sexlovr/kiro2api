/**
 * Global stats tracker.
 * In-memory — persists to disk periodically so HuggingFace restarts don't lose everything.
 */

import { promises as fs } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const STATS_FILE = path.join(process.cwd(), 'data', 'stats.json');
const SAVE_INTERVAL_MS = 60_000; // flush to disk every 60s

const stats = {
    totalRequestsAllTime: 0,
    totalErrorsAllTime: 0,
    uniqueUsersAllTime: new Set(),
    currentOnlineUsers: new Map(),  // ip/key → last seen timestamp
    startedAt: new Date().toISOString(),
};

const ONLINE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min no activity → offline

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
    const now = Date.now();
    let online = 0;
    for (const [key, lastSeen] of stats.currentOnlineUsers.entries()) {
        if (now - lastSeen > ONLINE_TIMEOUT_MS) {
            stats.currentOnlineUsers.delete(key);
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
        const raw = await fs.readFile(STATS_FILE, 'utf8');
        const saved = JSON.parse(raw);
        stats.totalRequestsAllTime = saved.totalRequestsAllTime || 0;
        stats.totalErrorsAllTime = saved.totalErrorsAllTime || 0;
        if (Array.isArray(saved.uniqueUsersAllTime)) {
            for (const u of saved.uniqueUsersAllTime) stats.uniqueUsersAllTime.add(u);
        }
        logger.info(`[Stats] Loaded: ${stats.totalRequestsAllTime} requests, ${stats.uniqueUsersAllTime.size} unique users`);
    } catch (e) {
        if (e.code !== 'ENOENT') logger.warn('[Stats] Could not load stats:', e.message);
    }
}

export async function saveStats() {
    try {
        const dir = path.dirname(STATS_FILE);
        await fs.mkdir(dir, { recursive: true });
        const payload = {
            totalRequestsAllTime: stats.totalRequestsAllTime,
            totalErrorsAllTime: stats.totalErrorsAllTime,
            uniqueUsersAllTime: [...stats.uniqueUsersAllTime],
            savedAt: new Date().toISOString(),
        };
        await fs.writeFile(STATS_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        logger.warn('[Stats] Could not save stats:', e.message);
    }
}

// Periodic flush
setInterval(() => saveStats().catch(() => {}), SAVE_INTERVAL_MS);

// Save on shutdown
process.on('SIGINT', async () => { await saveStats(); process.exit(0); });
process.on('SIGTERM', async () => { await saveStats(); process.exit(0); });
