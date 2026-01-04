/**
 * Thinking Block Utilities
 * Handles thinking block processing, validation, and filtering
 */

import { MIN_SIGNATURE_LENGTH } from '../constants.js';

/**
 * Check if a part is a thinking block
 * @param {Object} part - Content part to check
 * @returns {boolean} True if the part is a thinking block
 */
export function isThinkingPart(part) {
    return part.type === 'thinking' ||
        part.type === 'redacted_thinking' ||
        part.thinking !== undefined ||
        part.thought === true;
}

/**
 * Check if a thinking part has a valid signature (>= MIN_SIGNATURE_LENGTH chars)
 */
export function hasValidSignature(part) {
    const signature = part.thought === true ? part.thoughtSignature : part.signature;
    return typeof signature === 'string' && signature.length >= MIN_SIGNATURE_LENGTH;
}

/**
 * Sanitize a thinking part by keeping only allowed fields
 */
export function sanitizeThinkingPart(part) {
    // Gemini-style thought blocks: { thought: true, text, thoughtSignature }
    if (part.thought === true) {
        const sanitized = { thought: true };
        if (part.text !== undefined) sanitized.text = part.text;
        if (part.thoughtSignature !== undefined) sanitized.thoughtSignature = part.thoughtSignature;
        return sanitized;
    }

    // Anthropic-style thinking blocks: { type: "thinking", thinking, signature }
    if (part.type === 'thinking' || part.thinking !== undefined) {
        const sanitized = { type: 'thinking' };
        if (part.thinking !== undefined) sanitized.thinking = part.thinking;
        if (part.signature !== undefined) sanitized.signature = part.signature;
        return sanitized;
    }

    return part;
}

/**
 * Sanitize a thinking block by removing extra fields like cache_control.
 * Only keeps: type, thinking, signature (for thinking) or type, data (for redacted_thinking)
 */
export function sanitizeAnthropicThinkingBlock(block) {
    if (!block) return block;

    if (block.type === 'thinking') {
        const sanitized = { type: 'thinking' };
        if (block.thinking !== undefined) sanitized.thinking = block.thinking;
        if (block.signature !== undefined) sanitized.signature = block.signature;
        return sanitized;
    }

    if (block.type === 'redacted_thinking') {
        const sanitized = { type: 'redacted_thinking' };
        if (block.data !== undefined) sanitized.data = block.data;
        return sanitized;
    }

    return block;
}

/**
 * Filter content array, keeping only thinking blocks with valid signatures.
 * @param {Array} contentArray - Array of content parts
 * @param {boolean} isGeminiModel - Whether this is for a Gemini model
 */
function filterContentArray(contentArray, isGeminiModel = false) {
    const filtered = [];

    for (const item of contentArray) {
        if (!item || typeof item !== 'object') {
            filtered.push(item);
            continue;
        }

        if (!isThinkingPart(item)) {
            filtered.push(item);
            continue;
        }

        // Check signature validity based on model type
        let hasValidSig = false;
        if (isGeminiModel) {
            // For Gemini, check both thoughtSignature (Gemini format) and signature (Anthropic format)
            const sig = item.thoughtSignature || item.signature;
            hasValidSig = isValidGeminiSignature(sig);
        } else {
            // For Claude, use standard validation
            hasValidSig = hasValidSignature(item);
        }

        // Keep items with valid signatures
        if (hasValidSig) {
            filtered.push(sanitizeThinkingPart(item));
            continue;
        }

        // Drop unsigned thinking blocks
    }

    return filtered;
}

/**
 * Filter unsigned thinking blocks from contents (Gemini format)
 *
 * @param {Array<{role: string, parts: Array}>} contents - Array of content objects in Gemini format
 * @param {boolean} isGeminiModel - Whether this is for a Gemini model (optional, defaults to false for backward compatibility)
 * @returns {Array<{role: string, parts: Array}>} Filtered contents with unsigned thinking blocks removed
 */
export function filterUnsignedThinkingBlocks(contents, isGeminiModel = false) {
    return contents.map(content => {
        if (!content || typeof content !== 'object') return content;

        if (Array.isArray(content.parts)) {
            return { ...content, parts: filterContentArray(content.parts, isGeminiModel) };
        }

        return content;
    });
}

