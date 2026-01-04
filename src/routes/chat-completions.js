/**
 * OpenAI Chat Completions API Route
 * /chat/completions endpoint - OpenAI-compatible format
 */

import { Router } from 'express';
import crypto from 'crypto';
import { sendMessage, sendMessageStream } from '../cloudcode-client.js';
import { forceRefresh } from '../token-extractor.js';
import { estimateTokenCount } from '../utils/helpers.js';
import { addRequestToHistory } from '../services/request-history.js';
import { waitForThrottle } from '../services/request-throttle.js';
import { convertOpenAIToAnthropic, convertAnthropicToOpenAI, convertAnthropicStreamToOpenAI } from '../format/openai-converter.js';

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

export function createChatCompletionsRouter(accountManager, ensureInitialized) {
    const router = Router();

    /**
     * OpenAI-compatible Chat Completions endpoint
     */
    router.post('/chat/completions', async (req, res) => {
        const requestStartTime = Date.now();
        const requestId = crypto.randomUUID();

        try {
            await ensureInitialized();

            // Optimistic Retry: If ALL accounts are rate-limited, reset them
            if (accountManager.isAllRateLimited()) {
                console.log('[Server] All accounts rate-limited. Resetting state for optimistic retry.');
                accountManager.resetAllRateLimits();
            }

            const openaiRequest = req.body;
            const { model, messages, stream, tools } = openaiRequest;

            // Calculate tool token usage for logging
            let toolInfo = null;
            if (tools && Array.isArray(tools) && tools.length > 0) {
                let totalToolTokens = 0;
                const toolNames = [];
                for (const tool of tools) {
                    const name = tool.name || tool.function?.name || 'unknown';
                    toolNames.push(name);
                    const nameTokens = estimateTokenCount(name);
                    const descTokens = estimateTokenCount(tool.description || tool.function?.description || '');
                    const schemaTokens = estimateTokenCount(tool.parameters || tool.function?.parameters || {});
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
                    error: {
                        type: 'invalid_request_error',
                        message: 'messages is required and must be an array'
                    }
                });
            }

            // Convert OpenAI format to Anthropic format
            const anthropicRequest = convertOpenAIToAnthropic(openaiRequest);

            // Get tool metadata from request conversion
            const { toolMetadata } = await import('../format/request-converter.js').then(m => {
                const result = m.convertAnthropicToGoogle(anthropicRequest);
                return result;
            });

            if (toolMetadata) {
                toolInfo = {
                    count: toolMetadata.filteredCount,
                    tokens: toolMetadata.filteredTokens,
                    names: toolMetadata.toolNames
                };
            }

            if (stream) {
                // Handle streaming response (OpenAI format)
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                let messageId = 'chatcmpl-' + Date.now();
                let streamUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0
                };
                let selectedAccountEmail = null;

                try {
                    // Apply throttling to prevent rate limiting
                    await waitForThrottle(model || anthropicRequest.model);

                    for await (const event of sendMessageStream(anthropicRequest, accountManager)) {
                        if (event.type === 'internal_metadata') {
                            selectedAccountEmail = event.account;
                            continue;
                        }

                        // Extract message ID from message_start event
                        if (event.type === 'message_start' && event.message?.id) {
                            messageId = event.message.id;
                        }

                        // Capture usage
                        if (event.type === 'message_start' && event.message?.usage) {
                            streamUsage.input_tokens = event.message.usage.input_tokens || 0;
                            streamUsage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
                            streamUsage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens || 0;
                        }
                        if (event.type === 'message_delta' && event.usage) {
                            streamUsage.output_tokens = event.usage.output_tokens || 0;
                        }

                        // Convert Anthropic SSE event to OpenAI format
                        const openaiEvent = convertAnthropicStreamToOpenAI(event, model || anthropicRequest.model, messageId);
                        if (openaiEvent) {
                            res.write(`data: ${JSON.stringify(openaiEvent)}\n\n`);
                            if (res.flush) res.flush();
                        }
                    }
                    res.write('data: [DONE]\n\n');
                    res.end();

                    // Track successful streaming request
                    const duration = Date.now() - requestStartTime;
                    addRequestToHistory({
                        id: requestId,
                        method: req.method,
                        path: req.path,
                        status: 'success',
                        model: model || anthropicRequest.model,
                        account: selectedAccountEmail,
                        stream: true,
                        duration,
                        timestamp: new Date().toISOString(),
                        usage: streamUsage,
                        tools: toolInfo
                    });

                } catch (streamError) {
                    console.error('[API] OpenAI stream error:', streamError);
                    const { errorType, errorMessage } = parseError(streamError);

                    if (!res.headersSent && !res.writableEnded) {
                        try {
                            res.write(`data: ${JSON.stringify({
                                error: { type: errorType, message: errorMessage }
                            })}\n\n`);
                            res.end();
                        } catch (writeError) {
                            if (writeError.code !== 'ERR_STREAM_WRITE_AFTER_END') {
                                console.error('[API] Error writing to stream:', writeError);
                            }
                        }
                    } else if (!res.writableEnded) {
                        try {
                            res.end();
                        } catch (endError) {
                            // Ignore
                        }
                    }

                    const duration = Date.now() - requestStartTime;
                    addRequestToHistory({
                        id: requestId,
                        method: req.method,
                        path: req.path,
                        status: 'error',
                        error: errorMessage,
                        model: model || anthropicRequest.model,
                        account: selectedAccountEmail,
                        stream: true,
                        duration,
                        timestamp: new Date().toISOString()
                    });
                }

            } else {
                // Handle non-streaming response
                // Apply throttling to prevent rate limiting
                await waitForThrottle(model || anthropicRequest.model);

                const anthropicResponse = await sendMessage(anthropicRequest, accountManager);
                const openaiResponse = convertAnthropicToOpenAI(anthropicResponse, model || anthropicRequest.model);
                res.json(openaiResponse);

                const duration = Date.now() - requestStartTime;
                const usage = anthropicResponse.usage || {};
                const selectedAccountEmail = anthropicResponse._account;
                addRequestToHistory({
                    id: requestId,
                    method: req.method,
                    path: req.path,
                    status: 'success',
                    model: model || anthropicRequest.model,
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
            console.error('[API] OpenAI endpoint error:', error);
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

            if (res.headersSent && !res.writableEnded) {
                try {
                    res.write(`data: ${JSON.stringify({
                        error: { type: errorType, message: errorMessage }
                    })}\n\n`);
                    res.end();
                } catch (writeError) {
                    if (writeError.code !== 'ERR_STREAM_WRITE_AFTER_END') {
                        console.error('[API] Error writing to stream:', writeError);
                    }
                }
            } else if (!res.headersSent) {
                res.status(statusCode).json({
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
