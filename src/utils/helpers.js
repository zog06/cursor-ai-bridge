/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Estimate token count from text/JSON content
 * Uses approximate ratio: ~4 characters = 1 token (Claude tokenizer approximation)
 * @param {string|object} content - Text string or JSON object
 * @returns {number} Estimated token count
 */
export function estimateTokenCount(content) {
    if (content === null || content === undefined) return 0;
    
    let text;
    if (typeof content === 'string') {
        text = content;
    } else {
        // Convert object to JSON string
        text = JSON.stringify(content);
    }
    
    // Approximate: Claude tokenizer uses ~4 characters per token on average
    // This is a rough estimate, actual tokenization may vary
    return Math.ceil(text.length / 4);
}