/**
 * Remove trailing unsigned thinking blocks from assistant messages.
 * Claude/Gemini APIs require that assistant messages don't end with unsigned thinking blocks.
 *
 * @param {Array<Object>} content - Array of content blocks
 * @param {boolean} isGeminiModel - Whether this is for a Gemini model
 * @returns {Array<Object>} Content array with trailing unsigned thinking blocks removed
 */
export function removeTrailingThinkingBlocks(content, isGeminiModel = false) {
    if (!Array.isArray(content)) return content;
    if (content.length === 0) return content;

    // Work backwards from the end, removing thinking blocks
    let endIndex = content.length;
    for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i];
        if (!block || typeof block !== 'object') break;

        // Check if it's a thinking block (any format)
        const isThinking = isThinkingPart(block);

        if (isThinking) {
            // For Gemini, check with Gemini-specific signature validation
            let hasValidSig = false;
            if (isGeminiModel) {
                hasValidSig = isValidGeminiSignature(block.signature);
            } else {
                hasValidSig = hasValidSignature(block);
            }

            if (!hasValidSig) {
                endIndex = i;
            } else {
                break; // Stop at signed thinking block
            }
        } else {
            break; // Stop at first non-thinking block
        }
    }

    if (endIndex < content.length) {
        return content.slice(0, endIndex);
    }

    return content;
}

/**
 * Check if a signature is valid for Gemini models
 * Gemini accepts placeholder signatures like 'gemini-thinking-no-signature'
 * @param {string} signature - Signature to check
 * @returns {boolean} True if signature is valid for Gemini
 */
function isValidGeminiSignature(signature) {
    if (!signature || typeof signature !== 'string') return false;
    // Gemini accepts placeholder signatures
    if (signature === 'gemini-thinking-no-signature' || 
        signature === 'gemini-synthetic-thinking-for-tool-use' ||
        signature.startsWith('gemini-')) {
        return true;
    }
    // Also accept signatures that meet minimum length
    return signature.length >= MIN_SIGNATURE_LENGTH;
}

/**
 * Filter thinking blocks: keep only those with valid signatures.
 * Blocks without signatures are dropped (API requires signatures).
 * Also sanitizes blocks to remove extra fields like cache_control.
 *
 * @param {Array<Object>} content - Array of content blocks
 * @param {boolean} isGeminiModel - Whether this is for a Gemini model
 * @returns {Array<Object>} Filtered content with only valid signed thinking blocks
 */
export function restoreThinkingSignatures(content, isGeminiModel = false) {
    if (!Array.isArray(content)) return content;

    const originalLength = content.length;
    const filtered = [];

    for (const block of content) {
        if (!block || block.type !== 'thinking') {
            filtered.push(block);
            continue;
        }

        // For Gemini models, accept placeholder signatures
        if (isGeminiModel) {
            if (isValidGeminiSignature(block.signature)) {
                filtered.push(sanitizeAnthropicThinkingBlock(block));
            }
            // Drop unsigned thinking blocks for Gemini too
        } else {
            // For Claude models, require valid signatures (>= MIN_SIGNATURE_LENGTH chars)
            if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
                filtered.push(sanitizeAnthropicThinkingBlock(block));
            }
            // Unsigned thinking blocks are dropped
        }
    }

    if (filtered.length < originalLength) {
    }

    return filtered;
}

/**
 * Reorder content so that:
 * 1. Thinking blocks come first (required when thinking is enabled)
 * 2. Text blocks come in the middle (filtering out empty/useless ones)
 * 3. Tool_use blocks come at the end (required before tool_result)
 *
 * @param {Array<Object>} content - Array of content blocks
 * @returns {Array<Object>} Reordered content array
 */
export function reorderAssistantContent(content) {
    if (!Array.isArray(content)) return content;

    // Even for single-element arrays, we need to sanitize thinking blocks
    if (content.length === 1) {
        const block = content[0];
        if (block && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
            return [sanitizeAnthropicThinkingBlock(block)];
        }
        return content;
    }

    const thinkingBlocks = [];
    const textBlocks = [];
    const toolUseBlocks = [];
    let droppedEmptyBlocks = 0;

    for (const block of content) {
        if (!block) continue;

        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // Sanitize thinking blocks to remove cache_control and other extra fields
            thinkingBlocks.push(sanitizeAnthropicThinkingBlock(block));
        } else if (block.type === 'tool_use') {
            toolUseBlocks.push(block);
        } else if (block.type === 'text') {
            // Only keep text blocks with meaningful content
            if (block.text && block.text.trim().length > 0) {
                textBlocks.push(block);
            } else {
                droppedEmptyBlocks++;
            }
        } else {
            // Other block types go in the text position
            textBlocks.push(block);
        }
    }

    if (droppedEmptyBlocks > 0) {
    }

    const reordered = [...thinkingBlocks, ...textBlocks, ...toolUseBlocks];

    // Log only if actual reordering happened (not just filtering)
    if (reordered.length === content.length) {
        const originalOrder = content.map(b => b?.type || 'unknown').join(',');
        const newOrder = reordered.map(b => b?.type || 'unknown').join(',');
    }

    return reordered;
}

