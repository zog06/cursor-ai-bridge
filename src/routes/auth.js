/**
 * OAuth Authentication Routes
 */

import { Router } from 'express';
import { getAuthorizationUrl, startCallbackServer, completeOAuthFlow } from '../oauth.js';

export function createAuthRouter(accountManager) {
    const router = Router();

    /**
     * Start OAuth flow for adding a Google account
     */
    router.get('/api/auth/start', async (req, res) => {
        try {
            // Generate auth URL and state
            const { url, verifier, state } = getAuthorizationUrl();

            // Start background callback server
            // We don't await this because it blocks until the user logs in
            // Instead, we set up the promise chain to handle the result
            startCallbackServer(state)
                .then(async (code) => {
                    console.log('[Server] Received OAuth code, exchanging for tokens...');
                    try {
                        const result = await completeOAuthFlow(code, verifier);

                        // Add to account manager
                        await accountManager.addAccount({
                            email: result.email,
                            refreshToken: result.refreshToken,
                            projectId: result.projectId
                        });

                        console.log(`[Server] Successfully added account: ${result.email}`);
                    } catch (error) {
                        console.error('[Server] Failed to complete OAuth flow:', error.message);
                    }
                })
                .catch(error => {
                    // Timeout or server error
                    console.error('[Server] OAuth callback server error:', error.message);
                });

            res.json({
                status: 'success',
                url: url
            });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}
