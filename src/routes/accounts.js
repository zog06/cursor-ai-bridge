/**
 * Account Management Routes
 */

import { Router } from 'express';
import { getModelQuotas } from '../cloudcode-client.js';
import { formatDuration } from '../utils/helpers.js';
import { regenerateApiKey, setApiKey } from '../services/api-key.js';
import { forceRefresh } from '../token-extractor.js';

export function createAccountsRouter(accountManager, ensureInitialized) {
    const router = Router();

    /**
     * Account limits endpoint - fetch quota/limits for all accounts × all models
     */
    router.get(['/account-limits', '/api/account-limits'], async (req, res) => {
        try {
            await ensureInitialized();
            const allAccounts = accountManager.getAllAccounts();
            const format = req.query.format || 'json';

            // Fetch quotas for each account in parallel
            const results = await Promise.allSettled(
                allAccounts.map(async (account) => {
                    // Skip invalid accounts
                    if (account.isInvalid) {
                        return {
                            email: account.email,
                            status: 'invalid',
                            error: account.invalidReason,
                            isDisabled: account.isDisabled,
                            models: {}
                        };
                    }

                    try {
                        const token = await accountManager.getTokenForAccount(account);
                        const quotas = await getModelQuotas(token);

                        return {
                            email: account.email,
                            status: 'ok',
                            isDisabled: account.isDisabled,
                            models: quotas
                        };
                    } catch (error) {
                        return {
                            email: account.email,
                            status: 'error',
                            error: error.message,
                            isDisabled: account.isDisabled,
                            models: {}
                        };
                    }
                })
            );

            // Process results
            const accountLimits = results.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        email: allAccounts[index].email,
                        status: 'error',
                        error: result.reason?.message || 'Unknown error',
                        isDisabled: allAccounts[index].isDisabled,
                        models: {}
                    };
                }
            });

            // Collect all unique model IDs
            const allModelIds = new Set();
            for (const account of accountLimits) {
                for (const modelId of Object.keys(account.models || {})) {
                    allModelIds.add(modelId);
                }
            }

            const sortedModels = Array.from(allModelIds).sort();

            // Return ASCII table format
            if (format === 'table') {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');

                // Build table
                const lines = [];
                const timestamp = new Date().toLocaleString();
                lines.push(`Account Limits (${timestamp})`);

                // Get account status info
                const status = accountManager.getStatus();
                lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid, ${status.disabled} disabled`);
                lines.push('');

                // Table 1: Account status
                const accColWidth = 25;
                const statusColWidth = 15;
                const lastUsedColWidth = 25;
                const resetColWidth = 25;

                let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
                lines.push(accHeader);
                lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

                for (const acc of status.accounts) {
                    const shortEmail = acc.email.split('@')[0].slice(0, 22);
                    const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';

                    // Get status and error from accountLimits
                    const accLimit = accountLimits.find(a => a.email === acc.email);
                    let accStatus;
                    if (acc.isInvalid) {
                        accStatus = 'invalid';
                    } else if (acc.isDisabled) {
                        accStatus = 'disabled';
                    } else if (acc.isRateLimited) {
                        const remaining = acc.rateLimitResetTime ? acc.rateLimitResetTime - Date.now() : 0;
                        accStatus = remaining > 0 ? `limited (${formatDuration(remaining)})` : 'rate-limited';
                    } else {
                        accStatus = accLimit?.status || 'ok';
                    }

                    // Get reset time from quota API
                    const claudeModel = sortedModels.find(m => m.includes('claude'));
                    const quota = claudeModel && accLimit?.models?.[claudeModel];
                    const resetTime = quota?.resetTime
                        ? new Date(quota.resetTime).toLocaleString()
                        : '-';

                    let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

                    // Add error on next line if present
                    if (accLimit?.error) {
                        lines.push(row);
                        lines.push('  └─ ' + accLimit.error);
                    } else {
                        lines.push(row);
                    }
                }
                lines.push('');

                // Calculate column widths
                const modelColWidth = Math.max(25, ...sortedModels.map(m => m.length)) + 2;
                const accountColWidth = 22;

                // Header row
                let header = 'Model'.padEnd(modelColWidth);
                for (const acc of accountLimits) {
                    const shortEmail = acc.email.split('@')[0].slice(0, 18);
                    header += shortEmail.padEnd(accountColWidth);
                }
                lines.push(header);
                lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

                // Data rows
                for (const modelId of sortedModels) {
                    let row = modelId.padEnd(modelColWidth);
                    for (const acc of accountLimits) {
                        const quota = acc.models?.[modelId];
                        let cell;
                        if (acc.status !== 'ok') {
                            cell = `[${acc.status}]`;
                        } else if (!quota) {
                            cell = '-';
                        } else if (quota.remainingFraction === null) {
                            cell = '0% (exhausted)';
                        } else {
                            const pct = Math.round(quota.remainingFraction * 100);
                            cell = `${pct}%`;
                        }
                        row += cell.padEnd(accountColWidth);
                    }
                    lines.push(row);
                }

                return res.send(lines.join('\n'));
            }

            // Default: JSON format
            res.json({
                timestamp: new Date().toLocaleString(),
                totalAccounts: allAccounts.length,
                models: sortedModels,
                accounts: accountLimits.map(acc => ({
                    email: acc.email,
                    status: acc.status,
                    isDisabled: acc.isDisabled || false,
                    error: acc.error || null,
                    limits: Object.fromEntries(
                        sortedModels.map(modelId => {
                            const quota = acc.models?.[modelId];
                            if (!quota) {
                                return [modelId, null];
                            }
                            return [modelId, {
                                remaining: quota.remainingFraction !== null
                                    ? `${Math.round(quota.remainingFraction * 100)}%`
                                    : 'N/A',
                                remainingFraction: quota.remainingFraction,
                                resetTime: quota.resetTime || null
                            }];
                        })
                    )
                }))
            });
        } catch (error) {
            res.status(500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    /**
     * Force token refresh endpoint
     */
    router.post('/refresh-token', async (req, res) => {
        try {
            await ensureInitialized();
            // Clear all caches
            accountManager.clearTokenCache();
            accountManager.clearProjectCache();
            // Force refresh default token
            const token = await forceRefresh();
            res.json({
                status: 'ok',
                message: 'Token caches cleared and refreshed',
                tokenPrefix: token.substring(0, 10) + '...'
            });
        } catch (error) {
            res.status(500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    /**
     * Toggle account disabled status
     */
    router.post('/api/accounts/toggle', async (req, res) => {
        try {
            await ensureInitialized();
            const { email, disabled } = req.body;

            if (!email) {
                return res.status(400).json({ status: 'error', message: 'Email is required' });
            }

            const success = accountManager.toggleAccount(email, disabled);
            if (success) {
                res.json({ status: 'ok', message: `Account ${email} ${disabled ? 'disabled' : 'enabled'}` });
            } else {
                res.status(404).json({ status: 'error', message: 'Account not found' });
            }
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * Regenerate API key endpoint
     */
    router.post('/api/regenerate-api-key', (req, res) => {
        try {
            const newKey = regenerateApiKey();

            res.json({
                status: 'success',
                message: 'API key regenerated successfully',
                apiKey: newKey
            });
        } catch (error) {
            res.status(500).json({
                status: 'error',
                message: error.message
            });
        }
    });

    return router;
}
