/**
 * ngrok Manager
 * Automatically starts and manages ngrok tunnel for the proxy server
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

let ngrokProcess = null;
let ngrokUrl = null;

/**
 * Check if ngrok is installed and available
 */
async function isNgrokAvailable() {
    try {
        // Try 'ngrok' first, then 'ngrok.exe' on Windows
        const isWindows = process.platform === 'win32';
        const command = isWindows ? 'ngrok.exe version' : 'ngrok version';
        await execAsync(command);
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Get ngrok public URL from ngrok API
 */
async function getNgrokUrl() {
    try {
        const response = await fetch('http://localhost:4040/api/tunnels', {
            signal: AbortSignal.timeout(3000)
        });
        if (response.ok) {
            const data = await response.json();
            if (data.tunnels && data.tunnels.length > 0) {
                // Prefer HTTPS tunnel
                const httpsTunnel = data.tunnels.find(t => t.public_url.startsWith('https://'));
                return httpsTunnel?.public_url || data.tunnels[0].public_url;
            }
        }
    } catch (error) {
        // ngrok API not available yet or error
    }
    return null;
}

/**
 * Start ngrok tunnel
 * @param {number} port - Port to tunnel (default: 8080)
 * @returns {Promise<string|null>} Public URL or null if failed
 */
export async function startNgrok(port = 8080) {
    // Check if ngrok is available
    const available = await isNgrokAvailable();
    if (!available) {
        console.log('[ngrok] ngrok not found in PATH. Skipping ngrok tunnel.');
        console.log('[ngrok] To use ngrok, install it from https://ngrok.com/download');
        return null;
    }

    // Check if ngrok is already running
    try {
        const existingUrl = await getNgrokUrl();
        if (existingUrl) {
            console.log(`[ngrok] ngrok already running: ${existingUrl}`);
            ngrokUrl = existingUrl;
            return existingUrl;
        }
    } catch (error) {
        // ngrok not running, continue to start it
    }

    console.log(`[ngrok] Starting ngrok tunnel for port ${port}...`);

    // Start ngrok process
    // --host-header=rewrite bypasses ngrok browser warning
    const isWindows = process.platform === 'win32';
    const ngrokCommand = isWindows ? 'ngrok.exe' : 'ngrok';
    
    ngrokProcess = spawn(ngrokCommand, ['http', port.toString(), '--host-header=rewrite'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWindows, // Use shell on Windows for PATH resolution
        windowsVerbatimArguments: false
    });

    // Handle ngrok output
    ngrokProcess.stdout.on('data', (data) => {
        const output = data.toString();
        // ngrok outputs connection info to stderr, we'll check API instead
    });

    ngrokProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // ngrok outputs connection info to stderr
        if (output.includes('started tunnel') || output.includes('Forwarding')) {
            // ngrok started, wait a bit then get URL
            setTimeout(async () => {
                const url = await getNgrokUrl();
                if (url) {
                    ngrokUrl = url;
                    console.log(`[ngrok] ✅ Tunnel active: ${url}`);
                }
            }, 2000);
        }
    });

    ngrokProcess.on('error', (error) => {
        console.error('[ngrok] Failed to start ngrok:', error.message);
        ngrokProcess = null;
    });

    ngrokProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            console.log(`[ngrok] ngrok exited with code ${code}`);
        }
        ngrokProcess = null;
        ngrokUrl = null;
    });

    // Wait a bit for ngrok to start, then get URL
    await new Promise(resolve => setTimeout(resolve, 3000));
    const url = await getNgrokUrl();
    
    if (url) {
        ngrokUrl = url;
        console.log(`[ngrok] ✅ Tunnel active: ${url}`);
        return url;
    } else {
        console.log('[ngrok] ⚠️  ngrok started but URL not available yet. Check http://localhost:4040');
        return null;
    }
}

/**
 * Stop ngrok tunnel
 */
export function stopNgrok() {
    if (ngrokProcess) {
        console.log('[ngrok] Stopping ngrok tunnel...');
        ngrokProcess.kill('SIGTERM');
        ngrokProcess = null;
        ngrokUrl = null;
    }
}

/**
 * Get current ngrok URL
 */
export function getCurrentNgrokUrl() {
    return ngrokUrl;
}

/**
 * Setup graceful shutdown
 */
export function setupGracefulShutdown() {
    const shutdown = () => {
        stopNgrok();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
