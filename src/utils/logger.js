
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

/**
 * Log Claude tool usage request/response for debugging
 * @param {string} requestId - Unique request ID
 * @param {string} stage - Stage of the request ('incoming', 'google-request', 'google-response', 'outgoing')
 * @param {Object} data - Data to log
 * @param {string} model - Model name
 */
export function logToolUsage(requestId, stage, data, model = 'unknown') {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const modelFamily = model.toLowerCase().includes('claude') ? 'claude' : 
                           model.toLowerCase().includes('gemini') ? 'gemini' : 'unknown';
        const filename = `tool-usage-${modelFamily}-${stage}-${timestamp}-${requestId}.json`;
        const filePath = path.join(LOGS_DIR, filename);

        // Extract tool-related information for easier analysis
        const logData = {
            timestamp: new Date().toISOString(),
            requestId,
            stage,
            model,
            modelFamily,
            ...data
        };

        // Add tool call analysis for easier debugging
        if (stage === 'incoming' && data.messages) {
            const toolCalls = [];
            const toolResults = [];
            data.messages.forEach((msg, idx) => {
                if (Array.isArray(msg.content)) {
                    msg.content.forEach(block => {
                        if (block.type === 'tool_use') {
                            toolCalls.push({
                                messageIndex: idx,
                                role: msg.role,
                                toolId: block.id,
                                toolName: block.name,
                                input: block.input
                            });
                        } else if (block.type === 'tool_result') {
                            toolResults.push({
                                messageIndex: idx,
                                role: msg.role,
                                toolUseId: block.tool_use_id,
                                toolName: block.name,
                                contentPreview: typeof block.content === 'string' 
                                    ? block.content.substring(0, 200) 
                                    : JSON.stringify(block.content).substring(0, 200)
                            });
                        }
                    });
                }
            });
            logData.toolCalls = toolCalls;
            logData.toolResults = toolResults;
        }

        // Add tool definitions analysis
        if (data.tools && Array.isArray(data.tools)) {
            logData.toolDefinitions = data.tools.map(tool => ({
                name: tool.name || tool.function?.name,
                description: tool.description || tool.function?.description,
                schemaKeys: tool.input_schema || tool.function?.input_schema || tool.function?.parameters 
                    ? Object.keys(tool.input_schema || tool.function?.input_schema || tool.function?.parameters || {})
                    : []
            }));
        }

        // Add Google request analysis
        if (stage === 'google-request' && data.googleRequest) {
            const googleTools = data.googleRequest.tools?.[0]?.functionDeclarations || [];
            logData.googleTools = googleTools.map(tool => ({
                name: tool.name,
                description: tool.description?.substring(0, 100),
                parametersKeys: tool.parameters ? Object.keys(tool.parameters) : [],
                parametersType: tool.parameters?.type,
                hasRequired: Array.isArray(tool.parameters?.required),
                requiredFields: tool.parameters?.required || []
            }));

            // Analyze contents for functionCall/functionResponse
            const functionCalls = [];
            const functionResponses = [];
            data.googleRequest.contents?.forEach((content, idx) => {
                content.parts?.forEach(part => {
                    if (part.functionCall) {
                        functionCalls.push({
                            contentIndex: idx,
                            role: content.role,
                            name: part.functionCall.name,
                            id: part.functionCall.id,
                            argsKeys: part.functionCall.args ? Object.keys(part.functionCall.args) : [],
                            argsPreview: JSON.stringify(part.functionCall.args || {}).substring(0, 200)
                        });
                    } else if (part.functionResponse) {
                        functionResponses.push({
                            contentIndex: idx,
                            role: content.role,
                            name: part.functionResponse.name,
                            id: part.functionResponse.id,
                            responseKeys: part.functionResponse.response ? Object.keys(part.functionResponse.response) : [],
                            responsePreview: JSON.stringify(part.functionResponse.response || {}).substring(0, 200)
                        });
                    }
                });
            });
            logData.googleFunctionCalls = functionCalls;
            logData.googleFunctionResponses = functionResponses;
        }

        // Add Google response analysis
        if (stage === 'google-response' && data.googleResponse) {
            const response = data.googleResponse.response || data.googleResponse;
            const candidates = response.candidates || [];
            const parts = candidates[0]?.content?.parts || [];
            
            const functionCalls = [];
            parts.forEach(part => {
                if (part.functionCall) {
                    functionCalls.push({
                        name: part.functionCall.name,
                        id: part.functionCall.id,
                        argsKeys: part.functionCall.args ? Object.keys(part.functionCall.args) : [],
                        argsPreview: JSON.stringify(part.functionCall.args || {}).substring(0, 200)
                    });
                }
            });
            logData.googleResponseFunctionCalls = functionCalls;
        }

        // Add outgoing response analysis
        if (stage === 'outgoing' && data.anthropicResponse) {
            const content = data.anthropicResponse.content || [];
            const toolUses = content.filter(b => b.type === 'tool_use').map(b => ({
                id: b.id,
                name: b.name,
                inputKeys: b.input ? Object.keys(b.input) : [],
                inputPreview: JSON.stringify(b.input || {}).substring(0, 200)
            }));
            logData.outgoingToolUses = toolUses;
        }

        const content = JSON.stringify(logData, null, 2);
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`[Logger] Saved tool usage log: logs/${filename}`);
    } catch (err) {
        console.error('[Logger] Failed to write tool usage log:', err);
    }
}