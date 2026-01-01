/**
 * Cursor IDE Settings Manager
 * Reads and writes Cursor settings.json file and state.vscdb SQLite database
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';
import Database from 'better-sqlite3';

/**
 * Get Cursor settings file path based on platform
 */
function getCursorSettingsPath() {
    const home = homedir();
    switch (platform()) {
        case 'darwin':
            return join(home, 'Library/Application Support/Cursor/User/settings.json');
        case 'win32':
            return join(home, 'AppData/Roaming/Cursor/User/settings.json');
        default: // linux, etc.
            return join(home, '.config/Cursor/User/settings.json');
    }
}

/**
 * Get Cursor state.vscdb file path based on platform
 */
function getCursorStateDbPath() {
    const home = homedir();
    switch (platform()) {
        case 'darwin':
            return join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
        case 'win32':
            return join(home, 'AppData/Roaming/Cursor/User/globalStorage/state.vscdb');
        default: // linux, etc.
            return join(home, '.config/Cursor/User/globalStorage/state.vscdb');
    }
}

/**
 * Key used in state.vscdb ItemTable
 */
const STATE_DB_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const OPENAI_KEY_DB_KEY = 'cursorAuth/openAIKey';

/**
 * Read application user data from state.vscdb
 */
export async function readCursorStateDb() {
    const dbPath = getCursorStateDbPath();
    
    try {
        if (!existsSync(dbPath)) {
            return { exists: false, data: null, path: dbPath };
        }

        const db = new Database(dbPath, { readonly: true });
        
        try {
            const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STATE_DB_KEY);
            
            if (!row) {
                db.close();
                return { exists: true, data: null, path: dbPath };
            }

            const data = JSON.parse(row.value);
            db.close();
            
            return {
                exists: true,
                data,
                path: dbPath
            };
        } catch (error) {
            db.close();
            throw error;
        }
    } catch (error) {
        return {
            exists: false,
            error: error.message,
            path: dbPath
        };
    }
}

/**
 * Write application user data to state.vscdb
 */
export async function writeCursorStateDb(data) {
    const dbPath = getCursorStateDbPath();
    
    try {
        if (!existsSync(dbPath)) {
            return {
                success: false,
                error: 'Database file does not exist',
                path: dbPath
            };
        }

        const db = new Database(dbPath);
        
        try {
            const jsonValue = JSON.stringify(data);
            
            // Check if key exists
            const existing = db.prepare('SELECT key FROM ItemTable WHERE key = ?').get(STATE_DB_KEY);
            
            if (existing) {
                // Update existing row
                db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(jsonValue, STATE_DB_KEY);
            } else {
                // Insert new row
                db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(STATE_DB_KEY, jsonValue);
            }
            
            db.close();
            
            return {
                success: true,
                path: dbPath
            };
        } catch (error) {
            db.close();
            throw error;
        }
    } catch (error) {
        return {
            success: false,
            error: error.message,
            path: dbPath
        };
    }
}

/**
 * Get OpenAI API Key from state.vscdb ItemTable
 * Key is stored directly as 'cursorAuth/openAIKey'
 */
export async function getOpenAIApiKeyFromStateDb() {
    const dbPath = getCursorStateDbPath();
    
    try {
        if (!existsSync(dbPath)) {
            return null;
        }

        const db = new Database(dbPath, { readonly: true });
        
        try {
            const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(OPENAI_KEY_DB_KEY);
            db.close();
            
            if (!row || !row.value) {
                return null;
            }
            
            // Value is stored directly as the API key string
            // Return null if empty string
            const apiKey = row.value.trim();
            return apiKey === '' ? null : apiKey;
        } catch (error) {
            db.close();
            return null;
        }
    } catch (error) {
        return null;
    }
}

/**
 * Set OpenAI API Key in state.vscdb ItemTable
 * Key is stored directly as 'cursorAuth/openAIKey'
 * If apiKey is null, the key is deleted from ItemTable
 */
