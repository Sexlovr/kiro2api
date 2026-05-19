import { readFileSync } from 'fs';
import path from 'path';
import logger from './utils/logger.js';

var MODELS_PATH = path.join(process.cwd(), 'configs', 'models.json');
var loaded = null;

function loadModels() {
    if (loaded) return loaded;
    try {
        var raw = readFileSync(MODELS_PATH, 'utf8');
        loaded = JSON.parse(raw);
        logger.info('[Models] Loaded ' + loaded.free.length + ' free, ' + loaded.paid.length + ' paid models');
    } catch (e) {
        logger.warn('[Models] Could not load configs/models.json (' + e.message + '), using defaults');
        loaded = {
            free: [{ id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context: '200K' }],
            paid: [{ id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context: '200K' }],
            model_mapping: { 'claude-sonnet-4-5': 'claude-sonnet-4.5' }
        };
    }
    return loaded;
}

export function reloadModels() {
    loaded = null;
    return loadModels();
}

export function getFreeModels() {
    return loadModels().free;
}

export function getPaidModels() {
    return loadModels().paid;
}

export function getAllModelIds() {
    var data = loadModels();
    var ids = new Set();
    data.free.forEach(function(m) { ids.add(m.id); });
    data.paid.forEach(function(m) { ids.add(m.id); });
    return Array.from(ids);
}

export function getModelMapping() {
    return loadModels().model_mapping || {};
}

function parseContext(ctx) {
    if (!ctx || ctx === 'Dynamic') return 200000;
    var str = String(ctx).toUpperCase().trim();
    if (str.endsWith('M')) return parseFloat(str) * 1000000;
    if (str.endsWith('K')) return parseFloat(str) * 1000;
    return parseInt(str, 10) || 200000;
}

export function getContextTokenMap() {
    var data = loadModels();
    var map = {};
    var all = data.free.concat(data.paid);
    for (var i = 0; i < all.length; i++) {
        map[all[i].id] = parseContext(all[i].context);
    }
    return map;
}
