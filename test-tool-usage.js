/**
 * Test script to verify tool usage handling for Claude models
 * This tests if multiple tools are properly sent and received
 */

import fetch from 'node-fetch';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const MODEL = process.env.MODEL || 'claude-3-5-sonnet-20241022';

// Test with multiple tools
const testRequest = {
    model: MODEL,
    messages: [
        {
            role: 'user',
            content: 'Please use the read_file tool to read a file, and use the list_dir tool to list a directory.'
        }
    ],
    tools: [
        {
            name: 'read_file',
            description: 'Reads the contents of a file',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The path to the file to read'
                    }
                },
                required: ['path']
            }
        },
        {
            name: 'list_dir',
            description: 'Lists the contents of a directory',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The path to the directory to list'
                    }
                },
                required: ['path']
            }
        },
        {
            name: 'write_file',
            description: 'Writes content to a file',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The path to the file to write'
                    },
                    content: {
                        type: 'string',
                        description: 'The content to write to the file'
                    }
                },
                required: ['path', 'content']
            }
        }
    ],
    max_tokens: 4096
};

console.log('Testing tool usage with multiple tools...');
console.log(`API URL: ${API_URL}`);
console.log(`Model: ${MODEL}`);
console.log(`Number of tools: ${testRequest.tools.length}`);
console.log(`Tool names: [${testRequest.tools.map(t => t.name).join(', ')}]`);
console.log('\nSending request...\n');

try {
    const response = await fetch(`${API_URL}/v1/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(testRequest)
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('Error response:', errorText);
        process.exit(1);
    }

    const data = await response.json();
    
    console.log('\n=== RESPONSE ANALYSIS ===');
    console.log(`Stop reason: ${data.stop_reason}`);
    console.log(`Content blocks: ${data.content?.length || 0}`);
    
    if (data.content && Array.isArray(data.content)) {
        const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
        console.log(`Tool use blocks: ${toolUseBlocks.length}`);
        
        if (toolUseBlocks.length > 0) {
            console.log('\nTool usage details:');
            toolUseBlocks.forEach((block, idx) => {
                console.log(`  [${idx + 1}] Tool: ${block.name}, ID: ${block.id}`);
                console.log(`      Args keys: [${Object.keys(block.input || {}).join(', ')}]`);
            });
        } else {
            console.log('\n⚠️  WARNING: No tool_use blocks found in response!');
        }
    }
    
    console.log('\n=== FULL RESPONSE ===');
    console.log(JSON.stringify(data, null, 2));
    
} catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
}

