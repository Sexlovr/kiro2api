/**
 * Typed error class for Kiro API failures.
 * Gives the pool manager enough info to decide: retry? switch? cooldown?
 */
export class KiroApiError extends Error {
    /**
     * @param {string} message
     * @param {object} opts
     * @param {number|null} opts.statusCode   HTTP status or null for network errors
     * @param {'auth'|'rate_limit'|'quota'|'server'|'network'|'client'} opts.errorType
     * @param {boolean} opts.shouldSwitch     hint: pool should try another account
     */
    constructor(message, { statusCode = null, errorType = 'client', shouldSwitch = false } = {}) {
        super(message);
        this.name = 'KiroApiError';
        this.statusCode = statusCode;
        this.errorType = errorType;
        this.shouldSwitch = shouldSwitch;
    }
}
