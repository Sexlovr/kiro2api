/**
 * Lightweight token estimation utilities.
 * Uses ~4 chars per token heuristic (close enough for estimation).
 * No native tokenizer dependency — keeps the project lean.
 */

const CHARS_PER_TOKEN = 4;

export function countTextTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

export function estimateInputTokens(requestBody) {
    let total = 0;

    // System prompt
    if (requestBody?.system) {
        const sys = Array.isArray(requestBody.system)
            ? requestBody.system.map(s => typeof s === 'string' ? s : s?.text || '').join('\n')
            : String(requestBody.system);
        total += countTextTokens(sys);
    }

    // Messages
    if (Array.isArray(requestBody?.messages)) {
        for (const msg of requestBody.messages) {
            total += countTextTokens(getContentText(msg));
        }
    }

    // Tools
    if (Array.isArray(requestBody?.tools)) {
        total += countTextTokens(JSON.stringify(requestBody.tools));
    }

    return total;
}

export function countTokensAnthropic(requestBody) {
    return { input_tokens: estimateInputTokens(requestBody) };
}

export function processContent(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(block => {
            if (typeof block === 'string') return block;
            if (block?.type === 'text') return block.text || '';
            if (block?.type === 'thinking') return block.thinking || '';
            return '';
        }).join('');
    }
    return String(content);
}

export function getContentText(message) {
    if (!message) return '';
    const c = message.content;
    if (!c) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c.map(block => {
            if (typeof block === 'string') return block;
            if (block?.text) return block.text;
            if (block?.thinking) return block.thinking;
            if (block?.type === 'tool_result') {
                const inner = block.content;
                if (typeof inner === 'string') return inner;
                if (Array.isArray(inner)) return inner.map(i => i?.text || '').join('');
                return '';
            }
            return '';
        }).join('');
    }
    return String(c);
}
