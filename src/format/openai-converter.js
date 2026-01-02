/**
 * OpenAI API Format Converter
 * Converts between OpenAI Chat Completions API and Anthropic Messages API formats
 */

/**
 * Convert OpenAI Chat Completions request to Anthropic Messages API format
 * 
 * @param {Object} openaiRequest - OpenAI format request
 * @returns {Object} Anthropic format request
 */
export function convertOpenAIToAnthropic(openaiRequest) {
    const {
        model,
        messages,
        temperature,
        max_tokens,
        top_p,
        stop,
        tools,
        tool_choice,
        stream
    } = openaiRequest;

    // Extract system message (OpenAI allows system role in messages array)
    let system = null;
    const anthropicMessages = [];

    for (const msg of messages || []) {
        if (msg.role === 'system') {
            // Combine multiple system messages
            if (system) {
                system += '\n\n' + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
            } else {
                system = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            }
        } else if (msg.role === 'user' || msg.role === 'assistant') {
            // Convert OpenAI message to Anthropic format
            let content = [];

            // 1. Handle text content (and scrub polluted history)
            if (msg.content) {
                if (typeof msg.content === 'string') {
                    // SCRUBBER: Remove "Textify" logs and legacy log formats from history
                    // This prevents the model from seeing past mistakes and mimicking them.
                    let scrubbed = msg.content
                        .replace(/>>> PAST_TOOL_ACTION:[\s\S]*?<<</g, '')
                        .replace(/>>> PAST_TOOL_RESULT:[\s\S]*?<<</g, '')
                        .replace(/>>> PAST_TOOL_USAGE:[\s\S]*?<<</g, '')
                        .replace(/\[LOG: [\s\S]*?\]/g, '') // Legacy format
                        .replace(/\[Tool Use: [\s\S]*?\]/g, '') // Legacy format
                        .replace(/\[SYSTEM: [\s\S]*?\]/g, ''); // Legacy format

                    if (scrubbed.trim()) {
                        content.push({ type: 'text', text: scrubbed });
                    }
                } else if (Array.isArray(msg.content)) {
                    // Handle multimodal content
                    msg.content.forEach(block => {
                        if (block.type === 'text') {
                            let scrubbed = block.text
                                .replace(/>>> PAST_TOOL_ACTION:[\s\S]*?<<</g, '')
                                .replace(/>>> PAST_TOOL_RESULT:[\s\S]*?<<</g, '')
                                .replace(/>>> PAST_TOOL_USAGE:[\s\S]*?<<</g, '')
                                .replace(/\[LOG: [\s\S]*?\]/g, '')
                                .replace(/\[Tool Use: [\s\S]*?\]/g, '')
                                .replace(/\[SYSTEM: [\s\S]*?\]/g, '');

                            if (scrubbed.trim()) {
                                content.push({ type: 'text', text: scrubbed });
                            }
                        } else if (block.type === 'image_url') {
                            content.push({
                                type: 'image',
                                source: {
                                    type: 'url',
                                    url: block.image_url.url
                                }
                            });
                        }
                    });
                }
            }

            // 2. Handle tool_calls (for assistant) -> tool_use
            if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
                msg.tool_calls.forEach(call => {
                    if (call.type === 'function') {
                        let input = {};
                        try {
                            input = JSON.parse(call.function.arguments || '{}');
                        } catch (e) {
                            console.warn('Failed to parse tool arguments:', call.function.arguments);
                        }

                        content.push({
                            type: 'tool_use',
                            id: call.id,
                            name: call.function.name,
                            input: input
                        });
                    }
                });
            }

            anthropicMessages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: content
            });

        } else if (msg.role === 'tool') {
            // Convert OpenAI tool response to Anthropic tool_result
            // Anthropic expects tool results in 'user' blocks

            // Check if deeper user message merging is needed? 
            // For now, simply append as a user message with tool_result block.
            // Note: Anthropic allows multiple tool_results in one user block, but separate blocks are safer for simple conversion.

            anthropicMessages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                }]
            });
        }
    }

    // Convert tools from OpenAI format to Anthropic format
    let anthropicTools = null;
    if (tools && tools.length > 0) {
        anthropicTools = tools.map(tool => {
            const func = tool.function || tool;
            return {
                name: func.name,
                description: func.description || '',
                input_schema: func.parameters || {
                    type: 'object',
                    properties: {},
                    required: []
                }
            };
        });
    }

    // Convert tool_choice
    let anthropicToolChoice = null;
    if (tool_choice) {
        if (tool_choice === 'none' || tool_choice === 'auto') {
            anthropicToolChoice = tool_choice;
        } else if (tool_choice.type === 'function') {
            anthropicToolChoice = {
                type: 'tool',
                name: tool_choice.function?.name
            };
        }
    }

    return {
        model: model || 'claude-sonnet-4-5-thinking',
        messages: anthropicMessages,
        system: system,
        max_tokens: max_tokens || 4096,
        temperature: temperature,
        top_p: top_p,
        stop_sequences: stop ? (Array.isArray(stop) ? stop : [stop]) : undefined,
        tools: anthropicTools,
        tool_choice: anthropicToolChoice,
        stream: stream
    };
}

