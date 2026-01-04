/**
 * Response Converter
 * Converts Google Generative AI responses to Anthropic Messages API format
 */

import crypto from 'crypto';
import { MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';
import { cacheSignature } from './signature-cache.js';

/**
 * Generate a synthetic thinking block for Gemini models when tool_use
 * is returned without a thinking block. This prevents agent loops.
 * 
 * @param {string} toolName - Name of the tool being called
 * @returns {Object} Synthetic thinking block
 */
function createSyntheticThinkingBlock(toolName) {
    return {
        type: 'thinking',
        thinking: `Analyzing the request and determining that ${toolName} tool should be used.`,
        signature: 'gemini-synthetic-thinking-for-tool-use'
    };
}

/**
 * Convert Google Generative AI response to Anthropic Messages API format
 *
 * @param {Object} googleResponse - Google format response (the inner response object)
 * @param {string} model - The model name used
 * @returns {Object} Anthropic format response
 */
export function convertGoogleToAnthropic(googleResponse, model) {
    // Handle the response wrapper
    const response = googleResponse.response || googleResponse;
    const modelFamily = getModelFamily(model);
    const isGeminiModel = modelFamily === 'gemini';

    const candidates = response.candidates || [];
    const firstCandidate = candidates[0] || {};
    const content = firstCandidate.content || {};
    const parts = content.parts || [];

    // Convert parts to Anthropic content blocks
    const anthropicContent = [];
    let hasToolCalls = false;
    let hasThinkingBlock = false;

    for (const part of parts) {
        if (part.text !== undefined) {
            // Handle thinking blocks
            if (part.thought === true) {
                const signature = part.thoughtSignature || '';

                // For Gemini models: always include thinking blocks
                // Even if signature is empty/short, Cursor needs them to avoid loops
                // Gemini thinking blocks are critical for preventing agent model looping
                anthropicContent.push({
                    type: 'thinking',
                    thinking: part.text,
                    signature: signature || 'gemini-thinking-no-signature'
                });
                hasThinkingBlock = true;
            } else {
                anthropicContent.push({
                    type: 'text',
                    text: part.text
                });
            }
        } else if (part.functionCall) {
            // Convert functionCall to tool_use
            // Use the id from the response if available, otherwise generate one
            const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
            let args = part.functionCall.args || {};
            
            // CRITICAL FIX: Ensure args is always an object, not null/undefined/string
            // Some APIs might return args as string or null, which causes "invalid arguments" errors
            if (typeof args === 'string') {
                try {
                    args = JSON.parse(args);
                } catch (e) {
                    console.warn(`[ResponseConverter] Failed to parse args as JSON for "${part.functionCall.name}", using empty object: ${e.message}`);
                    args = {};
                }
            } else if (!args || typeof args !== 'object' || Array.isArray(args)) {
                // If args is null, undefined, or not an object, use empty object
                console.warn(`[ResponseConverter] Invalid args type (${typeof args}) for "${part.functionCall.name}", using empty object`);
                args = {};
            }
            
            // Remove any non-serializable values (functions, undefined, circular refs, etc.)
            try {
                // Test if args can be JSON serialized (catches circular refs, functions, etc.)
                JSON.stringify(args);
            } catch (e) {
                console.warn(`[ResponseConverter] Args for "${part.functionCall.name}" contains non-serializable values, using empty object: ${e.message}`);
                args = {};
            }
            
            // Deep clean: remove undefined values and functions (they cause API errors)
            const cleanArgs = (obj) => {
                if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
                    return obj;
                }
                const cleaned = {};
                for (const [key, value] of Object.entries(obj)) {
                    if (value === undefined || typeof value === 'function') {
                        continue; // Skip undefined and functions
                    }
                    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                        cleaned[key] = cleanArgs(value);
                    } else {
                        cleaned[key] = value;
                    }
                }
                return cleaned;
            };
            args = cleanArgs(args);
            
            const argsKeys = Object.keys(args);
            const argsPreview = argsKeys.length > 0
                ? argsKeys.map(k => `${k}=${JSON.stringify(args[k]).substring(0, 50)}`).join(', ')
                : '{}';

            console.log(`[ResponseConverter] Received tool call from API: name="${part.functionCall.name}", id="${toolId}", args_keys=[${argsKeys.join(', ')}], args_preview={${argsPreview}}`);

            const toolUseBlock = {
                type: 'tool_use',
                id: toolId,
                name: part.functionCall.name,
                input: args
            };

            // For Gemini 3+, include thoughtSignature from the part level
            if (part.thoughtSignature && part.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                toolUseBlock.thoughtSignature = part.thoughtSignature;
                // Cache for future requests (Claude Code may strip this field)
                cacheSignature(toolId, part.thoughtSignature);
                console.log(`[ResponseConverter] Cached signature for tool_use id: ${toolId}`);
            }

            anthropicContent.push(toolUseBlock);
            hasToolCalls = true;
        } else if (part.functionResponse) {
            // Log functionResponse for debugging
            console.log(`[ResponseConverter] Received functionResponse: name="${part.functionResponse.name}", id="${part.functionResponse.id || 'none'}"`);
        }
    }

    // GEMINI LOOP FIX: If Gemini returns tool_use without thinking block,
    // inject a synthetic thinking block at the beginning to prevent loops
    if (isGeminiModel && hasToolCalls && !hasThinkingBlock) {
        const firstToolUse = anthropicContent.find(block => block.type === 'tool_use');
        const toolName = firstToolUse?.name || 'tool';

        console.log(`[ResponseConverter] Gemini tool_use without thinking detected, injecting synthetic thinking block`);

        // Insert synthetic thinking block at the beginning
        anthropicContent.unshift(createSyntheticThinkingBlock(toolName));
    }

    // Determine stop reason
    const finishReason = firstCandidate.finishReason;
    let stopReason = 'end_turn';
    if (finishReason === 'STOP') {
        stopReason = 'end_turn';
    } else if (finishReason === 'MAX_TOKENS') {
        stopReason = 'max_tokens';
    } else if (finishReason === 'TOOL_USE' || hasToolCalls) {
        stopReason = 'tool_use';
    }

    // Extract usage metadata
    // Note: Antigravity's promptTokenCount is the TOTAL (includes cached),
    // but Anthropic's input_tokens excludes cached. We subtract to match.
    const usageMetadata = response.usageMetadata || {};
    const promptTokens = usageMetadata.promptTokenCount || 0;
    const cachedTokens = usageMetadata.cachedContentTokenCount || 0;

    // Log summary of converted content
    const toolUseBlocks = anthropicContent.filter(b => b.type === 'tool_use');
    const toolUseNames = toolUseBlocks.map(b => b.name);
    if (toolUseBlocks.length > 0) {
        console.log(`[ResponseConverter] Converted ${toolUseBlocks.length} tool_use blocks: [${toolUseNames.join(', ')}]`);
    }

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent.length > 0 ? anthropicContent : [{ type: 'text', text: '' }],
        model: model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: promptTokens - cachedTokens,
            output_tokens: usageMetadata.candidatesTokenCount || 0,
            cache_read_input_tokens: cachedTokens,
            cache_creation_input_tokens: 0
        }
    };
}
