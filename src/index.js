/**
 * Antigravity Claude Proxy
 * Entry point - starts the proxy server
 */

import app from './server.js';
import { DEFAULT_PORT } from './constants.js';
import { startNgrok, setupGracefulShutdown } from './ngrok-manager.js';

const PORT = process.env.PORT || DEFAULT_PORT;
// Auto-start ngrok if START_NGROK env var is set, or if --ngrok flag is passed
const START_NGROK = process.env.START_NGROK === 'true' || 
                     process.env.START_NGROK === '1' ||
                     process.argv.includes('--ngrok');

// Setup graceful shutdown for ngrok
setupGracefulShutdown();

app.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║              Cursor AI Bridge Server                         ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Server running at: http://localhost:${PORT}                   ║
║                                                              ║
║  Endpoints:                                                  ║
║    POST /v1/messages      - Anthropic Messages API            ║
║    POST /chat/completions - OpenAI Chat Completions API       ║
║    GET  /v1/models        - List available models             ║
║    GET  /health           - Health check                      ║
║    GET  /account-limits   - Account status & quotas          ║
║    POST /refresh-token    - Force token refresh               ║
║                                                              ║
║  Usage with Cursor IDE:                                      ║
║    Use ngrok URL as Base URL in Cursor settings              ║
║    API Key is shown above when server starts                 ║
║                                                              ║
║  Note: Set CURSOR_AI_BRIDGE_API_KEY env var for custom key. ║
║                                                              ║
║  Add Google accounts:                                        ║
║    npm run accounts                                          ║
║                                                              ║
║  Prerequisites (if no accounts configured):                  ║
║    - Antigravity must be running                             ║
║    - Have a chat panel open in Antigravity                   ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);

    // Start ngrok if enabled
    if (START_NGROK) {
        await startNgrok(PORT);
    } else {
        console.log('[ngrok] ngrok auto-start disabled. Set START_NGROK=true to enable.');
    }
});
