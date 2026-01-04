/**
 * Reproduction Script for "Invalid Tool Use" Error
 * 
 * Simulates the full cycle of:
 * 1. Defining a tool
 * 2. Receiving a tool call from the model
 * 3. Sending a tool result back to the model
 * 
 * This helps identify where ID mapping or format conversion breaks.
 */

import { convertAnthropicToGoogle } from '../src/format/request-converter.js';
import { convertContentToParts } from '../src/format/content-converter.js';

// Mock data
const TOOL_NAME = 'get_weather';
const TOOL_ID = 'call_123456789';
const TOOL_DEFINITION = {
    name: TOOL_NAME,
    description: 'Get current weather',
    input_schema: {
        type: 'object',
        properties: {
            location: { type: 'string' }
        },
        required: ['location']
    }
};

async function runTest() {
    console.log('--- Starting Tool Use Reproduction Test ---\n');

    // Step 1: Simulate History with Assistant Tool Call
    console.log('Step 1: Simulating conversation history with a tool call...');
    
    // This represents what Cursor sends when it's replying with a tool result.
    // It includes the previous turn where the assistant called the tool.
    const messages = [
        {
            role: 'user',
            content: 'What is the weather in Istanbul?'
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: 'I will check the weather for Istanbul.'
                },
                {
                    type: 'tool_use',
                    id: TOOL_ID,
                    name: TOOL_NAME,
                    input: { location: 'Istanbul' }
                }
            ]
        },
        {
            role: 'user', // Cursor mimics tool results as user messages in Anthropic format (?) 
                          // Wait, Anthropic format uses 'user' role with 'tool_result' blocks.
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: TOOL_ID,
                    content: 'Weather in Istanbul is Sunny, 25C',
                    // Note: Cursor might NOT be sending 'name' here, relying on ID.
                    // If we uncomment the next line, it works easily. The bug is likely when it's missing.
                    // name: TOOL_NAME 
                }
            ]
        }
    ];

    const request = {
        model: 'claude-sonnet-4-5-thinking',
        messages: messages,
        tools: [TOOL_DEFINITION]
    };

    console.log(`Request Messages Structure:`);
    console.log(JSON.stringify(messages, null, 2));

    try {
        console.log('\nStep 2: Converting Anthropic Request to Google Format...');
        const { googleRequest } = convertAnthropicToGoogle(request);
        
        console.log('\n--- Conversion Result ---');
        
        // Inspect the last message (User with tool result)
        const lastContent = googleRequest.contents[googleRequest.contents.length - 1];
        console.log('Last Content Part (Tool Result):', JSON.stringify(lastContent, null, 2));

        // Check verification logic
        const parts = lastContent.parts;
        const functionResponsePart = parts.find(p => p.functionResponse);

        if (!functionResponsePart) {
            console.error('\n[FAIL] No functionResponse part found! conversion failed to map tool_result.');
            console.log('Possible reason: Mapping from ID to Name failed.');
        } else {
            const mappedName = functionResponsePart.functionResponse.name;
            console.log(`\n[SUCCESS] Found functionResponse. Mapped Name: "${mappedName}"`);
            
            if (mappedName === TOOL_NAME) {
                console.log('[PASS] Tool name correctly mapped from ID.');
            } else {
                console.error(`[FAIL] Mapped name mismatch! Expected: ${TOOL_NAME}, Got: ${mappedName}`);
            }
        }

    } catch (error) {
        console.error('\n[ERROR] Exception during conversion:', error);
    }
}

runTest();
