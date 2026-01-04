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
import { sanitizeSchema, sanitizeSchemaForClaude, cleanSchemaForGemini } from './schema-sanitizer.js';
import {
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks
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
 * @deprecated Tool filtering is disabled. This function now returns all tools without filtering.
 * @param {Array} tools - Array of tool definitions
 * @param {string|object} tool_choice - Tool choice directive (ignored - deprecated)
 * @param {Array} messages - Message history to check for used tools (ignored - deprecated)
 * @returns {Array} All tools array (no filtering applied)
 */
function filterToolsByChoice(tools, tool_choice, messages) {
    // DEPRECATED: Tool filtering is disabled. Always return all tools.
    // Only exception: if tool_choice is "none", return empty array (required by API spec)
    if (!tools || tools.length === 0) return tools;

    if (tool_choice === 'none') {
        return [];
    }

    // Return all tools without filtering
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

    // NOTE: Anti-Mimicry instruction removed - we no longer convert tool_use/tool_result to text.
    // The system works professionally with native tool formats only.

    // NOTE: Text recovery (closeToolLoopForThinking) is disabled for Gemini models.
    // With proper signature handling, thinking blocks are preserved correctly
    // and tool_use/tool_result blocks remain in their native format.
    // No text conversion is performed - the system works professionally with native tool formats.
    let processedMessages = messages;

    // Build a map of tool_use_id -> tool_name from all assistant messages
    // This is needed because tool_result blocks only have tool_use_id, not tool name
    // Also check user messages for tool_result blocks that might have name field
    const toolUseIdToNameMap = new Map();
    for (const msg of processedMessages) {
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'tool_use' && block.id && block.name) {
                    toolUseIdToNameMap.set(block.id, block.name);
                    if (process.env.DEBUG) {
                        console.log(`[RequestConverter] Mapped tool_use: id=${block.id}, name=${block.name}`);
                    }
                }
            }
        }
        // Also check user messages for tool_result blocks with name field (some APIs include it)
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'tool_result' && block.tool_use_id && block.name) {
                    // If we don't already have this ID mapped, use the name from tool_result
                    if (!toolUseIdToNameMap.has(block.tool_use_id)) {
                        toolUseIdToNameMap.set(block.tool_use_id, block.name);
                        if (process.env.DEBUG) {
                            console.log(`[RequestConverter] Mapped tool_result: id=${block.tool_use_id}, name=${block.name}`);
                        }
                    }
                }
            }
        }
    }

    if (process.env.DEBUG && toolUseIdToNameMap.size > 0) {
        console.log(`[RequestConverter] Built tool_use_id map with ${toolUseIdToNameMap.size} entries`);
    }

    // Convert messages to contents, then filter unsigned thinking blocks
    for (let i = 0; i < processedMessages.length; i++) {
        const msg = processedMessages[i];
        let msgContent = msg.content;

        // For assistant messages, process thinking blocks and reorder content
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            // First, try to restore signatures for unsigned thinking blocks from cache
            // Pass isGeminiModel flag so Gemini placeholder signatures are preserved
            msgContent = restoreThinkingSignatures(msgContent, isGeminiModel);
            // Remove trailing unsigned thinking blocks
            // Pass isGeminiModel flag so Gemini placeholder signatures are preserved
            msgContent = removeTrailingThinkingBlocks(msgContent, isGeminiModel);
            // Reorder: thinking first, then text, then tool_use
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel, toolUseIdToNameMap);

        // SAFETY: Google API requires at least one part per content message
        // This happens when all thinking blocks are filtered out (unsigned)
        if (parts.length === 0) {
            parts.push({ text: '' });
        }

        const content = {
            role: convertRole(msg.role),
            parts: parts
        };
        googleRequest.contents.push(content);
    }

    // Filter unsigned thinking blocks for both Claude and Gemini models
    // This provides an extra safety layer after content conversion
    // Note: Gemini placeholder signatures are already handled in restoreThinkingSignatures
    if (isClaudeModel || isGeminiModel) {
        googleRequest.contents = filterUnsignedThinkingBlocks(googleRequest.contents, isGeminiModel);
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

    // DEPRECATED: Tool filtering is disabled. All tools are now sent without filtering.
    // This section is kept for backward compatibility but filtering logic is disabled.
    let filteredTools = tools;
    let toolFilteringInfo = null;

    if (tools && tools.length > 0) {
        // DEPRECATED: filterToolsByChoice now returns all tools (except when tool_choice is 'none')
        filteredTools = filterToolsByChoice(tools, tool_choice, processedMessages);
        const filteredToolCount = filteredTools.length;

        // Calculate token usage for tools (no filtering applied, so filtered = original)
        const toolTokens = calculateToolTokens(filteredTools);

        // Keep toolFilteringInfo structure for backward compatibility
        toolFilteringInfo = {
            originalCount: filteredToolCount,
            filteredCount: filteredToolCount,
            originalTokens: toolTokens.totalTokens,
            filteredTokens: toolTokens.totalTokens,
            tokensSaved: 0, // No filtering, so no tokens saved
            toolNames: toolTokens.toolNames
        };
    }

    // Convert tools to Google format (all tools, no filtering)
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

            // Log original schema structure
            const schemaType = schema?.type || 'unknown';
            const schemaProperties = schema?.properties ? Object.keys(schema.properties) : [];
            // console.log(`[RequestConverter] Tool "${name}": original schema type="${schemaType}", properties=[${schemaProperties.join(', ')}], keys=[${Object.keys(schema).join(', ')}]`);

            // For Claude models, use minimal sanitization to preserve schema integrity
            // Claude models can handle more JSON Schema features than Gemini
            // For Gemini models, apply full cleaning pipeline for VALIDATED mode
            let parameters;
            const originalSchemaKeys = Object.keys(schema || {});

            if (isGeminiModel) {
                // Gemini requires aggressive sanitization
                parameters = sanitizeSchema(schema);
                parameters = cleanSchemaForGemini(parameters);
                // console.log(`[RequestConverter] Tool "${name}": Gemini schema sanitization applied (${originalSchemaKeys.length} → ${Object.keys(parameters).length} top-level keys)`);
            } else if (isClaudeModel) {
                // Claude models: minimal sanitization - only remove truly problematic fields
                // Preserve most schema features to avoid "invalid arguments" errors
                parameters = sanitizeSchemaForClaude(schema);
            } else {
                // Other models: use standard sanitization
                parameters = sanitizeSchema(schema);
            }

            const sanitizedName = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

            return {
                name: sanitizedName,
                description: description,
                parameters
            };
        });

        googleRequest.tools = [{ functionDeclarations }];
    }

    // Cap max tokens for Gemini models
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    // Return request with tool metadata (not sent to API, just for internal tracking)
    return {
        googleRequest,
        toolMetadata: toolFilteringInfo
    };
}
