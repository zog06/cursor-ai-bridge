/**
 * Routes Index
 * Combines all route modules and exports a single setup function
 */

import { createHealthRouter } from './health.js';
import { createNgrokRouter } from './ngrok.js';
import { createCursorRouter } from './cursor.js';
import { createDashboardRouter } from './dashboard.js';
import { createAuthRouter } from './auth.js';
import { createAccountsRouter } from './accounts.js';
import { createMessagesRouter } from './messages.js';
import { createChatCompletionsRouter } from './chat-completions.js';

/**
 * Setup all routes on the Express app
 * @param {Express} app - Express application
 * @param {AccountManager} accountManager - Account manager instance
 * @param {Function} ensureInitialized - Function to ensure initialization
 * @param {number} serverStartTime - Server start timestamp
 */
export function setupRoutes(app, accountManager, ensureInitialized, serverStartTime) {
    // Health check
    app.use(createHealthRouter(accountManager, ensureInitialized));

    // ngrok control
    app.use(createNgrokRouter());

    // Cursor settings
    app.use(createCursorRouter());

    // Dashboard API
    app.use(createDashboardRouter(accountManager, ensureInitialized, serverStartTime));

    // OAuth authentication
    app.use(createAuthRouter(accountManager));

    // Account management
    app.use(createAccountsRouter(accountManager, ensureInitialized));

    // Anthropic Messages API
    app.use(createMessagesRouter(accountManager, ensureInitialized));

    // OpenAI Chat Completions API
    app.use(createChatCompletionsRouter(accountManager, ensureInitialized));

    // Catch-all for unsupported endpoints
    app.use('*', (req, res) => {
        res.status(404).json({
            type: 'error',
            error: {
                type: 'not_found_error',
                message: `Endpoint ${req.method} ${req.originalUrl} not found`
            }
        });
    });
}
