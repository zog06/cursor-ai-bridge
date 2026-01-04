/**
 * Cursor Settings Routes
 */

import { Router } from 'express';
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
} from '../cursor-settings.js';

export function createCursorRouter() {
    const router = Router();

    router.get('/api/cursor/settings', async (req, res) => {
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

    router.post('/api/cursor/configure', async (req, res) => {
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

    router.post('/api/cursor/remove', async (req, res) => {
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

    router.post('/api/cursor/openai/api-key', async (req, res) => {
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

    router.post('/api/cursor/openai/base-url', async (req, res) => {
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

    router.post('/api/cursor/openai/toggle-api-key', async (req, res) => {
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

    router.post('/api/cursor/openai/toggle-base-url', async (req, res) => {
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

    return router;
}
