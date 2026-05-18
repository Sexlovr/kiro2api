/**
 * Slim conversion layer — OpenAI ↔ Claude only.
 * No Gemini. No factory pattern. Just the functions.
 */

import { v4 as uuidv4 } from 'uuid';

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 1;
const DEFAULT_TOP_P = 0.95;

function fallback(value, def) {
    return (value !== undefined && value !== 0) ? value : def;
}

function safeParseJSON(str) {
    if (!str) return str;
    try { return JSON.parse(str); } catch { return str; }
}

// =============================================================================
// OpenAI → Claude
// =============================================================================

/**
 * Convert OpenAI /v1/chat/completions request → Claude /v1/messages request
 */
export function toClaudeRequestFromOpenAI(openaiRequest) {
    const messages = openaiRequest.messages || [];
    const systemMessages = [];
    const nonSystemMessages = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = extractText(msg.content);
            if (text) systemMessages.push(text);
        } else {
            nonSystemMessages.push(msg);
        }
    }

    const claudeMessages = [];

    for (const message of nonSystemMessages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        let content = [];

        // Tool response message
        if (message.role === 'tool') {
            content.push({
                type: 'tool_result',
                tool_use_id: message.tool_call_id,
                content: safeParseJSON(message.content),
            });
            claudeMessages.push({ role: 'user', content });
            continue;
        }

        // Assistant with tool_calls
        if (message.role === 'assistant' && message.tool_calls?.length) {
            const toolUseBlocks = message.tool_calls.map(tc => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: safeParseJSON(tc.function.arguments),
            }));
            claudeMessages.push({ role: 'assistant', content: toolUseBlocks });
            continue;
        }

        // Regular text / multimodal
        if (typeof message.content === 'string') {
            if (message.content) content.push({ type: 'text', text: message.content });
        } else if (Array.isArray(message.content)) {
            for (const item of message.content) {
                if (!item) continue;
                if (item.type === 'text' && item.text) {
                    content.push({ type: 'text', text: item.text });
                } else if (item.type === 'image_url' && item.image_url) {
                    const url = typeof item.image_url === 'string' ? item.image_url : item.image_url.url;
                    if (url?.startsWith('data:')) {
                        const [header, data] = url.split(',');
                        const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                        content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
                    } else {
                        content.push({ type: 'text', text: `[Image: ${url}]` });
                    }
                }
            }
        }

        if (content.length > 0) {
            claudeMessages.push({ role, content });
        }
    }

    const claudeRequest = {
        model: openaiRequest.model,
        messages: claudeMessages,
        max_tokens: fallback(openaiRequest.max_tokens || openaiRequest.max_completion_tokens, DEFAULT_MAX_TOKENS),
        temperature: fallback(openaiRequest.temperature, DEFAULT_TEMPERATURE),
        top_p: fallback(openaiRequest.top_p, DEFAULT_TOP_P),
        stream: openaiRequest.stream || false,
    };

    if (systemMessages.length > 0) {
        claudeRequest.system = systemMessages.join('\n');
    }

    // Tools
    if (openaiRequest.tools?.length) {
        claudeRequest.tools = openaiRequest.tools.map(t => ({
            name: t.function.name,
            description: t.function.description || '',
            input_schema: t.function.parameters || { type: 'object', properties: {} },
        }));
        claudeRequest.tool_choice = buildClaudeToolChoice(openaiRequest.tool_choice);
    }

    // Thinking / reasoning
    if (openaiRequest.reasoning_effort) {
        const effort = String(openaiRequest.reasoning_effort).toLowerCase();
        claudeRequest.thinking = { type: 'adaptive', effort };
    }

    return claudeRequest;
}

function buildClaudeToolChoice(tc) {
    if (typeof tc === 'string') {
        const map = { auto: 'auto', none: 'none', required: 'any' };
        return { type: map[tc] || 'auto' };
    }
    if (typeof tc === 'object' && tc?.function) {
        return { type: 'tool', name: tc.function.name };
    }
    return undefined;
}

// =============================================================================
// Claude → OpenAI (non-streaming response)
// =============================================================================

/**
 * Convert Claude /v1/messages response → OpenAI /v1/chat/completions response
 */
