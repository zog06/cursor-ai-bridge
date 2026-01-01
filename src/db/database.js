/**
 * SQLite Database Access Module
 * Provides cross-platform database operations for Antigravity state.
 *
 * Uses better-sqlite3 for:
 * - Windows compatibility (no CLI dependency)
 * - Native performance
 * - Synchronous API (simple error handling)
 */

import Database from 'better-sqlite3';
import { ANTIGRAVITY_DB_PATH } from '../constants.js';

/**
 * Query Antigravity database for authentication status
 * @param {string} [dbPath] - Optional custom database path
 * @returns {Object} Parsed auth data with apiKey, email, name, etc.
 * @throws {Error} If database doesn't exist, query fails, or no auth status found
 */
export function getAuthStatus(dbPath = ANTIGRAVITY_DB_PATH) {
    let db;
    try {
        // Open database in read-only mode
        db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true
        });

        // Prepare and execute query
        const stmt = db.prepare(
            "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'"
        );
        const row = stmt.get();

        if (!row || !row.value) {
            throw new Error('No auth status found in database');
        }

        // Parse JSON value
        const authData = JSON.parse(row.value);

        if (!authData.apiKey) {
            throw new Error('Auth data missing apiKey field');
        }

        return authData;
    } catch (error) {
        // Enhance error messages for common issues
        if (error.code === 'SQLITE_CANTOPEN') {
            throw new Error(
                `Database not found at ${dbPath}. ` +
                'Make sure Antigravity is installed and you are logged in.'
            );
        }
        // Re-throw with context if not already our error
        if (error.message.includes('No auth status') || error.message.includes('missing apiKey')) {
            throw error;
        }
        throw new Error(`Failed to read Antigravity database: ${error.message}`);
    } finally {
        // Always close database connection
        if (db) {
            db.close();
        }
    }
}

/**
 * Check if database exists and is accessible
 * @param {string} [dbPath] - Optional custom database path
 * @returns {boolean} True if database exists and can be opened
 */
export function isDatabaseAccessible(dbPath = ANTIGRAVITY_DB_PATH) {
    let db;
    try {
        db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true
        });
        return true;
    } catch {
        return false;
    } finally {
        if (db) {
            db.close();
        }
    }
}

export default {
    getAuthStatus,
    isDatabaseAccessible
};
