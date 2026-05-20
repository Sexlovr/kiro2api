import { v4 as uuidv4 } from 'uuid';

var DEFAULT_MAX_TOKENS = 8192;
var DEFAULT_TEMPERATURE = 1;
var DEFAULT_TOP_P = 0.95;

// Regex to detect [think=...] anywhere in text
var THINK_TAG_REGEX = /\[think\s*=\s*(off|on|low|medium|high|max|\d+)\]/gi;

function fallback(value, def) {
    return (value !== undefined && value !== 0) ? value : def;
}

function safeParseJSON(str) {
    if (!str) return str;
    try { return JSON.parse(str); } catch (e) { return str; }
}

/**
 * Scan all messages for [think=...] tags.
 * Returns { messages (cleaned), thinking (config object or null) }
 */
function extractThinkingFromMessages(messages) {
    var lastThinkValue = null;

    // Scan all messages for the tag, take the last occurrence
    for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        var text = '';
        if (typeof msg.content === 'string') {
            text = msg.content;
        } else if (Array.isArray(msg.content)) {
            for (var j = 0; j < msg.content.length; j++) {
                if (msg.content[j] && msg.content[j].type === 'text' && msg.content[j].text) {
                    text += msg.content[j].text;
                }
            }
        }
        var matches = text.match(THINK_TAG_REGEX);
        if (matches && matches.length > 0) {
            // Extract value from last match
            var lastMatch = matches[matches.length - 1];
            var valMatch = lastMatch.match(/\[think\s*=\s*(off|on|low|medium|high|max|\d+)\]/i);
            if (valMatch) lastThinkValue = valMatch[1].toLowerCase();
        }
    }

    // Strip all [think=...] tags from all messages
    var cleaned = [];
    for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        var cleanedMsg = { role: msg.role };

        // Copy all other fields (tool_calls, tool_call_id, name, etc.)
        var keys = Object.keys(msg);
        for (var k = 0; k < keys.length; k++) {
            if (keys[k] !== 'role' && keys[k] !== 'content') {
                cleanedMsg[keys[k]] = msg[keys[k]];
            }
        }

        if (typeof msg.content === 'string') {
            cleanedMsg.content = msg.content.replace(THINK_TAG_REGEX, '').trim();
        } else if (Array.isArray(msg.content)) {
            cleanedMsg.content = [];
            for (var j = 0; j < msg.content.length; j++) {
                var part = msg.content[j];
                if (part && part.type === 'text' && part.text) {
                    var cleanedText = part.text.replace(THINK_TAG_REGEX, '').trim();
                    if (cleanedText) {
                        cleanedMsg.content.push({ type: 'text', text: cleanedText });
                    }
                } else {
                    cleanedMsg.content.push(part);
                }
            }
        } else {
            cleanedMsg.content = msg.content;
        }

        cleaned.push(cleanedMsg);
    }

    // Build thinking config from extracted value
    var thinking = null;
    if (lastThinkValue && lastThinkValue !== 'off') {
        if (lastThinkValue === 'on') {
            thinking = { type: 'enabled', budget_tokens: 20000 };
        } else if (lastThinkValue === 'low' || lastThinkValue === 'medium' || lastThinkValue === 'high') {
            thinking = { type: 'adaptive', effort: lastThinkValue };
        } else if (lastThinkValue === 'max') {
            thinking = { type: 'adaptive', effort: 'high' };
        } else {
            // Numeric value — use as budget_tokens
            var budget = parseInt(lastThinkValue, 10);
            if (!isNaN(budget) && budget > 0) {
                thinking = { type: 'enabled', budget_tokens: budget };
            }
        }
    }

    return { messages: cleaned, thinking: thinking };
}

// =============================================================================
// OpenAI → Claude
// =============================================================================