/**
 * Convert Anthropic Messages API response to OpenAI Chat Completions format
 * 
 * @param {Object} anthropicResponse - Anthropic format response
 * @param {string} model - Model name
 * @param {boolean} stream - Whether this is a streaming response
 * @returns {Object} OpenAI format response
 */
export function convertAnthropicToOpenAI(anthropicResponse, model, stream = false) {
    if (stream) {
        // Streaming responses are handled separately
        return anthropicResponse;
    }

    const content = anthropicResponse.content || [];
    let textContent = '';
    const toolCalls = [];

    // Extract text and tool calls from content blocks
    for (const block of content) {
        if (block.type === 'text') {
            textContent += block.text;
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                }
            });
        }
        // Skip thinking blocks in OpenAI format
    }

    const response = {
        id: anthropicResponse.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: textContent || null,
                ...(toolCalls.length > 0 && { tool_calls: toolCalls })
            },
            finish_reason: mapStopReason(anthropicResponse.stop_reason)
        }],
        usage: anthropicResponse.usage ? {
            prompt_tokens: anthropicResponse.usage.input_tokens || 0,
            completion_tokens: anthropicResponse.usage.output_tokens || 0,
            total_tokens: (anthropicResponse.usage.input_tokens || 0) + (anthropicResponse.usage.output_tokens || 0)
        } : undefined
    };

    return response;
}

/**
 * Map Anthropic stop_reason to OpenAI finish_reason
 */
function mapStopReason(stopReason) {
    if (!stopReason) return 'stop';

    const mapping = {
        'end_turn': 'stop',
        'max_tokens': 'length',
        'stop_sequence': 'stop',
        'tool_use': 'tool_calls'
    };

    return mapping[stopReason] || 'stop';
}

// State tracking for tool calls during streaming
const toolCallState = new Map();

/**
 * Convert Anthropic streaming events to OpenAI streaming format
 * @param {Object} event - Anthropic SSE event
 * @param {string} model - Model name
 * @param {string} messageId - Message ID (passed from outside)
 * @returns {Object|null} OpenAI format event or null if should be skipped
 */
export function convertAnthropicStreamToOpenAI(event, model, messageId = 'chatcmpl-stream') {
    // Handle different event types
    switch (event.type) {
        case 'message_start':
            // Clear tool call state for new message
            toolCallState.delete(messageId);
            return {
                id: event.message?.id || messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    delta: { role: 'assistant' },
                    finish_reason: null
                }]
            };

        case 'content_block_start':
            if (event.content_block?.type === 'text') {
                return {
                    id: messageId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                        index: 0,
                        delta: { content: '' },
                        finish_reason: null
                    }]
                };
            } else if (event.content_block?.type === 'tool_use') {
                // Initialize tool call state
                const toolCall = event.content_block;
                const toolCallIndex = toolCallState.has(messageId)
                    ? toolCallState.get(messageId).length
                    : 0;

                if (!toolCallState.has(messageId)) {
                    toolCallState.set(messageId, []);
                }

                const state = {
                    id: toolCall.id,
                    type: 'function',
                    function: {
                        name: toolCall.name || '',
                        arguments: ''
                    },
                    index: toolCallIndex
                };

                toolCallState.get(messageId).push(state);

                // Emit tool call start
                return {
                    id: messageId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: toolCallIndex,
                                id: toolCall.id,
                                type: 'function',
                                function: {
                                    name: toolCall.name || '',
                                    arguments: ''
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }
            // Skip thinking blocks in OpenAI format
            return null;

        case 'content_block_delta':
            if (event.delta?.type === 'text_delta') {
                return {
                    id: messageId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                        index: 0,
                        delta: { content: event.delta.text },
                        finish_reason: null
                    }]
                };
            } else if (event.delta?.type === 'input_json_delta') {
                // Update tool call arguments incrementally
                if (!toolCallState.has(messageId) || toolCallState.get(messageId).length === 0) {
                    return null;
                }

                const toolCalls = toolCallState.get(messageId);
                const currentToolCall = toolCalls[toolCalls.length - 1];

                if (currentToolCall && event.delta.partial_json) {
                    // Append partial JSON to arguments
                    currentToolCall.function.arguments = event.delta.partial_json;

                    return {
                        id: messageId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: currentToolCall.index,
                                    id: currentToolCall.id,
                                    type: 'function',
                                    function: {
                                        name: currentToolCall.function.name,
                                        arguments: event.delta.partial_json
                                    }
                                }]
                            },
                            finish_reason: null
                        }]
                    };
                }
            }
            // Skip thinking deltas and other non-text deltas
            return null;

        case 'content_block_stop':
            // OpenAI doesn't have explicit content block stop events
            // But we can use this to finalize tool calls if needed
            return null;

        case 'message_delta':
            // Clean up tool call state
            toolCallState.delete(messageId);

            return {
                id: messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: mapStopReason(event.delta?.stop_reason)
                }]
            };

        case 'message_stop':
            // Clean up tool call state
            toolCallState.delete(messageId);

            return {
                id: messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                }]
            };

        default:
            return null;
    }
}
