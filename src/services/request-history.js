/**
 * Request History Service
 * Tracks recent API requests for dashboard monitoring
 */

const MAX_REQUEST_HISTORY = 100;
const requestHistory = [];

/**
 * Add a request to the history
 */
export function addRequestToHistory(request) {
    requestHistory.unshift(request);
    if (requestHistory.length > MAX_REQUEST_HISTORY) {
        requestHistory.pop();
    }
}

/**
 * Get request history
 */
export function getRequestHistory(limit = 50) {
    return requestHistory.slice(0, limit);
}

/**
 * Clear request history
 */
export function clearRequestHistory() {
    requestHistory.length = 0;
}
