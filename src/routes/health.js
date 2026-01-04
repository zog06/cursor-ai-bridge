/**
 * Health Check Route
 */

import { Router } from 'express';

export function createHealthRouter(accountManager, ensureInitialized) {
    const router = Router();

    router.get('/health', async (req, res) => {
        try {
            await ensureInitialized();
            const status = accountManager.getStatus();

            res.json({
                status: 'ok',
                accounts: status.summary,
                available: status.available,
                rateLimited: status.rateLimited,
                disabled: status.disabled,
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

    return router;
}
