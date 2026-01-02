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

            if (isClaudeModel && block.id) {
                functionCall.id = block.id;
            }

            // Build the part with functionCall
            const part = { functionCall };

            // For Claude models, we need to be careful.
            // Some versions of the bridge/proxy might handle this differently.
            // If the standard functionCall format is failing (causing text.text errors),
            // it implies the proxy is mishandling the conversion back to Anthropic.
            // However, we cannot simply push { type: 'tool_use' } as that's not a valid Part.
            // We must stick to valid Google Parts.
            // Let's ensure 'id' is present (already done above).

            // NOTE: The error 'messages.2.content.0.text.text' suggests a tool_result issue (User message).
            // See tool_result handling below.

            // For Gemini models, include thoughtSignature at the part level
            // This is required by Gemini 3+ for tool calls to work correctly
            if (isGeminiModel) {
                // Priority: block.thoughtSignature > cache > GEMINI_SKIP_SIGNATURE
                let signature = block.thoughtSignature;

                if (!signature && block.id) {
                    signature = getCachedSignature(block.id);
                }

                part.thoughtSignature = signature || GEMINI_SKIP_SIGNATURE;
            }

            parts.push(part);
        } else if (block.type === 'tool_result') {
            // Convert tool_result to functionResponse (Google format)
            let responseContent = block.content;
            let imageParts = [];

            if (typeof responseContent === 'string') {
                // Wrap in object with 'content' key for Claude? No, Google expects 'output' or 'result' map.
                // But wait, Anthropic expects 'content' string or list of blocks.
                // Google's functionResponse.response is a Map<string, any>.
                // Cloud Code proxies mapping logic:
                // Google { result: "..." } -> Anthropic { content: "..." } ?
                responseContent = { content: responseContent };
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
                responseContent = { content: texts || (imageParts.length > 0 ? 'Image attached' : '') };
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

            if (!toolName) {
                // Skip this tool_result - it's invalid without a matching tool_use
                continue;
            }

            if (isClaudeModel) {
                // FALLBACK: Google's functionResponse seems to fail for Claude on this proxy 
                // (Error: messages.2.content.0.text.text: Field required).
                // Convert to explicit text format to ensure delivery and loop breaking.
                let textContent = '';
                // Handle content type
                if (responseContent.content && typeof responseContent.content === 'string') {
                    textContent = responseContent.content;
                } else if (responseContent.result && typeof responseContent.result === 'string') {
                    textContent = responseContent.result;
                } else {
                    textContent = JSON.stringify(responseContent);
                }

                parts.push({
                    text: `[Tool Result for '${toolName}': ${textContent}]`
                });

                // Add images if any (images are supported in text/user blocks usually)
                parts.push(...imageParts);

                continue; // Skip functionResponse construction
            }

            const functionResponse = {
                name: toolName,
                response: responseContent
            };

            // For Claude models (Legacy path kept just in case, though we fallback above now)
            // if (isClaudeModel && block.tool_use_id) { ... }
            functionResponse.id = block.tool_use_id;

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
