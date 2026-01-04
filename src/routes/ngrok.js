/**
 * ngrok Control Routes
 */

import { Router } from 'express';
import { startNgrok, stopNgrok, getCurrentNgrokUrl } from '../ngrok-manager.js';

export function createNgrokRouter() {
    const router = Router();

    router.post('/api/ngrok/start', async (req, res) => {
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

    router.post('/api/ngrok/stop', async (req, res) => {
        try {
            stopNgrok();
            res.json({ status: 'success', message: 'ngrok tunnel stopped' });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    router.get('/api/ngrok/status', async (req, res) => {
        try {
            const currentUrl = getCurrentNgrokUrl();
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

    return router;
}