export function toClaudeRequestFromOpenAI(openaiRequest) {
    var messages = openaiRequest.messages || [];
    var systemMessages = [];
    var nonSystemMessages = [];

    for (var i = 0; i < messages.length; i++) {
        if (messages[i].role === 'system') {
            var text = extractText(messages[i].content);
            if (text) systemMessages.push(text);
        } else {
            nonSystemMessages.push(messages[i]);
        }
    }

    // Extract [think=...] tags from all messages (including system text)
    // We need to scan system messages too
    var allForScan = [];
    for (var i = 0; i < messages.length; i++) {
        allForScan.push(messages[i]);
    }
    var thinkResult = extractThinkingFromMessages(allForScan);
    var thinkingConfig = thinkResult.thinking;

    // Rebuild system messages without think tags
    systemMessages = [];
    nonSystemMessages = [];
    for (var i = 0; i < thinkResult.messages.length; i++) {
        var msg = thinkResult.messages[i];
        if (msg.role === 'system') {
            var text = extractText(msg.content);
            if (text) systemMessages.push(text);
        } else {
            nonSystemMessages.push(msg);
        }
    }

    var claudeMessages = [];

    for (var i = 0; i < nonSystemMessages.length; i++) {
        var message = nonSystemMessages[i];
        var role = message.role === 'assistant' ? 'assistant' : 'user';
        var content = [];

        if (message.role === 'tool') {
            content.push({
                type: 'tool_result',
                tool_use_id: message.tool_call_id,
                content: safeParseJSON(message.content),
            });
            claudeMessages.push({ role: 'user', content: content });
            continue;
        }

        if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length) {
            var toolUseBlocks = [];
            for (var t = 0; t < message.tool_calls.length; t++) {
                var tc = message.tool_calls[t];
                toolUseBlocks.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: safeParseJSON(tc.function.arguments),
                });
            }
            claudeMessages.push({ role: 'assistant', content: toolUseBlocks });
            continue;
        }

        if (typeof message.content === 'string') {
            if (message.content) content.push({ type: 'text', text: message.content });
        } else if (Array.isArray(message.content)) {
            for (var j = 0; j < message.content.length; j++) {
                var item = message.content[j];
                if (!item) continue;
                if (item.type === 'text' && item.text) {
                    content.push({ type: 'text', text: item.text });
                } else if (item.type === 'image_url' && item.image_url) {
                    var url = typeof item.image_url === 'string' ? item.image_url : item.image_url.url;
                    if (url && url.indexOf('data:') === 0) {
                        var parts = url.split(',');
                        var header = parts[0];
                        var data = parts[1];
                        var mediaMatch = header.match(/data:([^;]+)/);
                        var mediaType = mediaMatch ? mediaMatch[1] : 'image/jpeg';
                        content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data } });
                    } else {
                        content.push({ type: 'text', text: '[Image: ' + url + ']' });
                    }
                }
            }
        }

        if (content.length > 0) {
            claudeMessages.push({ role: role, content: content });
        }
    }

    var claudeRequest = {
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

    if (openaiRequest.tools && openaiRequest.tools.length) {
        claudeRequest.tools = [];
        for (var i = 0; i < openaiRequest.tools.length; i++) {
            var tool = openaiRequest.tools[i];
            claudeRequest.tools.push({
                name: tool.function.name,
                description: tool.function.description || '',
                input_schema: tool.function.parameters || { type: 'object', properties: {} },
            });
        }
        claudeRequest.tool_choice = buildClaudeToolChoice(openaiRequest.tool_choice);
    }

    // Apply thinking config: priority is [think=...] tag > request-level reasoning_effort > nothing
    if (thinkingConfig) {
        claudeRequest.thinking = thinkingConfig;
    } else if (openaiRequest.reasoning_effort) {
        var effort = String(openaiRequest.reasoning_effort).toLowerCase();
        claudeRequest.thinking = { type: 'adaptive', effort: effort };
    }

    return claudeRequest;
}

function buildClaudeToolChoice(tc) {
    if (typeof tc === 'string') {
        var map = { auto: 'auto', none: 'none', required: 'any' };
        return { type: map[tc] || 'auto' };
    }
    if (typeof tc === 'object' && tc && tc.function) {
        return { type: 'tool', name: tc.function.name };
    }
    return undefined;
}

// =============================================================================
// Claude → OpenAI (non-streaming response)
// =============================================================================