// ============================================================================
// Thinking Recovery Functions
// ============================================================================

/**
 * Check if a message has any VALID (signed) thinking blocks.
 * Only counts thinking blocks that have valid signatures, not unsigned ones
 * that will be dropped later.
 *
 * @param {Object} message - Message to check
 * @param {boolean} isGeminiModel - Whether this is for a Gemini model (optional)
 * @returns {boolean} True if message has valid signed thinking blocks
 */
function messageHasValidThinking(message, isGeminiModel = false) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block => {
        if (!isThinkingPart(block)) return false;
        
        // Get signature from either location
        const signature = block.signature || block.thoughtSignature;
        
        if (isGeminiModel) {
            // For Gemini, accept placeholder signatures
            return isValidGeminiSignature(signature);
        } else {
            // For Claude, require minimum length
            return signature && signature.length >= MIN_SIGNATURE_LENGTH;
        }
    });
}

/**
 * Check if a message has tool_use blocks
 * @param {Object} message - Message to check
 * @returns {boolean} True if message has tool_use blocks
 */
function messageHasToolUse(message) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block =>
        block.type === 'tool_use' || block.functionCall
    );
}

/**
 * Check if a message has tool_result blocks
 * @param {Object} message - Message to check
 * @returns {boolean} True if message has tool_result blocks
 */
function messageHasToolResult(message) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block =>
        block.type === 'tool_result' || block.functionResponse
    );
}

/**
 * Check if message is a plain user text message (not tool_result)
 * @param {Object} message - Message to check
 * @returns {boolean} True if message is plain user text
 */
function isPlainUserMessage(message) {
    if (message.role !== 'user') return false;
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return typeof content === 'string';
    // Check if it has tool_result blocks
    return !content.some(block =>
        block.type === 'tool_result' || block.functionResponse
    );
}

/**
 * Analyze conversation state to detect if we're in a corrupted state.
 * This includes:
 * 1. Tool loop: assistant has tool_use followed by tool_results (normal flow)
 * 2. Interrupted tool: assistant has tool_use followed by plain user message (interrupted)
 *
 * @param {Array<Object>} messages - Array of messages
 * @param {boolean} isGeminiModel - Whether this is for a Gemini model (optional)
 * @returns {Object} State object with inToolLoop, interruptedTool, turnHasThinking, etc.
 */
export function analyzeConversationState(messages, isGeminiModel = false) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { inToolLoop: false, interruptedTool: false, turnHasThinking: false, toolResultCount: 0 };
    }

    // Find the last assistant message
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' || messages[i].role === 'model') {
            lastAssistantIdx = i;
            break;
        }
    }

    if (lastAssistantIdx === -1) {
        return { inToolLoop: false, interruptedTool: false, turnHasThinking: false, toolResultCount: 0 };
    }

    const lastAssistant = messages[lastAssistantIdx];
    const hasToolUse = messageHasToolUse(lastAssistant);
    const hasThinking = messageHasValidThinking(lastAssistant, isGeminiModel);

    // Count trailing tool results after the assistant message
    let toolResultCount = 0;
    let hasPlainUserMessageAfter = false;
    for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
        if (messageHasToolResult(messages[i])) {
            toolResultCount++;
        }
        if (isPlainUserMessage(messages[i])) {
            hasPlainUserMessageAfter = true;
        }
    }

    // We're in a tool loop if: assistant has tool_use AND there are tool_results after
    const inToolLoop = hasToolUse && toolResultCount > 0;

    // We have an interrupted tool if: assistant has tool_use, NO tool_results,
    // but there IS a plain user message after (user interrupted and sent new message)
    const interruptedTool = hasToolUse && toolResultCount === 0 && hasPlainUserMessageAfter;

    return {
        inToolLoop,
        interruptedTool,
        turnHasThinking: hasThinking,
        toolResultCount,
        lastAssistantIdx
    };
}