export function toOpenAIChatCompletionFromClaude(claudeResponse, model) {
    const id = `chatcmpl-${uuidv4()}`;

    if (!claudeResponse?.content?.length) {
        return {
            id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: claudeResponse?.usage?.input_tokens || 0, completion_tokens: claudeResponse?.usage?.output_tokens || 0, total_tokens: (claudeResponse?.usage?.input_tokens || 0) + (claudeResponse?.usage?.output_tokens || 0) },
        };
    }

    let textContent = '';
    let reasoningContent = '';
    const toolCalls = [];

    for (const block of claudeResponse.content) {
        if (block.type === 'text') textContent += block.text || '';
        else if (block.type === 'thinking') reasoningContent += block.thinking || '';
        else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
                },
            });
        }
    }

    const finishReason = claudeResponse.stop_reason === 'tool_use' ? 'tool_calls'
        : claudeResponse.stop_reason === 'max_tokens' ? 'length'
        : 'stop';

    const message = { role: 'assistant', content: textContent || null };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: {
            prompt_tokens: claudeResponse.usage?.input_tokens || 0,
            completion_tokens: claudeResponse.usage?.output_tokens || 0,
            total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
        },
    };
}

// =============================================================================
// Claude SSE stream → OpenAI SSE stream chunks
// =============================================================================

/**
 * Manages streaming state for converting Claude SSE events → OpenAI chunks.
 * One instance per request.
 */
export class ClaudeToOpenAIStreamAdapter {
    constructor(model) {
        this.model = model;
        this.id = `chatcmpl-${uuidv4()}`;
        this.currentToolCallIndex = -1;
        this.toolCallBuffer = {};  // id → { index, name, argsSoFar }
        this.hasStarted = false;
        this.inputTokens = 0;
        this.outputTokens = 0;
    }

    /**
     * Convert a single Claude SSE event object → array of OpenAI SSE chunk strings.
     * Returns array of "data: {json}\n\n" strings ready to write to the response.
     */
    convert(claudeEvent) {
        if (!claudeEvent) return [];
        const type = claudeEvent.type;

        switch (type) {
            case 'message_start': {
                this.inputTokens = claudeEvent.message?.usage?.input_tokens || 0;
                this.hasStarted = true;
                // OpenAI doesn't have an explicit "start" event in SSE — first delta serves as start
                return [];
            }

            case 'content_block_start': {
                const block = claudeEvent.content_block;
                if (block?.type === 'tool_use') {
                    this.currentToolCallIndex++;
                    const idx = this.currentToolCallIndex;
                    this.toolCallBuffer[block.id] = { index: idx, name: block.name, argsSoFar: '' };
                    return [this._chunk({
                        tool_calls: [{
                            index: idx,
                            id: block.id,
                            type: 'function',
                            function: { name: block.name, arguments: '' },
                        }]
                    })];
                }
                return [];
            }

            case 'content_block_delta': {
                const delta = claudeEvent.delta;
                if (!delta) return [];

                if (delta.type === 'text_delta' && delta.text) {
                    return [this._chunk({ content: delta.text })];
                }

                if (delta.type === 'thinking_delta' && delta.thinking) {
                    return [this._chunk({ reasoning_content: delta.thinking })];
                }

                if (delta.type === 'input_json_delta' && delta.partial_json) {
                    // Find which tool call this belongs to
                    const entries = Object.values(this.toolCallBuffer);
                    const current = entries[entries.length - 1];
                    if (current) {
                        current.argsSoFar += delta.partial_json;
                        return [this._chunk({
                            tool_calls: [{
                                index: current.index,
                                function: { arguments: delta.partial_json },
                            }]
                        })];
                    }
                }

                return [];
            }

            case 'content_block_stop':
                return [];

            case 'message_delta': {
                const stopReason = claudeEvent.delta?.stop_reason;
                this.outputTokens = claudeEvent.usage?.output_tokens || this.outputTokens;
                const finishReason = stopReason === 'tool_use' ? 'tool_calls'
                    : stopReason === 'max_tokens' ? 'length'
                    : 'stop';
                return [this._stopChunk(finishReason)];
            }

            case 'message_stop':
                return ['data: [DONE]\n\n'];

            default:
                return [];
        }
    }

    _chunk(delta) {
        const obj = {
            id: this.id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [{ index: 0, delta, finish_reason: null }],
        };
        return `data: ${JSON.stringify(obj)}\n\n`;
    }

    _stopChunk(finishReason) {
        const obj = {
            id: this.id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: {
                prompt_tokens: this.inputTokens,
                completion_tokens: this.outputTokens,
                total_tokens: this.inputTokens + this.outputTokens,
            },
        };
        return `data: ${JSON.stringify(obj)}\n\n`;
    }
}

// =============================================================================
// Helpers
// =============================================================================

function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.filter(p => p?.type === 'text' && p.text).map(p => p.text).join('\n');
    }
    return '';
}
