/**
 * Dashboard API Route
 */

import { Router } from 'express';
import { getRequestHistory } from '../services/request-history.js';
import { getApiKey } from '../services/api-key.js';

// Ngrok status cache (30 seconds TTL)
let ngrokStatusCache = null;
let ngrokStatusCacheTime = 0;
const NGROK_CACHE_TTL = 30000; // 30 seconds

export function createDashboardRouter(accountManager, ensureInitialized, serverStartTime) {
    const router = Router();

    router.get('/api/dashboard', async (req, res) => {
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
                        disabled: status.disabled,
                        invalid: status.invalid,
                        total: status.total,
                        details: status.accounts
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
                apiKey: getApiKey(),
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

    return router;
}