/**
 * Check if conversation needs thinking recovery.
 * Returns true when:
 * 1. We're in a tool loop but have no valid thinking blocks, OR
 * 2. We have an interrupted tool with no valid thinking blocks
 *
 * @param {Array<Object>} messages - Array of messages
 * @param {boolean} isGeminiModel - Whether this is for a Gemini model (optional)
 * @returns {boolean} True if thinking recovery is needed
 */
export function needsThinkingRecovery(messages, isGeminiModel = false) {
    const state = analyzeConversationState(messages, isGeminiModel);

    // Recovery is needed ONLY if the model is stuck in a loop or interrupted state
    // We do NOT want to trigger this just for missing thoughts in history (e.g. from OpenAI)
    // because that forces "Textify" mode, causing the model to learn/mimic the log format.
    // Since we fixed openai-converter.js to preserve tool_use/tool_result, safe native history is preferred.

    // Need recovery if (tool loop OR interrupted tool) AND no thinking
    // (This covers the active turn case)
    return (state.inToolLoop || state.interruptedTool) && !state.turnHasThinking;
}

/**
 * Strip all thinking blocks from messages.
 * Used before injecting synthetic messages for recovery.
 *
 * @param {Array<Object>} messages - Array of messages
 * @returns {Array<Object>} Messages with all thinking blocks removed
 */
function stripAllThinkingBlocks(messages) {
    return messages.map(msg => {
        const content = msg.content || msg.parts;
        if (!Array.isArray(content)) return msg;

        const filtered = content.filter(block => !isThinkingPart(block));

        if (msg.content) {
            return { ...msg, content: filtered.length > 0 ? filtered : [{ type: 'text', text: '' }] };
        } else if (msg.parts) {
            return { ...msg, parts: filtered.length > 0 ? filtered : [{ text: '' }] };
        }
        return msg;
    });
}

/**
 * Close tool loop by converting corrupted tool history to text.
 * 
 * @deprecated This function is disabled - we no longer convert tool_use/tool_result to text.
 * With proper signature handling, thinking blocks are preserved correctly
 * and tool_use/tool_result blocks remain in their native format.
 * The system works professionally with native tool formats only.
 *
 * @param {Array<Object>} messages - Array of messages
 * @returns {Array<Object>} Modified messages with tool history converted to text
 */
export function closeToolLoopForThinking(messages) {
    const state = analyzeConversationState(messages);

    // If no tool loop/interruption detected, return as is
    if (!state.inToolLoop && !state.interruptedTool) return messages;

    return messages.map(msg => {
        const content = msg.content || msg.parts;
        if (!Array.isArray(content)) return msg;

        // Map content blocks to text if they are tool-related
        const newContent = content.map(block => {
            // Convert tool_use to text
            if (block.type === 'tool_use') {
                const toolName = block.name || 'unknown_tool';
                const inputStr = JSON.stringify(block.input || {});
                return {
                    type: 'text',
                    text: `>>> PAST_TOOL_ACTION: Executed tool '${toolName}' with input: ${inputStr} <<<`
                };
            }

            // Convert tool_result to text
            if (block.type === 'tool_result') {
                const toolName = block.name || block.tool_use_id || 'unknown_tool';
                let resultText = '';
                if (typeof block.content === 'string') {
                    resultText = block.content;
                } else if (Array.isArray(block.content)) {
                    // Flatten array content
                    resultText = block.content
                        .map(c => c.type === 'text' ? c.text : '[Non-text content]')
                        .join('\n');
                }
                return {
                    type: 'text',
                    text: `>>> PAST_TOOL_OUTPUT: Tool '${toolName}' returned: ${resultText} <<<`
                };
            }

            // Filter out thinking blocks (as they are likely invalid)
            if (isThinkingPart(block)) {
                return null; // Will be filtered out
            }

            return block;
        }).filter(Boolean); // Remove nulls

        // Ensure message isn't empty
        if (newContent.length === 0) {
            newContent.push({ type: 'text', text: '[Empty message converted during recovery]' });
        }

        // Return updated message structure
        if (msg.content) {
            return { ...msg, content: newContent };
        } else {
            return { ...msg, parts: newContent };
        }
    });
}

