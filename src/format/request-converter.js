/**
 * Request Converter
 * Converts Anthropic Messages API requests to Google Generative AI format
 */

import {
    GEMINI_MAX_OUTPUT_TOKENS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertContentToParts, convertRole } from './content-converter.js';
import { sanitizeSchema, cleanSchemaForGemini } from './schema-sanitizer.js';
import {
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks,
    needsThinkingRecovery,
    closeToolLoopForThinking
} from './thinking-utils.js';
import { estimateTokenCount } from '../utils/helpers.js';

/**
 * Extract tool names used in message history
 * @param {Array} messages - Message history
 * @returns {Set<string>} Set of tool names used in the conversation
 */
function extractUsedToolNames(messages) {
    const usedTools = new Set();
    
    if (!messages || !Array.isArray(messages)) return usedTools;
    
    for (const msg of messages) {
        if (!msg || !msg.role) continue;
        
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block && block.type === 'tool_use' && block.name) {
                    usedTools.add(block.name);
                }
            }
        }
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block && block.type === 'tool_result' && block.name) {
                    usedTools.add(block.name);
                }
            }
        }
    }
    
    return usedTools;
}

/**
 * Filter tools based on tool_choice and message history to reduce token usage
 * @param {Array} tools - Array of tool definitions
 * @param {string|object} tool_choice - Tool choice directive
 * @param {Array} messages - Message history to check for used tools
 * @returns {Array} Filtered tools array
 */
function filterToolsByChoice(tools, tool_choice, messages) {
    if (!tools || tools.length === 0) return tools;

    // If tool_choice is "none", return empty array
    if (tool_choice === 'none') {
        return [];
    }

    // If tool_choice is an object with a "name" field, filter to only that tool
    if (tool_choice && typeof tool_choice === 'object' && tool_choice.name) {
        const toolName = tool_choice.name;
        const filtered = tools.filter(tool => {
            const name = tool.name || tool.function?.name || tool.custom?.name;
            return name === toolName;
        });
        
        if (filtered.length === 0) {
            console.log(`[RequestConverter] Warning: Tool "${toolName}" specified in tool_choice not found, using all tools`);
            return tools;
        }
        
        return filtered;
    }

    // If tool_choice is "required" (without name), return all tools
    if (tool_choice === 'required') {
        return tools;
    }

    // If tool_choice is "auto" or not specified, try to filter based on message history
    // Only include tools that have been used in the conversation or are likely to be used
    if (!tool_choice || tool_choice === 'auto' || tool_choice === 'any') {
        const usedToolNames = extractUsedToolNames(messages);
        
        // If we have used tools in history, filter to only those + common tools
        // Otherwise, return all tools (first message in conversation)
        if (usedToolNames.size > 0 && usedToolNames.size < tools.length && messages) {
            const filtered = tools.filter(tool => {
                if (!tool) return false;
                const name = tool.name || tool.function?.name || tool.custom?.name;
                return name && usedToolNames.has(name);
            });
            
            // If filtering would remove all tools, keep all (safety check)
            if (filtered.length > 0) {
                return filtered;
            }
        }
    }

    // Unknown tool_choice format or no filtering needed, return all tools
    return tools;
}

/**
 * Calculate token count for tool definitions
 * @param {Array} tools - Array of tool definitions
 * @returns {Object} Token statistics
 */
function calculateToolTokens(tools) {
    if (!tools || tools.length === 0) {
        return { totalTokens: 0, toolCount: 0, toolNames: [] };
    }

    let totalTokens = 0;
    const toolNames = [];

    for (const tool of tools) {
        const name = tool.name || tool.function?.name || tool.custom?.name || 'unknown';
        toolNames.push(name);

        // Estimate tokens for: name + description + parameters schema
        const nameTokens = estimateTokenCount(name);
        const descTokens = estimateTokenCount(tool.description || tool.function?.description || tool.custom?.description || '');
        const schemaTokens = estimateTokenCount(tool.input_schema || tool.function?.input_schema || tool.function?.parameters || tool.custom?.input_schema || tool.parameters || {});
        
        // Add overhead for JSON structure (~10 tokens per tool)
        const overhead = 10;
        totalTokens += nameTokens + descTokens + schemaTokens + overhead;
    }

    return {
        totalTokens,
        toolCount: tools.length,
        toolNames
    };
}

