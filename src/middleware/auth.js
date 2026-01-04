/**
 * Authentication Middleware
 * API Key authentication for protected endpoints
 */

import { getApiKey } from '../services/api-key.js';

/**
 * API Key authentication middleware
 * Checks for API key in Authorization header (Bearer token) or x-api-key header
 * Health check and dashboard endpoints are excluded from authentication
 */
export function authenticateApiKey(req, res, next) {
    // Skip authentication for health check, dashboard API, ngrok control, and cursor settings endpoints
    if (req.path === '/health' ||
        req.path === '/api/dashboard' ||
        req.path === '/api/account-limits' ||
        req.path === '/account-limits' ||
        req.path === '/api/regenerate-api-key' ||
        req.path.startsWith('/api/accounts/') ||
        req.path.startsWith('/api/ngrok/') ||
        req.path.startsWith('/api/cursor/') ||
        req.path.startsWith('/api/auth/')) {
        return next();
    }

    const serverApiKey = getApiKey();

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