export async function setOpenAIApiKeyInStateDb(apiKey) {
    const dbPath = getCursorStateDbPath();
    
    try {
        if (!existsSync(dbPath)) {
            return {
                success: false,
                error: 'Database file does not exist',
                path: dbPath
            };
        }

        const db = new Database(dbPath);
        
        try {
            // Check if key exists
            const existing = db.prepare('SELECT key FROM ItemTable WHERE key = ?').get(OPENAI_KEY_DB_KEY);
            
            if (apiKey === null || apiKey === undefined || apiKey === '') {
                // If apiKey is null/empty, delete the key
                if (existing) {
                    db.prepare('DELETE FROM ItemTable WHERE key = ?').run(OPENAI_KEY_DB_KEY);
                }
            } else {
                // Set the apiKey value
                if (existing) {
                    // Update existing row - value is stored directly as string
                    db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(apiKey, OPENAI_KEY_DB_KEY);
                } else {
                    // Insert new row - value is stored directly as string
                    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(OPENAI_KEY_DB_KEY, apiKey);
                }
            }
            
            db.close();
            
            return {
                success: true,
                path: dbPath
            };
        } catch (error) {
            db.close();
            throw error;
        }
    } catch (error) {
        return {
            success: false,
            error: error.message,
            path: dbPath
        };
    }
}

/**
 * Get OpenAI Base URL from state.vscdb
 */
export async function getOpenAIBaseUrlFromStateDb() {
    const result = await readCursorStateDb();
    
    if (!result.exists || !result.data) {
        return null;
    }
    
    return result.data.openAIBaseUrl || null;
}

/**
 * Set OpenAI Base URL in state.vscdb
 */
export async function setOpenAIBaseUrlInStateDb(baseUrl) {
    const result = await readCursorStateDb();
    
    if (!result.exists) {
        return {
            success: false,
            error: 'Database file does not exist or cannot be read'
        };
    }
    
    // If data doesn't exist, create a new object
    const data = result.data || {};
    
    // Update the openAIBaseUrl
    data.openAIBaseUrl = baseUrl;
    
    // Write back to database
    return await writeCursorStateDb(data);
}

/**
 * Read Cursor settings
 */
export async function readCursorSettings() {
    const settingsPath = getCursorSettingsPath();
    
    try {
        if (!existsSync(settingsPath)) {
            return { exists: false, settings: null, path: settingsPath };
        }

        const content = await readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        
        return {
            exists: true,
            settings,
            path: settingsPath
        };
    } catch (error) {
        return {
            exists: false,
            error: error.message,
            path: settingsPath
        };
    }
}

/**
 * Write Cursor settings
 */
export async function writeCursorSettings(settings) {
    const settingsPath = getCursorSettingsPath();
    
    try {
        // Ensure directory exists
        await mkdir(dirname(settingsPath), { recursive: true });
        
        // Read existing settings if file exists
        let existingSettings = {};
        if (existsSync(settingsPath)) {
            try {
                const content = await readFile(settingsPath, 'utf-8');
                existingSettings = JSON.parse(content);
            } catch (error) {
                // If file is corrupted, start fresh
                console.warn('[CursorSettings] Failed to read existing settings, starting fresh');
            }
        }
        
        // Merge settings
        const mergedSettings = {
            ...existingSettings,
            ...settings
        };
        
        // Write settings
        await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf-8');
        
        return {
            success: true,
            path: settingsPath
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            path: settingsPath
        };
    }
}

/**
 * Configure Cursor to use proxy
 */
export async function configureCursorForProxy(apiKey, baseUrl, model = 'claude-sonnet-4-5-thinking') {
    const modelConfig = {
        id: 'antigravity-claude-proxy',
        name: 'Antigravity Claude (Proxy)',
        provider: 'openai',
        model: model,
        apiKey: apiKey,
        baseUrl: baseUrl
    };
    
    const { settings: existingSettings } = await readCursorSettings();
    const aiModels = existingSettings?.cursor?.aiModels || [];
    
    // Remove existing proxy model if exists
    const filteredModels = aiModels.filter(m => m.id !== 'antigravity-claude-proxy');
    
    // Add new proxy model
    filteredModels.push(modelConfig);
    
    return await writeCursorSettings({
        cursor: {
            ...existingSettings?.cursor,
            aiModels: filteredModels
        }
    });
}

/**
 * Remove proxy configuration from Cursor
 */