/**
 * Convert Anthropic Messages API request to the format expected by Cloud Code
 *
 * Uses Google Generative AI format, but for Claude models:
 * - Keeps tool_result in Anthropic format (required by Claude API)
 *
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Object} Request body for Cloud Code API and tool metadata
 */
export function convertAnthropicToGoogle(anthropicRequest) {
    const { messages, system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, tool_choice, thinking } = anthropicRequest;
    const modelName = anthropicRequest.model || '';
    const modelFamily = getModelFamily(modelName);
    const isClaudeModel = modelFamily === 'claude';
    const isGeminiModel = modelFamily === 'gemini';
    const isThinking = isThinkingModel(modelName);

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    // Handle system instruction
    if (system) {
        let systemParts = [];
        if (typeof system === 'string') {
            systemParts = [{ text: system }];
        } else if (Array.isArray(system)) {
            // Filter for text blocks as system prompts are usually text
            // Anthropic supports text blocks in system prompts
            systemParts = system
                .filter(block => block.type === 'text')
                .map(block => ({ text: block.text }));
        }

        if (systemParts.length > 0) {
            googleRequest.systemInstruction = {
                parts: systemParts
            };
        }
    }

    // Add interleaved thinking hint for Claude thinking models with tools
    if (isClaudeModel && isThinking && tools && tools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
        if (!googleRequest.systemInstruction) {
            googleRequest.systemInstruction = { parts: [{ text: hint }] };
        } else {
            const lastPart = googleRequest.systemInstruction.parts[googleRequest.systemInstruction.parts.length - 1];
            if (lastPart && lastPart.text) {
                lastPart.text = `${lastPart.text}\n\n${hint}`;
            } else {
                googleRequest.systemInstruction.parts.push({ text: hint });
            }
        }
    }

    // Apply thinking recovery for Gemini thinking models when needed
    // This handles corrupted tool loops where thinking blocks are stripped
    // Claude models handle this differently and don't need this recovery
    let processedMessages = messages;
    if (isGeminiModel && isThinking && needsThinkingRecovery(messages)) {
        console.log('[RequestConverter] Applying thinking recovery for Gemini');
        processedMessages = closeToolLoopForThinking(messages);
    }

    // Build a map of tool_use_id -> tool_name from all assistant messages
    // This is needed because tool_result blocks only have tool_use_id, not tool name
    const toolUseIdToNameMap = new Map();
    for (const msg of processedMessages) {
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'tool_use' && block.id && block.name) {
                    toolUseIdToNameMap.set(block.id, block.name);
                }
            }
        }
    }

    // Convert messages to contents, then filter unsigned thinking blocks
    for (let i = 0; i < processedMessages.length; i++) {
        const msg = processedMessages[i];
        let msgContent = msg.content;

        // For assistant messages, process thinking blocks and reorder content
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            // First, try to restore signatures for unsigned thinking blocks from cache
            msgContent = restoreThinkingSignatures(msgContent);
            // Remove trailing unsigned thinking blocks
            msgContent = removeTrailingThinkingBlocks(msgContent);
            // Reorder: thinking first, then text, then tool_use
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel, toolUseIdToNameMap);

        // SAFETY: Google API requires at least one part per content message
        // This happens when all thinking blocks are filtered out (unsigned)
        if (parts.length === 0) {
            console.log('[RequestConverter] WARNING: Empty parts array after filtering, adding placeholder');
            parts.push({ text: '' });
        }

        const content = {
            role: convertRole(msg.role),
            parts: parts
        };
        googleRequest.contents.push(content);
    }

    // Filter unsigned thinking blocks for Claude models
    if (isClaudeModel) {
        googleRequest.contents = filterUnsignedThinkingBlocks(googleRequest.contents);
    }

    // Generation config
    if (max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = max_tokens;
    }
    if (temperature !== undefined) {
        googleRequest.generationConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
        googleRequest.generationConfig.topP = top_p;
    }
    if (top_k !== undefined) {
        googleRequest.generationConfig.topK = top_k;
    }
    if (stop_sequences && stop_sequences.length > 0) {
        googleRequest.generationConfig.stopSequences = stop_sequences;
    }

    // Enable thinking for thinking models (Claude and Gemini 3+)
    if (isThinking) {
        if (isClaudeModel) {
            // Claude thinking config
            const thinkingConfig = {
                include_thoughts: true
            };

            // Only set thinking_budget if explicitly provided
            const thinkingBudget = thinking?.budget_tokens;
            if (thinkingBudget) {
                thinkingConfig.thinking_budget = thinkingBudget;
            }

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        } else if (isGeminiModel) {
            // Gemini thinking config (uses camelCase)
            const thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: thinking?.budget_tokens || 16000
            };

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        }
    }

    // Filter tools based on tool_choice to reduce token usage
    let filteredTools = tools;
    let toolFilteringInfo = null;
    
    if (tools && tools.length > 0) {
        const originalToolCount = tools.length;
        filteredTools = filterToolsByChoice(tools, tool_choice, processedMessages);
        const filteredToolCount = filteredTools.length;

        // Calculate token usage for original and filtered tools
        const originalTokens = calculateToolTokens(tools);
        const filteredTokens = calculateToolTokens(filteredTools);
        const tokensSaved = originalTokens.totalTokens - filteredTokens.totalTokens;

        toolFilteringInfo = {
            originalCount: originalToolCount,
            filteredCount: filteredToolCount,
            originalTokens: originalTokens.totalTokens,
            filteredTokens: filteredTokens.totalTokens,
            tokensSaved: tokensSaved,
            toolNames: filteredTokens.toolNames
        };

        // Log tool filtering results
        if (filteredToolCount < originalToolCount) {
            console.log(`[RequestConverter] Tool filtering: ${originalToolCount} → ${filteredToolCount} tools (saved ~${tokensSaved} tokens)`);
        } else if (filteredToolCount > 50) {
            console.log(`[RequestConverter] Warning: ${filteredToolCount} tools enabled (high count, ~${filteredTokens.totalTokens} tokens)`);
        } else {
            console.log(`[RequestConverter] ${filteredToolCount} tools enabled (~${filteredTokens.totalTokens} tokens)`);
        }
    }

    // Convert filtered tools to Google format
    if (filteredTools && filteredTools.length > 0) {
        const functionDeclarations = filteredTools.map((tool, idx) => {
            // Extract name from various possible locations
            const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;

            // Extract description from various possible locations
            const description = tool.description || tool.function?.description || tool.custom?.description || '';

            // Extract schema from various possible locations
            const schema = tool.input_schema
                || tool.function?.input_schema
                || tool.function?.parameters
                || tool.custom?.input_schema
                || tool.parameters
                || { type: 'object' };

            // Sanitize schema for general compatibility
            let parameters = sanitizeSchema(schema);

            // For Gemini models, apply additional cleaning for VALIDATED mode
            if (isGeminiModel) {
                parameters = cleanSchemaForGemini(parameters);
            }

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description: description,
                parameters
            };
        });

        googleRequest.tools = [{ functionDeclarations }];
    }

    // Cap max tokens for Gemini models
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        console.log(`[RequestConverter] Capping Gemini max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${GEMINI_MAX_OUTPUT_TOKENS}`);
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    // Return request with tool metadata (not sent to API, just for internal tracking)
    return {
        googleRequest,
        toolMetadata: toolFilteringInfo
    };
}
