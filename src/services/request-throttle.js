/**
 * Request Throttle Service
 * Prevents rate limiting by enforcing delays between consecutive requests
 */

// Default delay between requests (in milliseconds)
const DEFAULT_THROTTLE_DELAY = 3000; // 3 seconds

// Track last request time per model
const lastRequestTime = new Map();

// Pending request queues per model
const requestQueues = new Map();

// Processing flags per model
const isProcessing = new Map();

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get throttle delay based on model
 * Claude models get longer delays, Gemini models get shorter
 * @param {string} model - Model name
 * @returns {number} Throttle delay in milliseconds
 */
function getThrottleDelay(model) {
    const modelLower = (model || '').toLowerCase();

    // Claude models - stricter throttling
    if (modelLower.includes('claude')) {
        return 3000; // 3 seconds
    }

    // Gemini models - moderate throttling
    if (modelLower.includes('gemini')) {
        return 1500; // 1.5 seconds
    }

    // Default
    return DEFAULT_THROTTLE_DELAY;
}

/**
 * Wait for throttle if needed
 * This ensures there's a minimum delay between requests for the same model
 * 
 * @param {string} model - Model name
 * @returns {Promise<void>}
 */
export async function waitForThrottle(model) {
    const throttleDelay = getThrottleDelay(model);
    const modelKey = model || 'default';
    const now = Date.now();
    const lastTime = lastRequestTime.get(modelKey) || 0;
    const elapsed = now - lastTime;

    if (elapsed < throttleDelay) {
        const waitTime = throttleDelay - elapsed;
        console.log(`[Throttle] Waiting ${waitTime}ms before next ${model} request...`);
        await sleep(waitTime);
    }

    // Update last request time
    lastRequestTime.set(modelKey, Date.now());
}

/**
 * Execute a request with throttling
 * Queues requests and processes them with delays to prevent rate limiting
 * 
 * @param {string} model - Model name
 * @param {Function} requestFn - Async function to execute
 * @returns {Promise<any>} Result of the request function
 */
export async function throttledRequest(model, requestFn) {
    const modelKey = model || 'default';

    // Create a promise that will be resolved when the request completes
    return new Promise((resolve, reject) => {
        // Initialize queue for this model if needed
        if (!requestQueues.has(modelKey)) {
            requestQueues.set(modelKey, []);
        }

        // Add request to queue
        requestQueues.get(modelKey).push({ requestFn, resolve, reject });

        // Start processing if not already processing
        if (!isProcessing.get(modelKey)) {
            processQueue(modelKey);
        }
    });
}

/**
 * Process the request queue for a model
 * @param {string} modelKey - Model key
 */
async function processQueue(modelKey) {
    if (isProcessing.get(modelKey)) return;

    isProcessing.set(modelKey, true);

    const queue = requestQueues.get(modelKey);

    while (queue && queue.length > 0) {
        const { requestFn, resolve, reject } = queue.shift();

        try {
            // Wait for throttle delay
            await waitForThrottle(modelKey);

            // Execute the request
            const result = await requestFn();
            resolve(result);
        } catch (error) {
            reject(error);
        }
    }

    isProcessing.set(modelKey, false);
}

/**
 * Get current throttle status
 * @returns {Object} Status object with queue lengths and last request times
 */
export function getThrottleStatus() {
    const status = {
        queues: {},
        lastRequestTimes: {}
    };

    for (const [model, queue] of requestQueues.entries()) {
        status.queues[model] = queue.length;
    }

    for (const [model, time] of lastRequestTime.entries()) {
        status.lastRequestTimes[model] = {
            timestamp: new Date(time).toISOString(),
            secondsAgo: Math.round((Date.now() - time) / 1000)
        };
    }

    return status;
}

/**
 * Clear throttle state (useful for testing)
 */
export function clearThrottleState() {
    lastRequestTime.clear();
    requestQueues.clear();
    isProcessing.clear();
}