export async function removeCursorProxyConfig() {
    const { settings: existingSettings } = await readCursorSettings();
    
    if (!existingSettings?.cursor?.aiModels) {
        return { success: true, message: 'No proxy config found' };
    }
    
    const aiModels = existingSettings.cursor.aiModels.filter(
        m => m.id !== 'antigravity-claude-proxy'
    );
    
    return await writeCursorSettings({
        cursor: {
            ...existingSettings.cursor,
            aiModels: aiModels
        }
    });
}

/**
 * Check if proxy is configured in Cursor
 */
export async function isProxyConfigured() {
    const { settings } = await readCursorSettings();
    
    if (!settings?.cursor?.aiModels) {
        return false;
    }
    
    return settings.cursor.aiModels.some(m => m.id === 'antigravity-claude-proxy');
}

/**
 * Get OpenAI API Key and Base URL from Cursor settings
 * Checks both settings.json and state.vscdb
 * apiKeyEnabled: true if state.vscdb has cursorAuth/openAIKey and it's not null
 * baseUrlEnabled: true if state.vscdb has openAIBaseUrl and it's not null
 */
export async function getOpenAISettings() {
    const { settings } = await readCursorSettings();
    
    // Try to get apiKey from state.vscdb first (cursorAuth/openAIKey)
    const stateDbApiKey = await getOpenAIApiKeyFromStateDb();
    
    // Try to get baseUrl from state.vscdb first
    const stateDbBaseUrl = await getOpenAIBaseUrlFromStateDb();
    
    // apiKeyEnabled: true if state.vscdb has cursorAuth/openAIKey and it's not null
    // This is the source of truth - if it exists in state.vscdb, it's enabled
    const apiKeyEnabled = stateDbApiKey !== null && stateDbApiKey !== undefined && stateDbApiKey !== '';
    
    // baseUrlEnabled: true if state.vscdb has openAIBaseUrl and it's not null
    // This is the source of truth - if it exists in state.vscdb, it's enabled
    const baseUrlEnabled = stateDbBaseUrl !== null && stateDbBaseUrl !== undefined;
    
    if (!settings) {
        return {
            apiKey: stateDbApiKey,
            baseUrl: stateDbBaseUrl,
            apiKeyEnabled: apiKeyEnabled,
            baseUrlEnabled: baseUrlEnabled
        };
    }
    
    // Prefer state.vscdb values over settings.json
    const apiKey = stateDbApiKey || settings['cursor.openai.apiKey'] || settings['openai.apiKey'] || null;
    const baseUrl = stateDbBaseUrl || settings['cursor.openai.baseUrl'] || settings['openai.baseUrl'] || null;
    
    return {
        apiKey,
        baseUrl,
        apiKeyEnabled,
        baseUrlEnabled
    };
}

/**
 * Set OpenAI API Key in Cursor settings
 * Updates both state.vscdb (cursorAuth/openAIKey) and settings.json
 */
export async function setOpenAIApiKey(apiKey, enabled = true) {
    // Update state.vscdb (primary storage) - cursorAuth/openAIKey
    const stateDbResult = enabled 
        ? await setOpenAIApiKeyInStateDb(apiKey)
        : await setOpenAIApiKeyInStateDb(null);
    
    // Also update settings.json for compatibility
    const { settings: existingSettings } = await readCursorSettings();
    const settingsResult = await writeCursorSettings({
        ...existingSettings,
        'cursor.openai.apiKey': apiKey,
        'cursor.openai.apiKey.enabled': enabled
    });
    
    // Return success if at least state.vscdb update succeeded
    if (stateDbResult.success) {
        return {
            success: true,
            path: stateDbResult.path,
            settingsPath: settingsResult.path
        };
    } else {
        return {
            success: false,
            error: stateDbResult.error || 'Failed to update state.vscdb',
            path: stateDbResult.path
        };
    }
}

/**
 * Set OpenAI Base URL in Cursor settings
 * Updates both settings.json and state.vscdb
 * Also updates baseUrl in cursor.aiModels array if models exist
 */
