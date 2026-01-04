/**
 * Anthropic Messages API Route
 * Main /v1/messages endpoint
 */

import { Router } from 'express';
import crypto from 'crypto';
import { sendMessage, sendMessageStream, listModels } from '../cloudcode-client.js';
import { forceRefresh } from '../token-extractor.js';
import { estimateTokenCount } from '../utils/helpers.js';
import { logDebugFile, logToolUsage } from '../utils/logger.js';
import { addRequestToHistory } from '../services/request-history.js';
import { waitForThrottle } from '../services/request-throttle.js';

/**
 * Debug helper: Log response content for loop detection
 */
function logResponseForDebug(response, model) {
    if (!response || !response.content) return;

    const hasThinking = response.content.some(b => b.type === 'thinking');
    const hasToolUse = response.content.some(b => b.type === 'tool_use');
    const hasText = response.content.some(b => b.type === 'text');
    const thinkingWithoutSignature = response.content.filter(b =>
        b.type === 'thinking' && (!b.signature || b.signature === 'gemini-thinking-no-signature')
    ).length;

    if (hasToolUse && !hasThinking && model.includes('gemini')) {
        console.log(`[Server] ⚠️ WARNING: Gemini tool_use without thinking block - potential loop risk!`);
    }

    if (thinkingWithoutSignature > 0) {
        console.log(`[Server] ⚠️ WARNING: ${thinkingWithoutSignature} thinking block(s) without valid signature`);
    }

    if (!hasText && !hasToolUse && hasThinking) {
        console.log(`[Server] ⚠️ WARNING: Response has only thinking blocks - might cause loop`);
    }
}

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure Antigravity is running with a valid token.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('QUOTA_EXHAUSTED')) {
        errorType = 'invalid_request_error';
        statusCode = 400;

        const resetMatch = error.message.match(/quota will reset after (\d+h\d+m\d+s|\d+m\d+s|\d+s)/i);
        const modelMatch = error.message.match(/"model":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (error.message.includes('invalid_request_error') || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check that Antigravity is running.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = 'Permission denied. Check your Antigravity license.';
    }

    return { errorType, statusCode, errorMessage };
}

export function createMessagesRouter(accountManager, ensureInitialized) {
    const router = Router();

    /**
     * List models endpoint (OpenAI-compatible format)
     */
    router.get('/v1/models', async (req, res) => {
        try {
            await ensureInitialized();
            const account = accountManager.pickNext();
            if (!account) {
                return res.status(503).json({
                    type: 'error',
                    error: {
                        type: 'api_error',
                        message: 'No accounts available'
                    }
                });
            }
            const token = await accountManager.getTokenForAccount(account);
            const models = await listModels(token);
            res.json(models);
        } catch (error) {
            console.error('[API] Error listing models:', error);
            res.status(500).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: error.message
                }
            });
        }
    });

    /**
     * Count tokens endpoint (not supported)
     */
    router.post('/v1/messages/count_tokens', (req, res) => {
        res.status(501).json({
            type: 'error',
            error: {
                type: 'not_implemented',
                message: 'Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.'
            }
        });
    });

    /**
     * Main messages endpoint - Anthropic Messages API compatible
     */
    router.post('/v1/messages', async (req, res) => {
        const requestStartTime = Date.now();
        const requestId = crypto.randomUUID();

        try {
            await ensureInitialized();

            // Optimistic Retry: If ALL accounts are rate-limited, reset them
            if (accountManager.isAllRateLimited()) {
                console.log('[Server] All accounts rate-limited. Resetting state for optimistic retry.');
                accountManager.resetAllRateLimits();
            }

            const {
                model,
                messages,
                max_tokens,
                stream,
                system,
                tools,
                tool_choice,
                thinking,
                top_p,
                top_k,
                temperature
            } = req.body;

            // Calculate tool token usage for logging
            let toolInfo = null;
            if (tools && Array.isArray(tools) && tools.length > 0) {
                let totalToolTokens = 0;
                const toolNames = [];
                for (const tool of tools) {
                    const name = tool.name || tool.function?.name || tool.custom?.name || 'unknown';
                    toolNames.push(name);
                    const nameTokens = estimateTokenCount(name);
                    const descTokens = estimateTokenCount(tool.description || tool.function?.description || tool.custom?.description || '');
                    const schemaTokens = estimateTokenCount(tool.input_schema || tool.function?.input_schema || tool.function?.parameters || tool.custom?.input_schema || tool.parameters || {});
                    totalToolTokens += nameTokens + descTokens + schemaTokens + 10;
                }
                toolInfo = {
                    count: tools.length,
                    tokens: totalToolTokens,
                    names: toolNames.slice(0, 10)
                };
            }

            // Validate required fields
            if (!messages || !Array.isArray(messages)) {
                const duration = Date.now() - requestStartTime;
                addRequestToHistory({
                    id: requestId,
                    method: req.method,
                    path: req.path,
                    status: 'error',
                    error: 'messages is required and must be an array',
                    duration,
                    timestamp: new Date().toISOString()
                });
                return res.status(400).json({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'messages is required and must be an array'
                    }
                });
            }

            // Build the request object
            const request = {
                model: model || 'claude-3-5-sonnet-20241022',
                messages,
                max_tokens: max_tokens || 4096,
                stream,
                system,
                tools,
                tool_choice,
                thinking,
                top_p,
                top_k,
                temperature
            };

            // Get tool metadata from request conversion
            const { googleRequest, toolMetadata } = await import('../format/request-converter.js').then(m => {
                const result = m.convertAnthropicToGoogle(request);
                return result;
            });

            if (toolMetadata) {
                toolInfo = {
                    count: toolMetadata.filteredCount,
                    tokens: toolMetadata.filteredTokens,
                    names: toolMetadata.toolNames
                };
            }

            // Log tool usage for Claude models
            const isClaudeModel = (model || '').toLowerCase().includes('claude');
            if (isClaudeModel && (tools?.length > 0 || messages.some(m => {
                if (Array.isArray(m.content)) {
                    return m.content.some(b => b.type === 'tool_use' || b.type === 'tool_result');
                }
                return false;
            }))) {
                try {
                    const fs = await import('fs');
                    const path = await import('path');
                    const logDir = path.default.join(process.cwd(), 'logs');
                    if (!fs.default.existsSync(logDir)) {
                        fs.default.mkdirSync(logDir, { recursive: true });
                    }
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const logPath = path.default.join(logDir, `claude-raw-request-${timestamp}.json`);
                    fs.default.writeFileSync(logPath, JSON.stringify({
                        timestamp: new Date().toISOString(),
                        model,
                        tools: tools,
                        messages: messages,
                        fullRequest: req.body
                    }, null, 2));

                    logToolUsage(requestId, 'incoming', {
                        messages,
                        tools,
                        tool_choice,
                        model,
                        system
                    }, model);

                    logToolUsage(requestId, 'google-request', {
                        googleRequest
                    }, model);
                } catch (err) {
                    console.error('[Server] Failed to log tool usage:', err);
                }
            }

            if (stream) {
                // Handle streaming response
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                // Apply throttling to prevent rate limiting
                await waitForThrottle(request.model);

                try {
                    let streamUsage = {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0
                    };

                    const contentBlocks = [];
                    let currentBlockIndex = -1;
                    let selectedAccountEmail = null;
                    const streamToolCalls = [];

                    for await (const event of sendMessageStream(request, accountManager)) {
                        if (event.type === 'internal_metadata') {
                            selectedAccountEmail = event.account;
                            continue;
                        }

                        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                        if (res.flush) res.flush();

                        if (event.type === 'message_start' && event.message?.usage) {
                            streamUsage.input_tokens = event.message.usage.input_tokens || 0;
                            streamUsage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
                            streamUsage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens || 0;
                        }
                        if (event.type === 'message_delta' && event.usage) {
                            streamUsage.output_tokens = event.usage.output_tokens || 0;
                        }

                        if (event.type === 'content_block_start') {
                            currentBlockIndex = event.index;
                            contentBlocks[currentBlockIndex] = {
                                type: event.content_block?.type,
                                name: event.content_block?.name,
                                hasSignature: false,
                                text: ''
                            };

                            if (event.content_block?.type === 'thinking' && event.content_block?.signature) {
                                contentBlocks[currentBlockIndex].hasSignature =
                                    event.content_block.signature !== 'gemini-thinking-no-signature';
                            }

                            if (event.content_block?.type === 'tool_use') {
                                streamToolCalls.push({
                                    id: event.content_block.id,
                                    name: event.content_block.name,
                                    input: event.content_block.input
                                });
                            }
                        }

                        if (event.type === 'content_block_delta' && currentBlockIndex >= 0) {
                            if (event.delta?.text) {
                                contentBlocks[currentBlockIndex].text += event.delta.text;
                            }
                        }
                    }
                    res.end();

                    // Check for loop indicators
                    if (contentBlocks.length > 0) {
                        const hasThinking = contentBlocks.some(b => b.type === 'thinking');
                        const hasToolUse = contentBlocks.some(b => b.type === 'tool_use');
                        const hasText = contentBlocks.some(b => b.type === 'text');
                        const thinkingWithoutSig = contentBlocks.filter(b =>
                            b.type === 'thinking' && !b.hasSignature
                        ).length;

                        if (hasToolUse && !hasThinking && request.model.includes('gemini')) {
                            console.log(`[Server] ⚠️ WARNING: Gemini tool_use without thinking - LOOP RISK!`);
                        }

                        if (thinkingWithoutSig > 0) {
                            console.log(`[Server] ⚠️ WARNING: ${thinkingWithoutSig} thinking block(s) without valid signature`);
                        }

                        if (!hasText && !hasToolUse && hasThinking) {
                            console.log(`[Server] ⚠️ WARNING: Only thinking blocks, no text/tools - might cause loop`);
                        }
                    }

                    // Log streaming response for Claude tool usage
                    if (isClaudeModel && streamToolCalls.length > 0) {
                        try {
                            logToolUsage(requestId, 'outgoing', {
                                anthropicResponse: {
                                    content: contentBlocks.filter(b => b.type === 'tool_use').map(b => ({
                                        type: 'tool_use',
                                        id: b.toolId,
                                        name: b.toolName,
                                        input: b.input
                                    })),
                                    usage: streamUsage
                                },
                                streamToolCalls,
                                stream: true
                            }, request.model);
                        } catch (err) {
                            console.error('[Server] Failed to log streaming tool usage response:', err);
                        }
                    }

                    // Track successful streaming request
                    const duration = Date.now() - requestStartTime;
                    addRequestToHistory({
                        id: requestId,
                        method: req.method,
                        path: req.path,
                        status: 'success',
                        model: request.model,
                        account: selectedAccountEmail,
                        stream: true,
                        duration,
                        timestamp: new Date().toISOString(),
                        usage: streamUsage,
                        tools: toolInfo
                    });

                } catch (streamError) {
                    console.error('[API] Stream error:', streamError);
                    const { errorType, errorMessage } = parseError(streamError);

                    res.write(`event: error\ndata: ${JSON.stringify({
                        type: 'error',
                        error: { type: errorType, message: errorMessage }
                    })}\n\n`);
                    res.end();

                    const duration = Date.now() - requestStartTime;
                    addRequestToHistory({
                        id: requestId,
                        method: req.method,
                        path: req.path,
                        status: 'error',
                        error: errorMessage,
                        model: request.model,
                        stream: true,
                        duration,
                        timestamp: new Date().toISOString()
                    });
                }

            } else {
                // Handle non-streaming response
                // Apply throttling to prevent rate limiting
                await waitForThrottle(request.model);
                const response = await sendMessage(request, accountManager);

                if (isClaudeModel && (tools?.length > 0 || response.content?.some(b => b.type === 'tool_use'))) {
                    try {
                        logToolUsage(requestId, 'outgoing', {
                            anthropicResponse: response
                        }, request.model);
                    } catch (err) {
                        console.error('[Server] Failed to log tool usage response:', err);
                    }
                }

                logResponseForDebug(response, request.model);
                res.json(response);

                const duration = Date.now() - requestStartTime;
                const usage = response.usage || {};
                const selectedAccountEmail = response._account;
                addRequestToHistory({
                    id: requestId,
                    method: req.method,
                    path: req.path,
                    status: 'success',
                    model: request.model,
                    account: selectedAccountEmail,
                    stream: false,
                    duration,
                    timestamp: new Date().toISOString(),
                    usage: {
                        input_tokens: usage.input_tokens || 0,
                        output_tokens: usage.output_tokens || 0,
                        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0
                    },
                    tools: toolInfo
                });
            }

        } catch (error) {
            console.error('[API] Error:', error);
            let { errorType, statusCode, errorMessage } = parseError(error);

            if (errorType === 'authentication_error') {
                console.log('[API] Token might be expired, attempting refresh...');
                try {
                    accountManager.clearProjectCache();
                    accountManager.clearTokenCache();
                    await forceRefresh();
                    errorMessage = 'Token was expired and has been refreshed. Please retry your request.';
                } catch (refreshError) {
                    errorMessage = 'Could not refresh token. Make sure Antigravity is running.';
                }
            }

            if (res.headersSent) {
                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
            } else {
                res.status(statusCode).json({
                    type: 'error',
                    error: {
                        type: errorType,
                        message: errorMessage
                    }
                });
            }

            const duration = Date.now() - requestStartTime;
            addRequestToHistory({
                id: requestId,
                method: req.method,
                path: req.path,
                status: 'error',
                error: errorMessage,
                duration,
                timestamp: new Date().toISOString()
            });
        }
    });

    return router;
}
