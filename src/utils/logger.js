
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, '../../logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (err) {
        console.error('[Logger] Failed to create logs directory:', err);
    }
}

/**
 * Write detailed debug data to a file in the logs directory.
 * @param {string} prefix - Prefix for the filename (e.g., 'gemini-req')
 * @param {string} id - Unique ID for the log entry (e.g., request ID)
 * @param {Object|string} data - Data to log
 */
export function logDebugFile(prefix, id, data) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${prefix}-${timestamp}-${id}.json`;
        const filePath = path.join(LOGS_DIR, filename);

        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`[Logger] Saved debug log to logs/${filename}`);
    } catch (err) {
        console.error('[Logger] Failed to write log file:', err);
    }
}

/**
 * Log error to a persistent error log file
 * @param {string} context - Context of the error
 * @param {Error} error - The error object
 */
export function logError(context, error) {
    try {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${context}] ${error.stack || error.message}\n`;
        const filePath = path.join(LOGS_DIR, 'error.log');
        fs.appendFileSync(filePath, logEntry, 'utf8');
    } catch (err) {
        console.error('[Logger] Failed to write error log:', err);
    }
}
