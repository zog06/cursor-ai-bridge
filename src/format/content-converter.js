/**
 * Content Converter
 * Converts Anthropic message content to Google Generative AI parts format
 */

import { MIN_SIGNATURE_LENGTH, GEMINI_SKIP_SIGNATURE } from '../constants.js';
import { getCachedSignature } from './signature-cache.js';

/**
 * Convert Anthropic role to Google role
 * @param {string} role - Anthropic role ('user', 'assistant')
 * @returns {string} Google role ('user', 'model')
 */
export function convertRole(role) {
    if (role === 'assistant') return 'model';
    if (role === 'user') return 'user';
    return 'user'; // Default to user
}

/**
 * Convert Anthropic message content to Google Generative AI parts
 * @param {string|Array} content - Anthropic message content
 * @param {boolean} isClaudeModel - Whether the model is a Claude model
 * @param {boolean} isGeminiModel - Whether the model is a Gemini model
 * @param {Map<string, string>} toolUseIdToNameMap - Map of tool_use_id -> tool_name (for tool_result conversion)
 * @returns {Array} Google Generative AI parts array
 */
export function convertContentToParts(content, isClaudeModel = false, isGeminiModel = false, toolUseIdToNameMap = new Map()) {
    if (typeof content === 'string') {
        return [{ text: content }];
    }

    if (!Array.isArray(content)) {
        return [{ text: String(content) }];
    }

    const parts = [];

    for (const block of content) {
        if (block.type === 'text') {
            // Skip empty text blocks - they cause API errors
            if (block.text && block.text.trim()) {
                parts.push({ text: block.text });
            }
        } else if (block.type === 'image') {
            // Handle image content
            if (block.source?.type === 'base64') {
                // Base64-encoded image
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                // URL-referenced image
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'image/jpeg',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'document') {
            // Handle document content (e.g. PDF)
            if (block.source?.type === 'base64') {
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'application/pdf',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'tool_use') {
            // Convert tool_use to functionCall (Google format)
            // For Claude models, include the id field
            const functionCall = {
                name: block.name,
                args: block.input || {}
            };

            // Log tool_use conversion for debugging
            const argsKeys = Object.keys(functionCall.args);
            const argsPreview = argsKeys.length > 0 
                ? argsKeys.map(k => `${k}=${JSON.stringify(functionCall.args[k]).substring(0, 50)}`).join(', ')
                : '{}';
            console.log(`[ContentConverter] Converting tool_use: name="${block.name}", id="${block.id || 'none'}", args_keys=[${argsKeys.join(', ')}], args_preview={${argsPreview}}`);

            if (isClaudeModel && block.id) {
                functionCall.id = block.id;
                console.log(`[ContentConverter] Added id field for Claude model: ${block.id}`);
            }

            // Build the part with functionCall
            const part = { functionCall };

            // For Gemini models, include thoughtSignature at the part level
            // This is required by Gemini 3+ for tool calls to work correctly
            if (isGeminiModel) {
                // Priority: block.thoughtSignature > cache > GEMINI_SKIP_SIGNATURE
                let signature = block.thoughtSignature;

                if (!signature && block.id) {
                    signature = getCachedSignature(block.id);
                    if (signature) {
                        console.log('[ContentConverter] Restored signature from cache for:', block.id);
                    }
                }

                part.thoughtSignature = signature || GEMINI_SKIP_SIGNATURE;
            }

            parts.push(part);
        } else if (block.type === 'tool_result') {
            // Convert tool_result to functionResponse (Google format)
            let responseContent = block.content;
            let imageParts = [];

            if (typeof responseContent === 'string') {
                responseContent = { result: responseContent };
            } else if (Array.isArray(responseContent)) {
                // Extract images from tool results first (e.g., from Read tool reading image files)
                for (const item of responseContent) {
                    if (item.type === 'image' && item.source?.type === 'base64') {
                        imageParts.push({
                            inlineData: {
                                mimeType: item.source.media_type,
                                data: item.source.data
                            }
                        });
                    }
                }

                // Extract text content
                const texts = responseContent
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
                responseContent = { result: texts || (imageParts.length > 0 ? 'Image attached' : '') };
            }

            // Find tool name from multiple sources (priority order):
            // 1. block.name (if provided directly in tool_result)
            // 2. toolUseIdToNameMap lookup (from previous tool_use blocks)
            // 3. Skip if not found (invalid tool_result without matching tool_use)
            let toolName = block.name; // Some APIs include name directly
            let nameSource = 'block.name';
            
            if (!toolName && block.tool_use_id) {
                toolName = toolUseIdToNameMap.get(block.tool_use_id);
                nameSource = toolName ? 'toolUseIdToNameMap' : 'not found';
            }

            // If we still don't have a tool name, this is an invalid tool_result
            // Google API requires a valid tool name, so we must skip this block
            if (!toolName) {
                console.log(`[ContentConverter] WARNING: tool_result without valid tool name (tool_use_id: ${block.tool_use_id || 'none'}, name source: ${nameSource}). Skipping to avoid "invalid tool call use" error.`);
                console.log(`[ContentConverter] Available tool_use_ids in map: ${Array.from(toolUseIdToNameMap.keys()).join(', ') || 'none'}`);
                // Skip this tool_result - it's invalid without a matching tool_use
                continue;
            }

            if (process.env.DEBUG) {
                console.log(`[ContentConverter] tool_result conversion: tool_use_id=${block.tool_use_id}, tool_name=${toolName}, name_source=${nameSource}`);
            }

            const functionResponse = {
                name: toolName,
                response: responseContent
            };

            // For Claude models, the id field must match the tool_use_id
            if (isClaudeModel && block.tool_use_id) {
                functionResponse.id = block.tool_use_id;
                if (process.env.DEBUG) {
                    console.log(`[ContentConverter] Added id field for Claude model: ${block.tool_use_id}`);
                }
            }

            parts.push({ functionResponse });

            // Add any images from the tool result as separate parts
            parts.push(...imageParts);
        } else if (block.type === 'thinking') {
            // Handle thinking blocks - only those with valid signatures
            if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
                // Convert to Gemini format with signature
                parts.push({
                    text: block.thinking,
                    thought: true,
                    thoughtSignature: block.signature
                });
            }
            // Unsigned thinking blocks are dropped upstream
        }
    }

    return parts;
}
