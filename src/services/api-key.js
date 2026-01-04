/**
 * API Key Management Service
 * Handles generation, loading, and regeneration of API keys
 */

import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { API_KEY, API_KEY_PATH } from '../constants.js';

let serverApiKey = null;

/**
 * Load API key from file or generate new one
 */
export function loadOrGenerateApiKey() {
    // First priority: environment variable
    if (API_KEY) {
        console.log('[Server] Using API key from environment variable');
        serverApiKey = API_KEY;
        return API_KEY;
    }

    // Second priority: load from file
    if (existsSync(API_KEY_PATH)) {
        try {
            const savedKey = readFileSync(API_KEY_PATH, 'utf8').trim();
            if (savedKey && savedKey.startsWith('ag_')) {
                console.log('[Server] Loaded API key from file');
                serverApiKey = savedKey;
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

    serverApiKey = newKey;
    return newKey;
}

/**
 * Regenerate API key and save to file
 */
export function regenerateApiKey() {
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

    serverApiKey = newKey;
    return newKey;
}

/**
 * Get current API key
 */
export function getApiKey() {
    return serverApiKey;
}

/**
 * Set API key (used when regenerating)
 */
export function setApiKey(key) {
    serverApiKey = key;
}
