/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { sendMessage, sendMessageStream, listModels, getModelQuotas } from './cloudcode-client.js';
import { forceRefresh } from './token-extractor.js';
import { REQUEST_BODY_LIMIT, API_KEY, API_KEY_PATH } from './constants.js';
import { AccountManager } from './account-manager.js';
import { formatDuration, estimateTokenCount } from './utils/helpers.js';
import { convertOpenAIToAnthropic, convertAnthropicToOpenAI, convertAnthropicStreamToOpenAI } from './format/openai-converter.js';
import { 
    readCursorSettings, 
    configureCursorForProxy, 
    removeCursorProxyConfig, 
    isProxyConfigured,
    getOpenAISettings,
    setOpenAIApiKey,
    setOpenAIBaseUrl,
    toggleOpenAIApiKey,
    toggleOpenAIBaseUrl
} from './cursor-settings.js';
import { startNgrok, stopNgrok, getCurrentNgrokUrl } from './ngrok-manager.js';

const app = express();

// Initialize account manager (will be fully initialized on first request or startup)
const accountManager = new AccountManager();

/**
 * Load API key from file or generate new one
 */
function loadOrGenerateApiKey() {
    // First priority: environment variable
    if (API_KEY) {
        console.log('[Server] Using API key from environment variable');
        return API_KEY;
    }
    
    // Second priority: load from file
    if (existsSync(API_KEY_PATH)) {
        try {
            const savedKey = readFileSync(API_KEY_PATH, 'utf8').trim();
            if (savedKey && savedKey.startsWith('ag_')) {
                console.log('[Server] Loaded API key from file');
                return savedKey;
            }
        } catch (error) {
            console.error('[Server] Failed to read API key file:', error.message);
        }
    }
    
    // Generate new key and save it
    const newKey = 'ag_' + crypto.randomBytes(32).toString('hex');
    
    try {
        // Ensure directory exists
        const dir = dirname(API_KEY_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        
        // Save to file
        writeFileSync(API_KEY_PATH, newKey, 'utf8');
        console.log(`[Server] Generated and saved new API key to: ${API_KEY_PATH}`);
    } catch (error) {
        console.error('[Server] Failed to save API key to file:', error.message);
    }
    
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🔑 API Key Generated (saved to config file)                ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  ${newKey}
║                                                              ║
║  This key is saved to: ${API_KEY_PATH.slice(-40)}
║                                                              ║
║  To use a custom key, set ANTIGRAVITY_PROXY_API_KEY         ║
║  environment variable or regenerate from dashboard.         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
    
    return newKey;
}

/**
 * Regenerate API key and save to file
 */
function regenerateApiKey() {
    const newKey = 'ag_' + crypto.randomBytes(32).toString('hex');
    
    try {
        // Ensure directory exists
        const dir = dirname(API_KEY_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        
        // Save to file
        writeFileSync(API_KEY_PATH, newKey, 'utf8');
        console.log('[Server] Regenerated and saved new API key');
    } catch (error) {
        console.error('[Server] Failed to save new API key:', error.message);
        throw error;
    }
    
    return newKey;
}

// Generate or use API key
let serverApiKey = loadOrGenerateApiKey();

// Track initialization status
let isInitialized = false;
let initError = null;
let initPromise = null;

// Server start time for uptime calculation
const serverStartTime = Date.now();

// Request history tracking (in-memory, last 100 requests)
const MAX_REQUEST_HISTORY = 100;
const requestHistory = [];

// Ngrok status cache (30 seconds TTL)
let ngrokStatusCache = null;
let ngrokStatusCacheTime = 0;
const NGROK_CACHE_TTL = 30000; // 30 seconds

/**
 * Add a request to the history
 */
function addRequestToHistory(request) {
    // Debug: Log when usage or tools data is present
    if (request.usage || request.tools) {
        console.log(`[Server] Adding request to history with usage:`, request.usage ? 'yes' : 'no', 'tools:', request.tools ? 'yes' : 'no');
        if (request.tools) {
            console.log(`[Server] Tools info:`, JSON.stringify(request.tools));
        }
    }
    requestHistory.unshift(request);
    if (requestHistory.length > MAX_REQUEST_HISTORY) {
        requestHistory.pop();
    }
}

/**
 * Get request history
 */
function getRequestHistory(limit = 50) {
    return requestHistory.slice(0, limit);
}

/**
 * Ensure account manager is initialized (with race condition protection)
 */
async function ensureInitialized() {
    if (isInitialized) return;

    // If initialization is already in progress, wait for it
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            await accountManager.initialize();
            isInitialized = true;
            const status = accountManager.getStatus();
            console.log(`[Server] Account pool initialized: ${status.summary}`);
        } catch (error) {
            initError = error;
            initPromise = null; // Allow retry on failure
            console.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

/**
 * API Key authentication middleware
 * Checks for API key in Authorization header (Bearer token) or x-api-key header
 * Health check and dashboard endpoints are excluded from authentication
 */
function authenticateApiKey(req, res, next) {
    // Skip authentication for health check, dashboard API, ngrok control, and cursor settings endpoints
    if (req.path === '/health' || 
        req.path === '/api/dashboard' || 
        req.path === '/api/account-limits' ||
        req.path.startsWith('/api/ngrok/') ||
        req.path.startsWith('/api/cursor/')) {
        return next();
    }

    // Get API key from headers
    const authHeader = req.headers.authorization || req.headers['x-api-key'] || '';
    const providedKey = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : authHeader.trim();

    // Check if key matches
    if (!providedKey || providedKey !== serverApiKey) {
        return res.status(401).json({
            type: 'error',
            error: {
                type: 'authentication_error',
                message: 'Invalid API key. Please provide a valid API key in the Authorization header (Bearer token) or x-api-key header.'
            }
        });
    }

    next();
}

// Apply authentication middleware to all routes except health
app.use(authenticateApiKey);

/**
 * Debug helper: Log response content for loop detection
 */
function logResponseForDebug(response, model) {
    if (!response || !response.content) return;
    
    const contentTypes = response.content.map(block => {
        if (block.type === 'thinking') {
            const hasSignature = block.signature && block.signature !== 'gemini-thinking-no-signature';
            return `thinking(sig:${hasSignature ? 'yes' : 'no'})`;
        }
        if (block.type === 'tool_use') {
            return `tool_use(${block.name})`;
        }
        if (block.type === 'text') {
            const preview = (block.text || '').slice(0, 50).replace(/\n/g, ' ');
            return `text("${preview}${block.text.length > 50 ? '...' : ''}")`;
        }
        return block.type || 'unknown';
    });
    
    console.log(`[Server] Response for ${model}: [${contentTypes.join(', ')}]`);
    
    // Check for potential loop indicators
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
        errorType = 'invalid_request_error';  // Use invalid_request_error to force client to purge/stop
        statusCode = 400;  // Use 400 to ensure client does not retry (429 and 529 trigger retries)

        // Try to extract the quota reset time from the error
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

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
    try {
        await ensureInitialized();
        const status = accountManager.getStatus();

        res.json({
            status: 'ok',
            accounts: status.summary,
            available: status.available,
            rateLimited: status.rateLimited,
            invalid: status.invalid,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * ngrok control endpoints
 */
app.post('/api/ngrok/start', async (req, res) => {
    try {
        const port = parseInt(req.body.port) || 8080;
        const url = await startNgrok(port);
        if (url) {
            res.json({ status: 'success', url, message: 'ngrok tunnel started' });
        } else {
            res.json({ status: 'error', message: 'Failed to start ngrok. Make sure ngrok is installed and configured.' });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/api/ngrok/stop', async (req, res) => {
    try {
        stopNgrok();
        res.json({ status: 'success', message: 'ngrok tunnel stopped' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/api/ngrok/status', async (req, res) => {
    try {
        const currentUrl = getCurrentNgrokUrl();
        // Also check ngrok API
        let ngrokStatus = { status: 'disconnected', url: null };
        try {
            const ngrokResponse = await fetch('http://localhost:4040/api/tunnels', {
                signal: AbortSignal.timeout(2000)
            });
            if (ngrokResponse.ok) {
                const ngrokData = await ngrokResponse.json();
                if (ngrokData.tunnels && ngrokData.tunnels.length > 0) {
                    const httpsTunnel = ngrokData.tunnels.find(t => t.public_url.startsWith('https://'));
                    const tunnel = httpsTunnel || ngrokData.tunnels[0];
                    ngrokStatus = {
                        status: 'connected',
                        url: tunnel.public_url,
                        tunnels: ngrokData.tunnels.map(t => ({
                            name: t.name,
                            url: t.public_url,
                            proto: t.proto
                        }))
                    };
                }
            }
        } catch (error) {
            // ngrok not running
        }
        
        res.json(ngrokStatus);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

/**
 * Cursor settings endpoints
 */
app.get('/api/cursor/settings', async (req, res) => {
    try {
        const result = await readCursorSettings();
        const isConfigured = await isProxyConfigured();
        const openAISettings = await getOpenAISettings();
        res.json({
            ...result,
            proxyConfigured: isConfigured,
            openai: openAISettings
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/api/cursor/configure', async (req, res) => {
    try {
        const { apiKey, baseUrl, model } = req.body;
        
        if (!apiKey || !baseUrl) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'apiKey and baseUrl are required' 
            });
        }
        
        const result = await configureCursorForProxy(
            apiKey, 
            baseUrl, 
            model || 'claude-sonnet-4-5-thinking'
        );
        
        if (result.success) {
            res.json({ 
                status: 'success', 
                message: 'Cursor configured successfully',
                path: result.path
            });
        } else {
            res.status(500).json({ 
                status: 'error', 
                message: result.error || 'Failed to configure Cursor'
            });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/api/cursor/remove', async (req, res) => {
    try {
        const result = await removeCursorProxyConfig();
        
        if (result.success) {
            res.json({ 
                status: 'success', 
                message: 'Proxy configuration removed from Cursor'
            });
        } else {
            res.status(500).json({ 
                status: 'error', 
                message: result.error || 'Failed to remove configuration'
            });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

/**
 * Update OpenAI API Key in Cursor
 */
app.post('/api/cursor/openai/api-key', async (req, res) => {
    try {
        const { apiKey, enabled } = req.body;
        
        if (apiKey === undefined) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'apiKey is required' 
            });
        }
        
        const result = enabled !== undefined 
            ? await setOpenAIApiKey(apiKey, enabled)
            : await setOpenAIApiKey(apiKey, true);
        
        if (result.success) {
            res.json({ 
                status: 'success', 
                message: 'OpenAI API Key updated successfully'
            });
        } else {
            res.status(500).json({ 
                status: 'error', 
                message: result.error || 'Failed to update API Key'
            });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

/**
 * Update OpenAI Base URL in Cursor
 */
app.post('/api/cursor/openai/base-url', async (req, res) => {
    try {
        const { baseUrl, enabled } = req.body;
        
        if (baseUrl === undefined) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'baseUrl is required' 
            });
        }
        
        const result = enabled !== undefined 
            ? await setOpenAIBaseUrl(baseUrl, enabled)
            : await setOpenAIBaseUrl(baseUrl, true);
        
        if (result.success) {
            res.json({ 
                status: 'success', 
                message: 'OpenAI Base URL updated successfully'
            });
        } else {
            res.status(500).json({ 
                status: 'error', 
                message: result.error || 'Failed to update Base URL'
            });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

/**
 * Toggle OpenAI API Key enabled state
 */
app.post('/api/cursor/openai/toggle-api-key', async (req, res) => {
    try {
        const { enabled } = req.body;
        
        if (enabled === undefined) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'enabled is required' 
            });
        }
        
        const result = await toggleOpenAIApiKey(enabled);
        
        if (result.success) {
            res.json({ 
                status: 'success', 
                message: `OpenAI API Key ${enabled ? 'enabled' : 'disabled'}`
            });
        } else {
            res.status(500).json({ 
                status: 'error', 
                message: result.error || 'Failed to toggle API Key'
            });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

/**
 * Toggle OpenAI Base URL enabled state
 */
app.post('/api/cursor/openai/toggle-base-url', async (req, res) => {
    try {
        const { enabled } = req.body;
        
        if (enabled === undefined) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'enabled is required' 
            });
        }
        
        const result = await toggleOpenAIBaseUrl(enabled);
        
        if (result.success) {
            res.json({ 
                status: 'success', 
                message: `OpenAI Base URL ${enabled ? 'enabled' : 'disabled'}`
            });
        } else {
            res.status(500).json({ 
                status: 'error', 
                message: result.error || 'Failed to toggle Base URL'
            });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

/**
 * Dashboard API endpoint - provides all data needed for the frontend dashboard
 * Returns server status, API keys, ngrok status, and recent requests
 */
app.get('/api/dashboard', async (req, res) => {
    try {
        // Get server status
        let serverStatus = { status: 'initializing', accounts: null };
        try {
            await ensureInitialized();
            const status = accountManager.getStatus();
            serverStatus = {
                status: 'ok',
                accounts: {
                    summary: status.summary,
                    available: status.available,
                    rateLimited: status.rateLimited,
                    invalid: status.invalid,
                    total: status.available + status.rateLimited + status.invalid
                }
            };
        } catch (error) {
            serverStatus = { status: 'error', error: error.message };
        }

        // Get ngrok status (cached, refresh every 30 seconds)
        let ngrokStatus = { status: 'disconnected', url: null };
        const now = Date.now();
        
        // Use cache if still valid
        if (ngrokStatusCache && (now - ngrokStatusCacheTime) < NGROK_CACHE_TTL) {
            ngrokStatus = ngrokStatusCache;
        } else {
            // Fetch fresh ngrok status
            try {
                const ngrokResponse = await fetch('http://localhost:4040/api/tunnels', {
                    signal: AbortSignal.timeout(2000)
                });
                if (ngrokResponse.ok) {
                    const ngrokData = await ngrokResponse.json();
                    if (ngrokData.tunnels && ngrokData.tunnels.length > 0) {
                        // Prefer https tunnel
                        const httpsTunnel = ngrokData.tunnels.find(t => t.public_url.startsWith('https://'));
                        const tunnel = httpsTunnel || ngrokData.tunnels[0];
                        ngrokStatus = {
                            status: 'connected',
                            url: tunnel.public_url,
                            tunnels: ngrokData.tunnels.map(t => ({
                                name: t.name,
                                url: t.public_url,
                                proto: t.proto
                            }))
                        };
                    }
                }
            } catch (error) {
                // ngrok not running or not accessible
                ngrokStatus = { status: 'disconnected', url: null };
            }
            
            // Update cache
            ngrokStatusCache = ngrokStatus;
            ngrokStatusCacheTime = now;
        }

        // Calculate uptime
        const uptimeMs = Date.now() - serverStartTime;
        const uptimeSeconds = Math.floor(uptimeMs / 1000);
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const seconds = uptimeSeconds % 60;
        const uptime = `${hours}h ${minutes}m ${seconds}s`;

        // Get recent requests
        const recentRequests = getRequestHistory(50);

        res.json({
            server: {
                ...serverStatus,
                uptime,
                uptimeMs,
                startTime: new Date(serverStartTime).toISOString(),
                port: process.env.PORT || 8080
            },
            apiKey: serverApiKey,
            ngrok: ngrokStatus,
            requests: recentRequests,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Account limits endpoint - fetch quota/limits for all accounts × all models
 * Returns a table showing remaining quota and reset time for each combination
 * Use ?format=table for ASCII table output, default is JSON
 * Available at both /account-limits and /api/account-limits
 */
app.get(['/account-limits', '/api/account-limits'], async (req, res) => {
    try {
        await ensureInitialized();
        const allAccounts = accountManager.getAllAccounts();
        const format = req.query.format || 'json';

        // Fetch quotas for each account in parallel
        const results = await Promise.allSettled(
            allAccounts.map(async (account) => {
                // Skip invalid accounts
                if (account.isInvalid) {
                    return {
                        email: account.email,
                        status: 'invalid',
                        error: account.invalidReason,
                        models: {}
                    };
                }

                try {
                    const token = await accountManager.getTokenForAccount(account);
                    const quotas = await getModelQuotas(token);

                    return {
                        email: account.email,
                        status: 'ok',
                        models: quotas
                    };
                } catch (error) {
                    return {
                        email: account.email,
                        status: 'error',
                        error: error.message,
                        models: {}
                    };
                }
            })
        );

        // Process results
        const accountLimits = results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                return {
                    email: allAccounts[index].email,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error',
                    models: {}
                };
            }
        });

        // Collect all unique model IDs
        const allModelIds = new Set();
        for (const account of accountLimits) {
            for (const modelId of Object.keys(account.models || {})) {
                allModelIds.add(modelId);
            }
        }

        const sortedModels = Array.from(allModelIds).sort();

        // Return ASCII table format
        if (format === 'table') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');

            // Build table
            const lines = [];
            const timestamp = new Date().toLocaleString();
            lines.push(`Account Limits (${timestamp})`);

            // Get account status info
            const status = accountManager.getStatus();
            lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`);
            lines.push('');

            // Table 1: Account status
            const accColWidth = 25;
            const statusColWidth = 15;
            const lastUsedColWidth = 25;
            const resetColWidth = 25;

            let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
            lines.push(accHeader);
            lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

            for (const acc of status.accounts) {
                const shortEmail = acc.email.split('@')[0].slice(0, 22);
                const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';

                // Get status and error from accountLimits
                const accLimit = accountLimits.find(a => a.email === acc.email);
                let accStatus;
                if (acc.isInvalid) {
                    accStatus = 'invalid';
                } else if (acc.isRateLimited) {
                    const remaining = acc.rateLimitResetTime ? acc.rateLimitResetTime - Date.now() : 0;
                    accStatus = remaining > 0 ? `limited (${formatDuration(remaining)})` : 'rate-limited';
                } else {
                    accStatus = accLimit?.status || 'ok';
                }

                // Get reset time from quota API
                const claudeModel = sortedModels.find(m => m.includes('claude'));
                const quota = claudeModel && accLimit?.models?.[claudeModel];
                const resetTime = quota?.resetTime
                    ? new Date(quota.resetTime).toLocaleString()
                    : '-';

                let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                // Add error on next line if present
                if (accLimit?.error) {
                    lines.push(row);
                    lines.push('  └─ ' + accLimit.error);
                } else {
                    lines.push(row);
                }
            }
            lines.push('');

            // Calculate column widths
            const modelColWidth = Math.max(25, ...sortedModels.map(m => m.length)) + 2;
            const accountColWidth = 22;

            // Header row
            let header = 'Model'.padEnd(modelColWidth);
            for (const acc of accountLimits) {
                const shortEmail = acc.email.split('@')[0].slice(0, 18);
                header += shortEmail.padEnd(accountColWidth);
            }
            lines.push(header);
            lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

            // Data rows
            for (const modelId of sortedModels) {
                let row = modelId.padEnd(modelColWidth);
                for (const acc of accountLimits) {
                    const quota = acc.models?.[modelId];
                    let cell;
                    if (acc.status !== 'ok') {
                        cell = `[${acc.status}]`;
                    } else if (!quota) {
                        cell = '-';
                    } else if (quota.remainingFraction === null) {
                        cell = '0% (exhausted)';
                    } else {
                        const pct = Math.round(quota.remainingFraction * 100);
                        cell = `${pct}%`;
                    }
                    row += cell.padEnd(accountColWidth);
                }
                lines.push(row);
            }

            return res.send(lines.join('\n'));
        }

        // Default: JSON format
        res.json({
            timestamp: new Date().toLocaleString(),
            totalAccounts: allAccounts.length,
            models: sortedModels,
            accounts: accountLimits.map(acc => ({
                email: acc.email,
                status: acc.status,
                error: acc.error || null,
                limits: Object.fromEntries(
                    sortedModels.map(modelId => {
                        const quota = acc.models?.[modelId];
                        if (!quota) {
                            return [modelId, null];
                        }
                        return [modelId, {
                            remaining: quota.remainingFraction !== null
                                ? `${Math.round(quota.remainingFraction * 100)}%`
                                : 'N/A',
                            remainingFraction: quota.remainingFraction,
                            resetTime: quota.resetTime || null
                        }];
                    })
                )
            }))
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * Force token refresh endpoint
 */
app.post('/refresh-token', async (req, res) => {
    try {
        await ensureInitialized();
        // Clear all caches
        accountManager.clearTokenCache();
        accountManager.clearProjectCache();
        // Force refresh default token
        const token = await forceRefresh();
        res.json({
            status: 'ok',
            message: 'Token caches cleared and refreshed',
            tokenPrefix: token.substring(0, 10) + '...'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * Regenerate API key endpoint
 */
app.post('/api/regenerate-api-key', (req, res) => {
    try {
        const newKey = regenerateApiKey();
        serverApiKey = newKey; // Update in-memory key
        
        res.json({
            status: 'success',
            message: 'API key regenerated successfully',
            apiKey: newKey
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
app.get('/v1/models', async (req, res) => {
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
app.post('/v1/messages/count_tokens', (req, res) => {
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
app.post('/v1/messages', async (req, res) => {
    const requestStartTime = Date.now();
    const requestId = crypto.randomUUID();
    let requestStatus = 'pending';
    let requestError = null;
    
    try {
        // Ensure account manager is initialized
        await ensureInitialized();

        // Optimistic Retry: If ALL accounts are rate-limited, reset them to force a fresh check.
        // If we have some available accounts, we try them first.
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
                totalToolTokens += nameTokens + descTokens + schemaTokens + 10; // +10 overhead
            }
            toolInfo = {
                count: tools.length,
                tokens: totalToolTokens,
                names: toolNames.slice(0, 10) // First 10 tool names
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
        // This will give us the FILTERED tool count and tokens
        const { toolMetadata } = await import('./format/request-converter.js').then(m => {
            const result = m.convertAnthropicToGoogle(request);
            return result;
        });
        
        // Override toolInfo with filtered data if available
        if (toolMetadata) {
            toolInfo = {
                count: toolMetadata.filteredCount,
                tokens: toolMetadata.filteredTokens,
                names: toolMetadata.toolNames
            };
        }

        // Removed verbose logging - only log errors

        // Debug: Log message structure to diagnose tool_use/tool_result ordering
        if (process.env.DEBUG) {
            console.log('[API] Message structure:');
            messages.forEach((msg, i) => {
                const contentTypes = Array.isArray(msg.content)
                    ? msg.content.map(c => c.type || 'text').join(', ')
                    : (typeof msg.content === 'string' ? 'text' : 'unknown');
                console.log(`  [${i}] ${msg.role}: ${contentTypes}`);
            });
        }

        if (stream) {
            // Handle streaming response
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            // Flush headers immediately to start the stream
            res.flushHeaders();

            try {
                // Track usage from streaming events
                let streamUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0
                };
                
                // Track content blocks for debugging
                const contentBlocks = [];
                let currentBlockIndex = -1;

                // Use the streaming generator with account manager
                for await (const event of sendMessageStream(request, accountManager)) {
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    // Flush after each event for real-time streaming
                    if (res.flush) res.flush();

                    // Capture usage from message_start and message_delta events
                    if (event.type === 'message_start' && event.message?.usage) {
                        streamUsage.input_tokens = event.message.usage.input_tokens || 0;
                        streamUsage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
                        streamUsage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens || 0;
                    }
                    if (event.type === 'message_delta' && event.usage) {
                        streamUsage.output_tokens = event.usage.output_tokens || 0;
                    }
                    
                    // Track content blocks for debugging
                    if (event.type === 'content_block_start') {
                        currentBlockIndex = event.index;
                        contentBlocks[currentBlockIndex] = {
                            type: event.content_block?.type,
                            name: event.content_block?.name,
                            hasSignature: false,
                            text: ''
                        };
                        
                        // Check for thinking signature
                        if (event.content_block?.type === 'thinking' && event.content_block?.signature) {
                            contentBlocks[currentBlockIndex].hasSignature = 
                                event.content_block.signature !== 'gemini-thinking-no-signature';
                        }
                    }
                    
                    if (event.type === 'content_block_delta' && currentBlockIndex >= 0) {
                        if (event.delta?.text) {
                            contentBlocks[currentBlockIndex].text += event.delta.text;
                        }
                    }
                }
                res.end();
                
                // Debug log the streamed content
                if (contentBlocks.length > 0) {
                    const contentSummary = contentBlocks.map((block, i) => {
                        if (block.type === 'thinking') {
                            return `thinking(sig:${block.hasSignature ? 'yes' : 'no'})`;
                        }
                        if (block.type === 'tool_use') {
                            return `tool_use(${block.name || 'unknown'})`;
                        }
                        if (block.type === 'text') {
                            const preview = block.text.slice(0, 50).replace(/\n/g, ' ');
                            return `text("${preview}${block.text.length > 50 ? '...' : ''}")`;
                        }
                        return block.type || 'unknown';
                    });
                    
                    console.log(`[Server] Streamed response for ${request.model}: [${contentSummary.join(', ')}]`);
                    
                    // Check for loop indicators
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
                
                // Track successful streaming request with token usage
                const duration = Date.now() - requestStartTime;
                addRequestToHistory({
                    id: requestId,
                    method: req.method,
                    path: req.path,
                    status: 'success',
                    model: request.model,
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
                
                // Track failed streaming request
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
            const response = await sendMessage(request, accountManager);
            
            // Debug log the response
            logResponseForDebug(response, request.model);
            
            res.json(response);
            
            // Track successful non-streaming request with token usage
            const duration = Date.now() - requestStartTime;
            const usage = response.usage || {};
            addRequestToHistory({
                id: requestId,
                method: req.method,
                path: req.path,
                status: 'success',
                model: request.model,
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

        // For auth errors, try to refresh token
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

        console.log(`[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

        // Check if headers have already been sent (for streaming that failed mid-way)
        if (res.headersSent) {
            console.log('[API] Headers already sent, writing error as SSE event');
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
        
        // Track failed request
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

/**
 * OpenAI-compatible Chat Completions endpoint
 * Converts OpenAI format to Anthropic format and back
 */
app.post('/chat/completions', async (req, res) => {
    const requestStartTime = Date.now();
    const requestId = crypto.randomUUID();
    
    try {
        // Ensure account manager is initialized
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
        // This will give us the FILTERED tool count and tokens
        const { toolMetadata } = await import('./format/request-converter.js').then(m => {
            const result = m.convertAnthropicToGoogle(anthropicRequest);
            return result;
        });
        
        // Override toolInfo with filtered data if available
        if (toolMetadata) {
            toolInfo = {
                count: toolMetadata.filteredCount,
                tokens: toolMetadata.filteredTokens,
                names: toolMetadata.toolNames
            };
        }
        
        // Removed verbose logging - only log errors

        if (stream) {
            // Handle streaming response (OpenAI format)
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            try {
                let messageId = 'chatcmpl-' + Date.now();
                let streamUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0
                };

                for await (const event of sendMessageStream(anthropicRequest, accountManager)) {
                    // Extract message ID from message_start event
                    if (event.type === 'message_start' && event.message?.id) {
                        messageId = event.message.id;
                    }

                    // Capture usage from message_start and message_delta events
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
                    stream: true,
                    duration,
                    timestamp: new Date().toISOString(),
                    usage: streamUsage,
                    tools: toolInfo
                });

            } catch (streamError) {
                console.error('[API] OpenAI stream error:', streamError);
                const { errorType, errorMessage } = parseError(streamError);
                res.write(`data: ${JSON.stringify({
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
                
                // Track failed streaming request
                const duration = Date.now() - requestStartTime;
                addRequestToHistory({
                    id: requestId,
                    method: req.method,
                    path: req.path,
                    status: 'error',
                    error: errorMessage,
                    model: model || anthropicRequest.model,
                    stream: true,
                    duration,
                    timestamp: new Date().toISOString()
                });
            }

        } else {
            // Handle non-streaming response
            const anthropicResponse = await sendMessage(anthropicRequest, accountManager);
            const openaiResponse = convertAnthropicToOpenAI(anthropicResponse, model || anthropicRequest.model);
            res.json(openaiResponse);
            
            // Track successful non-streaming request
            const duration = Date.now() - requestStartTime;
            const usage = anthropicResponse.usage || {};
            addRequestToHistory({
                id: requestId,
                method: req.method,
                path: req.path,
                status: 'success',
                model: model || anthropicRequest.model,
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

        // For auth errors, try to refresh token
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
            res.write(`data: ${JSON.stringify({
                error: { type: errorType, message: errorMessage }
            })}\n\n`);
            res.end();
        } else {
            res.status(statusCode).json({
                error: {
                    type: errorType,
                    message: errorMessage
                }
            });
        }
        
        // Track failed request
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

/**
 * Catch-all for unsupported endpoints
 */
app.use('*', (req, res) => {
    res.status(404).json({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
    });
});

export default app;