export function toOpenAIChatCompletionFromClaude(claudeResponse, model) {
    var id = 'chatcmpl-' + uuidv4();

    if (!claudeResponse || !claudeResponse.content || !claudeResponse.content.length) {
        return {
            id: id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model,
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: claudeResponse && claudeResponse.usage ? claudeResponse.usage.input_tokens || 0 : 0, completion_tokens: claudeResponse && claudeResponse.usage ? claudeResponse.usage.output_tokens || 0 : 0, total_tokens: 0 },
        };
    }

    var textContent = '';
    var reasoningContent = '';
    var toolCalls = [];

    for (var i = 0; i < claudeResponse.content.length; i++) {
        var block = claudeResponse.content[i];
        if (block.type === 'text') textContent += block.text || '';
        else if (block.type === 'thinking') reasoningContent += block.thinking || '';
        else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id, type: 'function',
                function: {
                    name: block.name,
                    arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
                },
            });
        }
    }

    var finishReason = claudeResponse.stop_reason === 'tool_use' ? 'tool_calls'
        : claudeResponse.stop_reason === 'max_tokens' ? 'length' : 'stop';

    var message = { role: 'assistant', content: textContent || null };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    var inputTokens = claudeResponse.usage ? claudeResponse.usage.input_tokens || 0 : 0;
    var outputTokens = claudeResponse.usage ? claudeResponse.usage.output_tokens || 0 : 0;

    return {
        id: id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model,
        choices: [{ index: 0, message: message, finish_reason: finishReason }],
        usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
}

// =============================================================================
// Claude SSE stream → OpenAI SSE stream chunks
// =============================================================================

export class ClaudeToOpenAIStreamAdapter {
    constructor(model) {
        this.model = model;
        this.id = 'chatcmpl-' + uuidv4();
        this.currentToolCallIndex = -1;
        this.toolCallBuffer = {};
        this.hasStarted = false;
        this.inputTokens = 0;
        this.outputTokens = 0;
    }

    convert(claudeEvent) {
        if (!claudeEvent) return [];
        var type = claudeEvent.type;

        if (type === 'message_start') {
            this.inputTokens = claudeEvent.message && claudeEvent.message.usage ? claudeEvent.message.usage.input_tokens || 0 : 0;
            this.hasStarted = true;
            return [];
        }

        if (type === 'content_block_start') {
            var block = claudeEvent.content_block;
            if (block && block.type === 'tool_use') {
                this.currentToolCallIndex++;
                var idx = this.currentToolCallIndex;
                this.toolCallBuffer[block.id] = { index: idx, name: block.name, argsSoFar: '' };
                return [this._chunk({
                    tool_calls: [{ index: idx, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }]
                })];
            }
            return [];
        }

        if (type === 'content_block_delta') {
            var delta = claudeEvent.delta;
            if (!delta) return [];
            if (delta.type === 'text_delta' && delta.text) {
                return [this._chunk({ content: delta.text })];
            }
            if (delta.type === 'thinking_delta' && delta.thinking) {
                return [this._chunk({ reasoning_content: delta.thinking })];
            }
            if (delta.type === 'input_json_delta' && delta.partial_json) {
                var entries = Object.values(this.toolCallBuffer);
                var current = entries.length > 0 ? entries[entries.length - 1] : null;
                if (current) {
                    current.argsSoFar += delta.partial_json;
                    return [this._chunk({
                        tool_calls: [{ index: current.index, function: { arguments: delta.partial_json } }]
                    })];
                }
            }
            return [];
        }

        if (type === 'content_block_stop') return [];

        if (type === 'message_delta') {
            var stopReason = claudeEvent.delta ? claudeEvent.delta.stop_reason : null;
            this.outputTokens = claudeEvent.usage ? claudeEvent.usage.output_tokens || this.outputTokens : this.outputTokens;
            var finishReason = stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop';
            return [this._stopChunk(finishReason)];
        }

        if (type === 'message_stop') {
            return ['data: [DONE]\n\n'];
        }

        return [];
    }

    _chunk(delta) {
        var obj = {
            id: this.id, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: this.model,
            choices: [{ index: 0, delta: delta, finish_reason: null }],
        };
        return 'data: ' + JSON.stringify(obj) + '\n\n';
    }

    _stopChunk(finishReason) {
        var obj = {
            id: this.id, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: this.model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: this.inputTokens, completion_tokens: this.outputTokens, total_tokens: this.inputTokens + this.outputTokens },
        };
        return 'data: ' + JSON.stringify(obj) + '\n\n';
    }
}

// =============================================================================
// Helpers
// =============================================================================

function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        var texts = [];
        for (var i = 0; i < content.length; i++) {
            if (content[i] && content[i].type === 'text' && content[i].text) texts.push(content[i].text);
        }
        return texts.join('\n');
    }
    return '';
}
