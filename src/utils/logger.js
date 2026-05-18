const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function ts() {
    return new Date().toISOString();
}

function fmt(level, args) {
    const parts = args.map(a =>
        typeof a === 'string' ? a : (a instanceof Error ? a.stack || a.message : JSON.stringify(a))
    );
    return `[${ts()}] [${level.toUpperCase()}] ${parts.join(' ')}`;
}

const logger = {
    debug(...args) { if (CURRENT_LEVEL <= LEVELS.debug) console.log(fmt('debug', args)); },
    info(...args)  { if (CURRENT_LEVEL <= LEVELS.info)  console.log(fmt('info', args)); },
    warn(...args)  { if (CURRENT_LEVEL <= LEVELS.warn)  console.warn(fmt('warn', args)); },
    error(...args) { if (CURRENT_LEVEL <= LEVELS.error) console.error(fmt('error', args)); },
};

export default logger;