export async function setOpenAIBaseUrl(baseUrl, enabled = true) {
    // Update state.vscdb (primary storage)
    const stateDbResult = await setOpenAIBaseUrlInStateDb(baseUrl);
    
    // Also update settings.json for compatibility
    const { settings: existingSettings } = await readCursorSettings();
    
    // Update cursor.aiModels array if it exists
    let updatedSettings = {
        ...existingSettings,
        'cursor.openai.baseUrl': baseUrl,
        'cursor.openai.baseUrl.enabled': enabled
    };
    
    // Update baseUrl in cursor.aiModels array
    if (existingSettings?.cursor?.aiModels && Array.isArray(existingSettings.cursor.aiModels)) {
        const updatedAiModels = existingSettings.cursor.aiModels.map(model => {
            // Update baseUrl for all models that have a baseUrl property
            // Especially update antigravity-claude-proxy model
            if (model.baseUrl !== undefined || model.id === 'antigravity-claude-proxy') {
                return {
                    ...model,
                    baseUrl: baseUrl
                };
            }
            return model;
        });
        
        updatedSettings = {
            ...updatedSettings,
            cursor: {
                ...existingSettings.cursor,
                aiModels: updatedAiModels
            }
        };
    }
    
    const settingsResult = await writeCursorSettings(updatedSettings);
    
    // Return success if at least state.vscdb update succeeded
    if (stateDbResult.success) {
        return {
            success: true,
            path: stateDbResult.path,
            settingsPath: settingsResult.path
        };
    } else {
        return {
            success: false,
            error: stateDbResult.error || 'Failed to update state.vscdb',
            path: stateDbResult.path
        };
    }
}

/**
 * Enable or disable OpenAI API Key
 * If disabled, sets cursorAuth/openAIKey to null in state.vscdb
 * If enabled, restores cursorAuth/openAIKey from settings.json to state.vscdb if it doesn't exist
 */
export async function toggleOpenAIApiKey(enabled) {
    const { settings: existingSettings } = await readCursorSettings();
    
    // Update state.vscdb based on enabled state
    if (enabled) {
        // If enabling, restore apiKey from settings.json if state.vscdb doesn't have it
        const stateDbApiKey = await getOpenAIApiKeyFromStateDb();
        if (!stateDbApiKey) {
            const settingsApiKey = existingSettings?.['cursor.openai.apiKey'] || existingSettings?.['openai.apiKey'];
            if (settingsApiKey) {
                await setOpenAIApiKeyInStateDb(settingsApiKey);
            }
        }
        // If state.vscdb already has apiKey, keep it as is
    } else {
        // If disabling, set cursorAuth/openAIKey to null in state.vscdb
        await setOpenAIApiKeyInStateDb(null);
    }
    
    // Also update settings.json flag
    return await writeCursorSettings({
        ...existingSettings,
        'cursor.openai.apiKey.enabled': enabled
    });
}

/**
 * Enable or disable OpenAI Base URL
 * If disabled, sets openAIBaseUrl to null in state.vscdb
 * If enabled, restores openAIBaseUrl from settings.json to state.vscdb if it doesn't exist
 */
export async function toggleOpenAIBaseUrl(enabled) {
    const { settings: existingSettings } = await readCursorSettings();
    
    // Update state.vscdb based on enabled state
    const stateDbResult = await readCursorStateDb();
    
    if (stateDbResult.exists) {
        const data = stateDbResult.data || {};
        
        if (enabled) {
            // If enabling, restore baseUrl from settings.json if state.vscdb doesn't have it
            if (!data.openAIBaseUrl) {
                const settingsBaseUrl = existingSettings?.['cursor.openai.baseUrl'] || existingSettings?.['openai.baseUrl'];
                if (settingsBaseUrl) {
                    data.openAIBaseUrl = settingsBaseUrl;
                    await writeCursorStateDb(data);
                }
            }
            // If state.vscdb already has openAIBaseUrl, keep it as is
        } else {
            // If disabling, set openAIBaseUrl to null in state.vscdb
            data.openAIBaseUrl = null;
            await writeCursorStateDb(data);
        }
    }
    
    // Also update settings.json flag
    return await writeCursorSettings({
        ...existingSettings,
        'cursor.openai.baseUrl.enabled': enabled
    });
}