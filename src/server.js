/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 * 
 * Refactored to modular structure - routes are in ./routes/
 */

import express from 'express';
import cors from 'cors';
import { REQUEST_BODY_LIMIT } from './constants.js';
import { AccountManager } from './account-manager.js';
import { loadOrGenerateApiKey } from './services/api-key.js';
import { authenticateApiKey } from './middleware/auth.js';
import { setupRoutes } from './routes/index.js';

const app = express();

// Initialize account manager
const accountManager = new AccountManager();

// Generate or load API key
loadOrGenerateApiKey();

// Track initialization status
let isInitialized = false;
let initError = null;
let initPromise = null;

// Server start time for uptime calculation
const serverStartTime = Date.now();

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

// Apply authentication middleware
app.use(authenticateApiKey);

// Setup all routes
setupRoutes(app, accountManager, ensureInitialized, serverStartTime);

export default app;
